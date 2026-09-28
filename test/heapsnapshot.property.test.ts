// Responsibility: check heap parser, dominator, and report invariants with independent oracles.
// Boundary: exact CLI wording and real V8 files stay in heapsnapshot.test.ts.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { analyzeHeapSnapshot } from "../src/heapsnapshot.js";
import { parseHeapSnapshot, type ParsedHeapSnapshot } from "../src/profile/heapsnapshot.js";
import { buildHeapSnapshotSummary } from "../src/report/heapsnapshot.js";

const NODE_FIELDS = ["type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness"];
const EDGE_FIELDS = ["type", "name_or_index", "to_node"];

function snapshotJson(nodes: number[], edges: number[], strings: string[]) {
  return {
    snapshot: {
      meta: {
        node_fields: NODE_FIELDS,
        node_types: [["hidden", "array", "string", "object", "code", "closure", "regexp", "number", "native", "synthetic"], "string", "number", "number", "number", "number", "number"],
        edge_fields: EDGE_FIELDS,
        edge_types: [["context", "element", "property", "internal", "hidden", "shortcut", "weak"], "string_or_number", "node"],
        location_fields: ["object_index", "script_id", "line", "column"],
      },
      node_count: nodes.length / NODE_FIELDS.length,
      edge_count: edges.length / EDGE_FIELDS.length,
      trace_function_count: 0,
    },
    nodes,
    edges,
    trace_function_infos: [],
    trace_tree: [],
    samples: [],
    locations: [] as number[],
    strings,
  };
}

function parsedFromGraph(parents: number[][], sizes: number[]): ParsedHeapSnapshot {
  const outgoing = parents.map(() => [] as number[]);
  for (let node = 1; node < parents.length; node++) for (const parent of parents[node]!) outgoing[parent]!.push(node);
  const nodes: number[] = [];
  const edges: number[] = [];
  for (let node = 0; node < parents.length; node++) {
    nodes.push(node === 0 ? 9 : 3, node === 0 ? 0 : 1, node + 1, sizes[node]!, outgoing[node]!.length, 0, 0);
    for (const child of outgoing[node]!) edges.push(2, 2, child * NODE_FIELDS.length);
  }
  const json = snapshotJson(nodes, edges, ["(root)", "Thing", "edge"]);
  return {
    meta: json.snapshot.meta,
    nodeCount: parents.length,
    edgeCount: edges.length / EDGE_FIELDS.length,
    nodes: Uint32Array.from(nodes),
    edges: Uint32Array.from(edges),
    locations: new Uint32Array(0),
    strings: json.strings,
    fileSize: 0,
  };
}

function allPaths(parents: number[][], node: number): number[][] {
  if (node === 0) return [[0]];
  return parents[node]!.flatMap((parent) => allPaths(parents, parent).map((path) => [...path, node]));
}

function naiveIdom(parents: number[][], node: number): number {
  if (node === 0) return 0;
  const paths = allPaths(parents, node);
  const common = paths[0]!.slice(0, -1).filter((candidate) => paths.every((path) => path.includes(candidate)));
  return common[common.length - 1] ?? 0;
}

interface GraphEdge {
  from: number;
  to: number;
  type: number;
}

function parsedFromEdges(count: number, sizes: number[], graphEdges: GraphEdge[]): ParsedHeapSnapshot {
  const outgoing = Array.from({ length: count }, () => [] as GraphEdge[]);
  for (const edge of graphEdges) outgoing[edge.from]!.push(edge);
  const nodes: number[] = [];
  const edges: number[] = [];
  for (let node = 0; node < count; node++) {
    nodes.push(node === 0 ? 9 : 3, node === 0 ? 0 : 1, node + 1, sizes[node]!, outgoing[node]!.length, 0, 0);
    for (const edge of outgoing[node]!) edges.push(edge.type, 2, edge.to * NODE_FIELDS.length);
  }
  const json = snapshotJson(nodes, edges, ["(root)", "Thing", "edge"]);
  return {
    meta: json.snapshot.meta,
    nodeCount: count,
    edgeCount: graphEdges.length,
    nodes: Uint32Array.from(nodes),
    edges: Uint32Array.from(edges),
    locations: new Uint32Array(0),
    strings: json.strings,
    fileSize: 0,
  };
}

