// Responsibility: stream a V8 heap snapshot into bounded strings and pre-sized typed arrays.
// Boundary: this module validates the file format but does not compute dominators or reports.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { ProfileShapeError } from "./detect.js";

export interface HeapSnapshotMeta {
  node_fields: string[];
  node_types: unknown[];
  edge_fields: string[];
  edge_types: unknown[];
  location_fields?: string[];
}

export interface ParsedHeapSnapshot {
  meta: HeapSnapshotMeta;
  nodeCount: number;
  edgeCount: number;
  nodes: Uint32Array;
  edges: Uint32Array;
  locations: Uint32Array;
  strings: string[];
  fileSize: number;
}

class ChunkReader {
  readonly fd: number;
  readonly fileSize: number;
  readonly buffer: Buffer;
  private bufferStart = 0;
  private bufferLength = 0;

  constructor(path: string, chunkSize: number) {
    this.fd = openSync(path, "r");
    this.fileSize = fstatSync(this.fd).size;
    this.buffer = Buffer.allocUnsafe(Math.max(16, chunkSize));
  }

  close(): void {
    closeSync(this.fd);
  }

  fill(at: number): void {
    this.bufferStart = at;
    this.bufferLength = readSync(this.fd, this.buffer, 0, this.buffer.length, at);
  }

  byteAt(position: number): number | undefined {
    if (position < this.bufferStart || position >= this.bufferStart + this.bufferLength) this.fill(position);
    if (this.bufferLength === 0) return undefined;
    return this.buffer[position - this.bufferStart];
  }

  find(start: number, marker: string): number {
    const needle = Buffer.from(marker);
    let at = start;
    while (at < this.fileSize) {
      this.fill(at);
      if (this.bufferLength === 0) break;
      const local = this.buffer.indexOf(needle, 0);
      if (local >= 0) return at + local;
      if (this.bufferLength < this.buffer.length) break;
      at += this.bufferLength - needle.length + 1;
    }
    return -1;
  }

  text(start: number, end: number): string {
    const length = end - start;
    const out = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(this.fd, out, offset, length - offset, start + offset);
      if (read === 0) throw new ProfileShapeError("heap snapshot ended while reading its header");
      offset += read;
    }
    return out.toString("utf8");
  }
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProfileShapeError(message);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ProfileShapeError(`heap snapshot meta.${name} is not a string array`);
  }
  return value;
}

