// Responsibility: shape and format bounded heap-snapshot summary, top, and retainer reports.
// Boundary: parsing and dominator computation stay in profile/heapsnapshot.ts and heapsnapshot.ts.

import { heapConstructorKey, retainingPath, type ConstructorGroup, type HeapSnapshotAnalysis } from "../heapsnapshot.js";
import { formatValue, shQuote } from "./summary.js";

const SUMMARY_CONSTRUCTORS = 10;
const SUMMARY_RETAINERS = 5;
const TOP_COUNT = 30;
const RETAINER_COUNT = 5;

export interface SnapshotConstructorEntry extends ConstructorGroup {
  share: number;
}

export interface SnapshotPathEntry {
  key: string;
  constructor: string;
  edge?: string;
  cut?: true;
  continuation?: string;
}

export interface SnapshotRetainerEntry {
  key: string;
  constructor: string;
  self: number;
  retained: number;
  path: SnapshotPathEntry[];
}

export interface HeapSnapshotSummaryData {
  metric: "heap-snapshot";
  unit: "bytes";
  total: number;
  constructors: SnapshotConstructorEntry[];
  constructorsCut: number;
  retainers: SnapshotRetainerEntry[];
  retainersCut: number;
  retainersMore?: string;
  areas: { area: string; count: number; self: number; share: number }[];
  areasCut: number;
  do: string;
}

export type SnapshotTopBy = "retained" | "self" | "count";

export interface HeapSnapshotTopData {
  metric: "heap-snapshot";
  unit: "bytes";
  by: SnapshotTopBy;
  total: number;
  entries: SnapshotConstructorEntry[];
  cut: number;
  do: string;
}

export interface HeapSnapshotRetainersData {
  metric: "heap-snapshot";
  unit: "bytes";
  target: string;
  total: number;
  objects: SnapshotRetainerEntry[];
  cut: number;
  do: string;
}

export class SnapshotQueryError extends Error {
  readonly do: string;
  constructor(message: string, doLine: string) {
    super(message);
    this.name = "SnapshotQueryError";
    this.do = doLine;
  }
}

function share(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 1000) / 1000 : 0;
}

function groupEntry(group: ConstructorGroup, total: number): SnapshotConstructorEntry {
  return { ...group, share: share(group.retained, total) };
}

function nodeConstructor(analysis: HeapSnapshotAnalysis, node: number): string {
  return heapConstructorKey(analysis.nodeType(node), analysis.nodeName(node));
}

function retainerEntry(analysis: HeapSnapshotAnalysis, node: number, profilePath: string): SnapshotRetainerEntry {
  return {
    key: `#${analysis.nodeId(node)}`,
    constructor: nodeConstructor(analysis, node),
    self: analysis.nodeSelf(node),
    retained: analysis.retained[node]!,
    path: retainingPath(analysis, node).map((part) => "cut" in part
      ? { key: "…", constructor: "(path cut)", cut: true, continuation: `finderscope retainers ${shQuote(profilePath)} '#${analysis.nodeId(part.continuationNode)}'` }
      : {
        key: `#${analysis.nodeId(part.node)}`,
        constructor: nodeConstructor(analysis, part.node),
        ...(part.edge === undefined ? {} : { edge: part.edge }),
      }),
  };
}

function topNodes(analysis: HeapSnapshotAnalysis, n: number, groupId?: number, collapseChains = false): { nodes: number[]; count: number } {
  const nodes: number[] = [];
  let count = 0;
  const absorbed = new Uint8Array(analysis.snapshot.nodeCount);
  if (collapseChains) {
    for (let node = 1; node < analysis.snapshot.nodeCount; node++) {
      const parent = analysis.idom[node]!;
      if (parent !== analysis.root && analysis.retained[node]! >= analysis.retained[parent]! * 0.95) absorbed[parent] = 1;
    }
  }
  for (let node = 1; node < analysis.snapshot.nodeCount; node++) {
    if (groupId !== undefined && analysis.nodeGroup[node] !== groupId) continue;
    if (absorbed[node] !== 0) continue;
    count++;
    const better = (left: number, right: number): boolean => analysis.retained[left]! > analysis.retained[right]!
      || (analysis.retained[left] === analysis.retained[right] && analysis.nodeSelf(left) > analysis.nodeSelf(right));
    if (nodes.length < n) nodes.push(node);
    else if (better(node, nodes[0]!)) nodes[0] = node;
    else continue;
    for (let child = nodes.length - 1; child > 0;) {
      const parent = Math.floor((child - 1) / 2);
      if (!better(nodes[parent]!, nodes[child]!)) break;
      [nodes[parent], nodes[child]] = [nodes[child]!, nodes[parent]!];
      child = parent;
    }
    for (let parent = 0;;) {
      const left = parent * 2 + 1;
      if (left >= nodes.length) break;
      const right = left + 1;
      const worseChild = right < nodes.length && better(nodes[left]!, nodes[right]!) ? right : left;
      if (!better(nodes[parent]!, nodes[worseChild]!)) break;
      [nodes[parent], nodes[worseChild]] = [nodes[worseChild]!, nodes[parent]!];
      parent = worseChild;
    }
  }
  nodes.sort((a, b) => analysis.retained[b]! - analysis.retained[a]! || analysis.nodeSelf(b) - analysis.nodeSelf(a));
  return { nodes, count };
}

