// Responsibility: map a (url, line, column) from a profile into the original source position,
// via a zero-dependency source map v3 VLQ decoder. Reused across every frame that shares a
// script, so the map is parsed once per url, not once per frame.
// Boundary: does not touch `sections` (index maps) - v0 only needs the single-map case a
// TypeScript build produces. A lookup that fails for any reason (no map, unreadable file, url
// that is not a local file) returns undefined; the caller keeps the unmapped position rather than
// treating a missing map as an error.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

export interface SourcePosition {
  /** A file:// source is already converted to a local path; a source with any other scheme
   *  (webpack://, ...) is left exactly as the map wrote it - see decodeMap's own comment. */
  source: string;
  /** 0-based, matching the generated position convention used throughout this module. */
  line: number;
  column: number;
  name: string | undefined;
}

interface Segment {
  generatedColumn: number;
  sourceIndex: number | undefined;
  sourceLine: number | undefined;
  sourceColumn: number | undefined;
  nameIndex: number | undefined;
}

interface DecodedMap {
  /** Same length as the raw map's own `sources` - a non-string entry (null is common and legal)
   *  becomes `undefined` in place, not removed, so every later index still lines up with the
   *  segments that reference it by position. */
  sources: (string | undefined)[];
  names: (string | undefined)[];
  /** One entry per generated line, each sorted by generatedColumn. */
  lines: Segment[][];
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUE = new Map<string, number>([...BASE64_ALPHABET].map((c, i) => [c, i]));

/** Decodes one VLQ value starting at `start`; returns the value and the index right after it. */
function decodeVlq(segment: string, start: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let i = start;
  let more = true;
  while (more) {
    const char = segment[i];
    if (char === undefined) throw new Error("truncated VLQ segment");
    const digit = BASE64_VALUE.get(char);
    if (digit === undefined) throw new Error(`invalid base64 VLQ digit: ${char}`);
    i++;
    more = (digit & 0x20) !== 0;
    result += (digit & 0x1f) << shift;
    shift += 5;
  }
  const negative = (result & 1) === 1;
  result >>>= 1;
  return { value: negative ? -result : result, next: i };
}

export function decodeMappings(mappings: string): Segment[][] {
  const lines = mappings.split(";");
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let nameIndex = 0;
  const result: Segment[][] = [];

  for (const lineStr of lines) {
    let generatedColumn = 0;
    const segments: Segment[] = [];
    if (lineStr.length > 0) {
      for (const segStr of lineStr.split(",")) {
        if (segStr.length === 0) continue;
        let pos = 0;
        const gc = decodeVlq(segStr, pos);
        generatedColumn += gc.value;
        pos = gc.next;

        if (pos >= segStr.length) {
          segments.push({ generatedColumn, sourceIndex: undefined, sourceLine: undefined, sourceColumn: undefined, nameIndex: undefined });
          continue;
        }

        const si = decodeVlq(segStr, pos);
        sourceIndex += si.value;
        pos = si.next;
        const sl = decodeVlq(segStr, pos);
        sourceLine += sl.value;
        pos = sl.next;
        const sc = decodeVlq(segStr, pos);
        sourceColumn += sc.value;
        pos = sc.next;

        let name: number | undefined;
        if (pos < segStr.length) {
          const ni = decodeVlq(segStr, pos);
          nameIndex += ni.value;
          pos = ni.next;
          name = nameIndex;
        }

        segments.push({ generatedColumn, sourceIndex, sourceLine, sourceColumn, nameIndex: name });
      }
    }
    segments.sort((a, b) => a.generatedColumn - b.generatedColumn);
    result.push(segments);
  }
  return result;
}

interface RawSourceMap {
  version?: unknown;
  sources?: unknown;
  sourceRoot?: unknown;
  names?: unknown;
  mappings?: unknown;
}

/** True for a string with a URL scheme (`webpack://...`, `file://...`, ...), not a plain path. */
function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

/**
 * `sources` entries are relative to `sourceRoot` (if any) and, ultimately, to the map's OWN
 * location - `baseDir` is the map file's directory for a real `.map` file, or the generated
 * script's directory for an inline `data:` map (there is no separate map file to be relative to).
 * It used to be the generated SCRIPT's directory unconditionally, which only happened to agree
 * with the map's own directory when both sat at the same depth - a real map living in a sibling
 * "maps/" directory next to a sibling "out/" directory resolved every relative source one level
 * short.
 *
 * A source that is itself a URL is never touched by resolve()/relative() here: a `file://` one is
 * converted to a local path (so it becomes comparable to every other real path in model.ts); any
 * other scheme (`webpack://...`) is kept exactly as written - model.ts decides its area from the
 * URL text itself, without ever passing a URL through relative().
 */
function decodeMap(raw: RawSourceMap, baseDir: string): DecodedMap {
  const sourceRoot = typeof raw.sourceRoot === "string" ? raw.sourceRoot : "";
  const rawSources = Array.isArray(raw.sources) ? raw.sources : [];
  const sources: (string | undefined)[] = rawSources.map((s) => {
    if (typeof s !== "string") return undefined;
    const joined = sourceRoot ? `${sourceRoot.replace(/\/$/, "")}/${s}` : s;
    if (joined.startsWith("file://")) {
      try {
        return fileURLToPath(joined);
      } catch {
        return joined;
      }
    }
    if (hasScheme(joined) || isAbsolute(joined)) return joined;
    return resolve(baseDir, joined);
  });
  const rawNames = Array.isArray(raw.names) ? raw.names : [];
  const names: (string | undefined)[] = rawNames.map((n) => (typeof n === "string" ? n : undefined));
  const mappings = typeof raw.mappings === "string" ? raw.mappings : "";
  return { sources, names, lines: decodeMappings(mappings) };
}

function isLocalFileUrl(url: string): boolean {
  if (url === "") return false;
  if (url.startsWith("node:")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("file://")) return false; // http(s), etc.
  return true;
}

function urlToPath(url: string): string {
  if (url.startsWith("file://")) return fileURLToPath(url);
  return url;
}

function findSourceMappingUrl(content: string): string | undefined {
  const matches = [...content.matchAll(/\/[/*][#@]\s*sourceMappingURL=([^\s*]+)/g)];
  const last = matches.at(-1);
  return last?.[1];
}

/** Decodes a `data:` URI's payload - `;base64,` (common) or plain percent-encoding (legal, and
 *  what a hand-written or non-Node tool sometimes emits instead). */
function decodeDataUri(declared: string): string | undefined {
  const comma = declared.indexOf(",");
  if (comma === -1) return undefined;
  const meta = declared.slice(5, comma); // after "data:"
  const payload = declared.slice(comma + 1);
  if (meta.endsWith(";base64")) {
    return Buffer.from(payload, "base64").toString("utf8");
  }
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

function loadMapForScript(scriptPath: string): DecodedMap | undefined {
  let content: string;
  try {
    content = readFileSync(scriptPath, "utf8");
  } catch {
    return undefined;
  }

  const declared = findSourceMappingUrl(content);
  let rawJson: string | undefined;
  let mapDir = dirname(scriptPath);

  if (declared !== undefined) {
    if (declared.startsWith("data:")) {
      rawJson = decodeDataUri(declared);
      // No separate map file for an inline map; sources resolve against the script's own
      // directory, the closest thing to "the map's own location" that exists here.
    } else {
      const mapPath = isAbsolute(declared) ? declared : resolve(dirname(scriptPath), declared);
      try {
        rawJson = readFileSync(mapPath, "utf8");
        mapDir = dirname(mapPath);
      } catch {
        rawJson = undefined;
      }
    }
  }

  if (rawJson === undefined) {
    const siblingMapPath = `${scriptPath}.map`;
    try {
      rawJson = readFileSync(siblingMapPath, "utf8");
      mapDir = dirname(siblingMapPath);
    } catch {
      return undefined;
    }
  }

  try {
    return decodeMap(JSON.parse(rawJson) as RawSourceMap, mapDir);
  } catch {
    return undefined;
  }
}

export interface SourceMapper {
  map(url: string, line: number, column: number): SourcePosition | undefined;
}

/** One mapper instance caches every script it has looked at; reuse it across a whole profile. */
export function createSourceMapper(): SourceMapper {
  const cache = new Map<string, DecodedMap | undefined>();

  return {
    map(url: string, line: number, column: number): SourcePosition | undefined {
      if (!isLocalFileUrl(url)) return undefined;

      let decoded: DecodedMap | undefined;
      if (cache.has(url)) {
        decoded = cache.get(url);
      } else {
        const path = urlToPath(url);
        decoded = loadMapForScript(path);
        cache.set(url, decoded);
      }
      if (decoded === undefined) return undefined;

      const segments = decoded.lines[line];
      if (segments === undefined || segments.length === 0) return undefined;

      // The mapping for a column is the last segment whose generatedColumn does not exceed it -
      // segments describe "from here on", not point ranges.
      let candidate: Segment | undefined;
      for (const segment of segments) {
        if (segment.generatedColumn > column) break;
        candidate = segment;
      }
      if (candidate === undefined || candidate.sourceIndex === undefined) return undefined;

      const source = decoded.sources[candidate.sourceIndex];
      if (source === undefined || candidate.sourceLine === undefined || candidate.sourceColumn === undefined) {
        return undefined;
      }
      const name = candidate.nameIndex !== undefined ? decoded.names[candidate.nameIndex] : undefined;

      return { source, line: candidate.sourceLine, column: candidate.sourceColumn, name };
    },
  };
}