function simpleRootPaths(count: number, graphEdges: GraphEdge[], target: number): number[][] {
  if (target === 0) return [[0]];
  const outgoing = Array.from({ length: count }, () => [] as number[]);
  for (const edge of graphEdges) {
    if (edge.type !== 6 && (edge.type !== 5 || edge.from === 0)) outgoing[edge.from]!.push(edge.to);
  }
  const paths: number[][] = [];
  const visit = (node: number, path: number[], seen: Set<number>): void => {
    if (node === target) {
      paths.push(path);
      return;
    }
    for (const child of outgoing[node]!) {
      if (seen.has(child)) continue;
      visit(child, [...path, child], new Set([...seen, child]));
    }
  };
  visit(0, [0], new Set([0]));
  return paths;
}

function naiveDirectedIdom(count: number, graphEdges: GraphEdge[], node: number): number {
  if (node === 0) return 0;
  const paths = simpleRootPaths(count, graphEdges, node);
  if (paths.length === 0) return 0;
  const common = paths[0]!.slice(0, -1).filter((candidate) => paths.every((path) => path.includes(candidate)));
  return common.find((candidate) => common.every((other) => other === candidate
    || simpleRootPaths(count, graphEdges, candidate).every((path) => path.includes(other)))) ?? 0;
}

test("dominator tree equals the exhaustive root-path oracle and preserves retained bounds", () =>
  hegel.test((tc) => {
    const count = tc.draw(gs.integers({ minValue: 2, maxValue: 9 }));
    const parents: number[][] = [[]];
    const sizes = [tc.draw(gs.integers({ minValue: 0, maxValue: 1000 }))];
    for (let node = 1; node < count; node++) {
      const primary = tc.draw(gs.integers({ minValue: 0, maxValue: node - 1 }));
      const extras = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: node - 1 }), { maxSize: 2, unique: true }));
      parents.push([...new Set([primary, ...extras])]);
      sizes.push(tc.draw(gs.integers({ minValue: 0, maxValue: 1000 })));
    }
    const analysis = analyzeHeapSnapshot(parsedFromGraph(parents, sizes));
    for (let node = 0; node < count; node++) {
      assert.equal(analysis.idom[node], naiveIdom(parents, node));
      assert.ok(analysis.retained[node]! >= analysis.nodeSelf(node));
    }
    assert.equal(analysis.retained[0], sizes.reduce((sum, size) => sum + size, 0));
    for (const group of analysis.groups) assert.ok(group.retained <= analysis.total);
  }, { testCases: 150 }));

test("dominator tree handles cycles, unreachable nodes, weak edges, and root-only shortcuts", () =>
  hegel.test((tc) => {
    const count = tc.draw(gs.integers({ minValue: 2, maxValue: 7 }));
    const sizes = Array.from({ length: count }, () => tc.draw(gs.integers({ minValue: 0, maxValue: 1000 })));
    const graphEdges: GraphEdge[] = [{ from: 0, to: 1, type: 2 }];
    const edgeCount = tc.draw(gs.integers({ minValue: 0, maxValue: 10 }));
    for (let index = 0; index < edgeCount; index++) {
      const edge = {
        from: tc.draw(gs.integers({ minValue: 0, maxValue: count - 1 })),
        to: tc.draw(gs.integers({ minValue: 1, maxValue: count - 1 })),
        type: [2, 5, 6][tc.draw(gs.integers({ minValue: 0, maxValue: 2 }))]!,
      };
      if (!graphEdges.some((present) => present.from === edge.from && present.to === edge.to && present.type === edge.type)) graphEdges.push(edge);
    }
    const analysis = analyzeHeapSnapshot(parsedFromEdges(count, sizes, graphEdges));
    for (let node = 0; node < count; node++) {
      assert.equal(analysis.idom[node], naiveDirectedIdom(count, graphEdges, node));
      assert.ok(analysis.retained[node]! >= analysis.nodeSelf(node));
    }
    assert.equal(analysis.retained[0], sizes.reduce((sum, size) => sum + size, 0));
    for (const group of analysis.groups) assert.ok(group.retained <= analysis.total);
  }, { testCases: 100 }));

test("collapsed summary retainers never keep a near-equal ancestor and descendant", () =>
  hegel.test((tc) => {
    const count = tc.draw(gs.integers({ minValue: 2, maxValue: 9 }));
    const parents: number[][] = [[]];
    const sizes = [0];
    for (let node = 1; node < count; node++) {
      parents.push([tc.draw(gs.integers({ minValue: 0, maxValue: node - 1 }))]);
      sizes.push(tc.draw(gs.integers({ minValue: 0, maxValue: 1000 })));
    }
    const analysis = analyzeHeapSnapshot(parsedFromGraph(parents, sizes));
    const rows = buildHeapSnapshotSummary(analysis, "snapshot", count).retainers;
    const byId = new Map(Array.from({ length: count }, (_, node) => [analysis.nodeId(node), node]));
    for (const ancestorRow of rows) for (const descendantRow of rows) {
      if (ancestorRow === descendantRow) continue;
      const ancestor = byId.get(Number(ancestorRow.key.slice(1)))!;
      let node = byId.get(Number(descendantRow.key.slice(1)))!;
      while (node !== analysis.root && node !== ancestor) node = analysis.idom[node]!;
      if (node === ancestor) assert.ok(descendantRow.retained < ancestorRow.retained * 0.95);
    }
  }, { testCases: 100 }));