function widerCount(shown: number): number {
  return Math.min(Math.max(2 * shown, 50), 500);
}

export function buildHeapSnapshotSummary(analysis: HeapSnapshotAnalysis, profilePath: string, n = SUMMARY_RETAINERS): HeapSnapshotSummaryData {
  const constructorGroups = [...analysis.groups].sort((a, b) => b.self - a.self || b.retained - a.retained || a.key.localeCompare(b.key));
  const constructors = constructorGroups.slice(0, SUMMARY_CONSTRUCTORS).map((group) => groupEntry(group, analysis.total));
  const ranked = topNodes(analysis, n, undefined, true);
  const nodes = ranked.nodes;
  const retainers = nodes.map((node) => retainerEntry(analysis, node, profilePath));
  const firstTarget = retainers[0]?.key ?? constructors[0]?.key;
  const areas = analysis.areas.slice(0, SUMMARY_CONSTRUCTORS).map((area) => ({ ...area, share: share(area.self, analysis.total) }));
  const retainersCut = Math.max(0, ranked.count - retainers.length);
  const nextRetainerCount = widerCount(retainers.length);
  return {
    metric: "heap-snapshot",
    unit: "bytes",
    total: analysis.total,
    constructors,
    constructorsCut: Math.max(0, constructorGroups.length - SUMMARY_CONSTRUCTORS),
    retainers,
    retainersCut,
    ...(retainersCut > 0 ? { retainersMore: retainers.length >= 500 && retainers[0] !== undefined
      ? `finderscope retainers ${shQuote(profilePath)} ${shQuote(retainers[0].key)}`
      : `finderscope ${shQuote(profilePath)} -n ${nextRetainerCount}` } : {}),
    areas,
    areasCut: Math.max(0, analysis.areas.length - areas.length),
    do: firstTarget === undefined
      ? `finderscope top ${shQuote(profilePath)} --by self`
      : `finderscope retainers ${shQuote(profilePath)} ${shQuote(firstTarget)}`,
  };
}

export function buildHeapSnapshotTop(analysis: HeapSnapshotAnalysis, profilePath: string, by: SnapshotTopBy, n = TOP_COUNT): HeapSnapshotTopData {
  const ranked = [...analysis.groups].sort((a, b) => b[by] - a[by] || b.retained - a.retained || a.key.localeCompare(b.key));
  const entries = ranked.slice(0, n).map((group) => groupEntry(group, analysis.total));
  const cut = Math.max(0, ranked.length - n);
  return {
    metric: "heap-snapshot",
    unit: "bytes",
    by,
    total: analysis.total,
    entries,
    cut,
    do: entries[0] === undefined
      ? `finderscope ${shQuote(profilePath)}`
      : `finderscope retainers ${shQuote(profilePath)} ${shQuote(entries[0].key)}`,
  };
}

function resolveTarget(analysis: HeapSnapshotAnalysis, query: string, profilePath: string): { node?: number; groupId?: number } {
  const nodeMatch = /^#(\d+)$/.exec(query);
  if (nodeMatch !== null) {
    const id = Number(nodeMatch[1]);
    if (Number.isSafeInteger(id)) {
      for (let node = 0; node < analysis.snapshot.nodeCount; node++) if (analysis.nodeId(node) === id) return { node };
    }
  }
  const groupId = analysis.groupIdByKey.get(query);
  if (groupId !== undefined) return { groupId };
  throw new SnapshotQueryError(
    `no constructor or node id matches ${JSON.stringify(query)}`,
    `finderscope top ${shQuote(profilePath)} --by retained`,
  );
}

export function buildHeapSnapshotRetainers(analysis: HeapSnapshotAnalysis, profilePath: string, query: string, n = RETAINER_COUNT): HeapSnapshotRetainersData {
  const target = resolveTarget(analysis, query, profilePath);
  const ranked = target.node === undefined ? topNodes(analysis, n, target.groupId) : { nodes: [target.node], count: 1 };
  return {
    metric: "heap-snapshot",
    unit: "bytes",
    target: query,
    total: analysis.total,
    objects: ranked.nodes.map((node) => retainerEntry(analysis, node, profilePath)),
    cut: Math.max(0, ranked.count - n),
    do: `finderscope top ${shQuote(profilePath)} --by retained`,
  };
}