function parseHeader(reader: ChunkReader, nodesAt: number): { meta: HeapSnapshotMeta; nodeCount: number; edgeCount: number } {
  const raw = `${reader.text(0, nodesAt).replace(/,\s*$/, "")}}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProfileShapeError("heap snapshot header is not valid JSON");
  }
  const snapshot = asRecord(asRecord(parsed, "heap snapshot is not an object")["snapshot"], "heap snapshot has no snapshot header");
  const metaRecord = asRecord(snapshot["meta"], "heap snapshot has no meta header");
  const nodeCount = snapshot["node_count"];
  const edgeCount = snapshot["edge_count"];
  if (!Number.isSafeInteger(nodeCount) || (nodeCount as number) < 1) throw new ProfileShapeError("heap snapshot node_count is invalid");
  if (!Number.isSafeInteger(edgeCount) || (edgeCount as number) < 0) throw new ProfileShapeError("heap snapshot edge_count is invalid");
  return {
    meta: {
      node_fields: stringArray(metaRecord["node_fields"], "node_fields"),
      node_types: Array.isArray(metaRecord["node_types"]) ? metaRecord["node_types"] : [],
      edge_fields: stringArray(metaRecord["edge_fields"], "edge_fields"),
      edge_types: Array.isArray(metaRecord["edge_types"]) ? metaRecord["edge_types"] : [],
      location_fields: metaRecord["location_fields"] === undefined ? undefined : stringArray(metaRecord["location_fields"], "location_fields"),
    },
    nodeCount: nodeCount as number,
    edgeCount: edgeCount as number,
  };
}

function scanIntegers(reader: ChunkReader, start: number, output?: Uint32Array): { count: number; end: number } {
  let position = start;
  let count = 0;
  let current = 0;
  let inNumber = false;
  for (;;) {
    const byte = reader.byteAt(position);
    if (byte === undefined) throw new ProfileShapeError("heap snapshot ended inside a numeric array");
    if (byte >= 48 && byte <= 57) {
      current = current * 10 + byte - 48;
      if (!Number.isSafeInteger(current) || current > 0xffffffff) throw new ProfileShapeError("heap snapshot integer exceeds uint32");
      inNumber = true;
    } else {
      if (inNumber) {
        if (output !== undefined) {
          if (count >= output.length) throw new ProfileShapeError("heap snapshot numeric array is longer than its header count");
          output[count] = current;
        }
        count++;
        current = 0;
        inNumber = false;
      }
      if (byte === 93) return { count, end: position + 1 };
    }
    position++;
  }
}

function parseStrings(reader: ChunkReader, start: number): string[] {
  const result: string[] = [];
  let position = start;
  const maxDecodedLength = 200;
  for (;;) {
    let byte = reader.byteAt(position);
    while (byte === 9 || byte === 10 || byte === 13 || byte === 32 || byte === 44) {
      position++;
      byte = reader.byteAt(position);
    }
    if (byte === 93) return result;
    if (byte !== 34) throw new ProfileShapeError(`heap snapshot string table has an invalid entry at byte ${position}`);
    position++;
    const rawStart = position;
    let rawLength = 0;
    let hash = 0x811c9dc5;
    let escaped = false;
    for (;;) {
      byte = reader.byteAt(position);
      if (byte === undefined) throw new ProfileShapeError("heap snapshot ended inside a string");
      if (byte === 34 && !escaped) break;
      rawLength++;
      hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      position++;
    }
    position++;
    const decoded = rawLength <= 2048 ? decodeJsonString(reader.text(rawStart, position - 1)) : undefined;
    const placeholder = `<long:${rawLength}:${hash.toString(16).padStart(8, "0")}>`;
    result.push(decoded !== undefined && decoded.length <= maxDecodedLength ? decoded : placeholder);
  }
}

function decodeJsonString(raw: string): string | undefined {
  let result = "";
  let plainStart = 0;
  const flush = (end: number): void => { result += raw.slice(plainStart, end); };
  for (let at = 0; at < raw.length; at++) {
    if (raw.charCodeAt(at) !== 92) continue;
    flush(at);
    const escaped = raw[++at];
    if (escaped === undefined) return undefined;
    const simple: Record<string, string> = { '"': '"', "/": "/", "\\": "\\", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    if (escaped === "u") {
      if (at + 4 >= raw.length) return undefined;
      const hex = raw.slice(at + 1, at + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
      result += String.fromCharCode(Number.parseInt(hex, 16));
      at += 4;
    } else if (simple[escaped] !== undefined) {
      result += simple[escaped];
    } else {
      return undefined;
    }
    plainStart = at + 1;
  }
  flush(raw.length);
  return result;
}

export function parseHeapSnapshot(path: string, chunkSize = 4 * 1024 * 1024): ParsedHeapSnapshot {
  const reader = new ChunkReader(path, chunkSize);
  try {
    const nodesMarker = '"nodes":[';
    const nodesAt = reader.find(0, nodesMarker);
    if (nodesAt < 0) throw new ProfileShapeError("heap snapshot has no nodes array");
    const { meta, nodeCount, edgeCount } = parseHeader(reader, nodesAt);
    const nodeValues = nodeCount * meta.node_fields.length;
    const edgeValues = edgeCount * meta.edge_fields.length;
    if (!Number.isSafeInteger(nodeValues) || !Number.isSafeInteger(edgeValues)) throw new ProfileShapeError("heap snapshot arrays are too large");

    const nodes = new Uint32Array(nodeValues);
    const parsedNodes = scanIntegers(reader, nodesAt + nodesMarker.length, nodes);
    if (parsedNodes.count !== nodes.length) throw new ProfileShapeError(`heap snapshot nodes count ${parsedNodes.count} does not match ${nodes.length}`);

    const edgesMarker = '"edges":[';
    const edgesAt = reader.find(parsedNodes.end, edgesMarker);
    if (edgesAt < 0) throw new ProfileShapeError("heap snapshot has no edges array");
    const edges = new Uint32Array(edgeValues);
    const parsedEdges = scanIntegers(reader, edgesAt + edgesMarker.length, edges);
    if (parsedEdges.count !== edges.length) throw new ProfileShapeError(`heap snapshot edges count ${parsedEdges.count} does not match ${edges.length}`);
    const targetOffset = meta.edge_fields.indexOf("to_node");
    if (targetOffset < 0) throw new ProfileShapeError("heap snapshot field to_node is missing");
    for (let at = targetOffset; at < edges.length; at += meta.edge_fields.length) {
      if (edges[at]! % meta.node_fields.length !== 0) throw new ProfileShapeError(`heap snapshot edge target ${edges[at]} is not aligned to a node`);
    }

    const stringsMarker = '"strings":[';
    const stringsAt = reader.find(parsedEdges.end, stringsMarker);
    if (stringsAt < 0) throw new ProfileShapeError("heap snapshot has no strings array");
    const strings = parseStrings(reader, stringsAt + stringsMarker.length);

    const locationsMarker = '"locations":[';
    const locationsAt = reader.find(parsedEdges.end, locationsMarker);
    let locations = new Uint32Array(0);
    if (locationsAt >= 0 && locationsAt < stringsAt) {
      const counted = scanIntegers(reader, locationsAt + locationsMarker.length);
      locations = new Uint32Array(counted.count);
      scanIntegers(reader, locationsAt + locationsMarker.length, locations);
      const width = meta.location_fields?.length ?? 0;
      if (width === 0 || locations.length % width !== 0) throw new ProfileShapeError("heap snapshot locations array does not match location_fields");
    }

    return { meta, nodeCount, edgeCount, nodes, edges, locations, strings, fileSize: reader.fileSize };
  } finally {
    reader.close();
  }
}