test("streaming parser matches JSON.parse across small chunk boundaries", () =>
  hegel.test((tc) => {
    const value = tc.draw(gs.integers({ minValue: 100_000, maxValue: 999_999_999 }));
    const text = tc.draw(gs.text({ alphabet: "abc def\\\"", minSize: 1, maxSize: 30 }));
    const chunkSize = tc.draw(gs.integers({ minValue: 16, maxValue: 47 }));
    const json = snapshotJson([9, 0, 1, value, 0, 0, 0], [], ["(root)", text]);
    const dir = mkdtempSync(join(tmpdir(), "finderscope-stream-property-"));
    const path = join(dir, "small.heapsnapshot");
    try {
      writeFileSync(path, JSON.stringify(json));
      const parsed = parseHeapSnapshot(path, chunkSize);
      assert.deepEqual([...parsed.nodes], json.nodes);
      assert.deepEqual([...parsed.edges], json.edges);
      assert.deepEqual(parsed.strings, json.strings);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, { testCases: 100 }));

test("streaming parser reads locations and replaces a long string with its length", () => {
  const json = snapshotJson([9, 0, 1, 0, 0, 0, 0], [], ["(root)", "x".repeat(300)]);
  json.locations = [0, 42, 7, 9];
  const dir = mkdtempSync(join(tmpdir(), "finderscope-stream-locations-"));
  const path = join(dir, "locations.heapsnapshot");
  try {
    writeFileSync(path, JSON.stringify(json));
    const parsed = parseHeapSnapshot(path, 17);
    assert.deepEqual([...parsed.locations], json.locations);
    assert.deepEqual(parsed.strings, ["(root)", "<long:300:970138f5>"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("long string placeholders include a byte hash and escaped surrogate pairs decode", () => {
  const json = snapshotJson([9, 0, 1, 0, 0, 0, 0], [], ["(root)", "x".repeat(300), "y".repeat(300), "😀\n\t\\\""]);
  const dir = mkdtempSync(join(tmpdir(), "finderscope-string-hash-"));
  const path = join(dir, "strings.heapsnapshot");
  try {
    writeFileSync(path, JSON.stringify(json));
    const parsed = parseHeapSnapshot(path, 17);
    assert.match(parsed.strings[1]!, /^<long:300:[0-9a-f]{8}>$/);
    assert.match(parsed.strings[2]!, /^<long:300:[0-9a-f]{8}>$/);
    assert.notEqual(parsed.strings[1], parsed.strings[2]);
    assert.equal(parsed.strings[3], "😀\n\t\\\"");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every constructor group key resolves to exactly its group", () =>
  hegel.test((tc) => {
    const count = tc.draw(gs.integers({ minValue: 2, maxValue: 15 }));
    const names = Array.from({ length: count - 1 }, () => tc.draw(gs.sampledFrom(["X", "X [native]", "X [native 2]", "Y"])));
    const types = Array.from({ length: count - 1 }, () => tc.draw(gs.sampledFrom([3, 8])));
    const strings = ["(root)", "edge", ...new Set(names)];
    const nodes = [9, 0, 1, 0, count - 1, 0, 0];
    const edges: number[] = [];
    for (let index = 1; index < count; index++) {
      nodes.push(types[index - 1]!, strings.indexOf(names[index - 1]!), index * 2 + 1, 1, 0, 0, 0);
      edges.push(2, 1, index * NODE_FIELDS.length);
    }
    const json = snapshotJson(nodes, edges, strings);
    const parsed: ParsedHeapSnapshot = { meta: json.snapshot.meta, nodeCount: count, edgeCount: count - 1, nodes: Uint32Array.from(nodes), edges: Uint32Array.from(edges), locations: new Uint32Array(), strings, fileSize: 0 };
    const analysis = analyzeHeapSnapshot(parsed);
    assert.equal(new Set(analysis.groups.map((group) => group.key)).size, analysis.groups.length);
    assert.equal(analysis.groupIdByKey.size, analysis.groups.length);
    assert.equal(new Set(analysis.groupIdByKey.values()).size, analysis.groups.length);
  }, { testCases: 100 }));