function formatPath(path: SnapshotPathEntry[]): string {
  let result = "";
  let cut = false;
  for (const part of path) {
    if (part.cut === true) {
      result += ` --… (${part.continuation})--> `;
      cut = true;
      continue;
    }
    if (result.length > 0 && !cut) result += ` --${visible(part.edge ?? "?")}--> `;
    result += `${part.key} ${visible(part.constructor)}`;
    cut = false;
  }
  return result;
}

function visible(value: string): string {
  return value.replace(/[\u0000-\u001f]/g, (character) => JSON.stringify(character).slice(1, -1));
}

export function formatHeapSnapshotSummaryText(data: HeapSnapshotSummaryData, profilePath: string): string {
  const lines = [`profile: ${profilePath}`, "", `finderscope heap snapshot (total ${formatValue("bytes", data.total)})`, "", "by constructor (by self):"];
  for (const entry of data.constructors) {
    lines.push(`  ${String(entry.count).padStart(8)}  ${formatValue("bytes", entry.self).padStart(9)} self  ${formatValue("bytes", entry.retained).padStart(9)} retained  ${visible(entry.key)}`);
  }
  if (data.constructorsCut > 0) lines.push(`  … ${data.constructorsCut} more (finderscope top ${shQuote(profilePath)} --by self)`);
  lines.push("", "largest single retainers:");
  for (const entry of data.retainers) {
    lines.push(`  ${formatValue("bytes", entry.retained).padStart(9)} retained  ${formatValue("bytes", entry.self).padStart(9)} self  ${entry.key} ${visible(entry.constructor)}`);
    lines.push(`    ${formatPath(entry.path)}`);
  }
  if (data.retainersCut > 0 && data.retainersMore !== undefined) lines.push(`  … ${data.retainersCut} more (${data.retainersMore})`);
  lines.push("", "by area (located closures):");
  if (data.areas.length === 0) lines.push("  no closure locations with resolvable script paths");
  for (const area of data.areas) lines.push(`  ${formatValue("bytes", area.self).padStart(9)}  ${String(area.count).padStart(8)} closures  ${area.area}`);
  if (data.areasCut > 0) lines.push(`  … ${data.areasCut} more`);
  lines.push("", `do: ${data.do}`);
  return lines.join("\n");
}

export function formatHeapSnapshotTopText(data: HeapSnapshotTopData, profilePath: string): string {
  const lines = [`profile: ${profilePath}`, "", `finderscope top heap snapshot (by ${data.by})`, ""];
  for (const entry of data.entries) {
    lines.push(`  ${String(entry.count).padStart(8)}  ${formatValue("bytes", entry.self).padStart(9)} self  ${formatValue("bytes", entry.retained).padStart(9)} retained  ${visible(entry.key)}`);
  }
  if (data.cut > 0) {
    const more = data.entries.length >= 500 && data.entries[0] !== undefined
      ? `finderscope retainers ${shQuote(profilePath)} ${shQuote(data.entries[0].key)}`
      : `finderscope top ${shQuote(profilePath)} --by ${data.by} -n ${widerCount(data.entries.length)}`;
    lines.push(`  … ${data.cut} more (${more})`);
  }
  lines.push("", `do: ${data.do}`);
  return lines.join("\n");
}

export function formatHeapSnapshotRetainersText(data: HeapSnapshotRetainersData, profilePath: string): string {
  const lines = [`profile: ${profilePath}`, "", `finderscope retainers ${JSON.stringify(data.target)}`, ""];
  for (const entry of data.objects) {
    lines.push(`  ${formatValue("bytes", entry.retained).padStart(9)} retained  ${formatValue("bytes", entry.self).padStart(9)} self  ${entry.key} ${visible(entry.constructor)}`);
    lines.push(`    ${formatPath(entry.path)}`);
  }
  if (data.cut > 0) {
    const more = data.objects.length >= 500 && data.objects[0] !== undefined
      ? `finderscope retainers ${shQuote(profilePath)} ${shQuote(data.objects[0].key)}`
      : `finderscope retainers ${shQuote(profilePath)} ${shQuote(data.target)} -n ${widerCount(data.objects.length)}`;
    lines.push(`  … ${data.cut} more (${more})`);
  }
  lines.push("", `do: ${data.do}`);
  return lines.join("\n");
}
