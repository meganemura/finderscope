// Responsibility: build a Chrome-compatible dominator model and bounded report facts from a
// parsed V8 heap snapshot. Boundary: this module does not read files or format CLI output.

import type { ParsedHeapSnapshot } from "./profile/heapsnapshot.js";
import { classifyScriptArea } from "./model.js";

const NONE = 0xffffffff;

function releaseArrays(...arrays: ArrayBufferView[]): void {
  // Large snapshots otherwise keep phase-only backing stores resident until a later GC. Transfer
  // each completed store to length zero when the runtime supports the standard transfer method.
  for (const array of arrays) {
    const buffer = array.buffer;
    if (buffer instanceof ArrayBuffer && typeof buffer.transfer === "function") buffer.transfer(0);
  }
}

export interface ConstructorGroup {
  key: string;
  type: string;
  name: string;
  count: number;
  self: number;
  retained: number;
}

export interface SnapshotArea {
  area: string;
  count: number;
  self: number;
}

export interface HeapSnapshotAnalysis {
  snapshot: ParsedHeapSnapshot;
  total: number;
  root: number;
  idom: Uint32Array;
  retained: Float64Array;
  pathParent: Uint32Array;
  pathEdge: Uint32Array;
  groups: ConstructorGroup[];
  groupIdByKey: Map<string, number>;
  nodeGroup: Int32Array;
  areas: SnapshotArea[];
  nodeType: (node: number) => string;
  nodeName: (node: number) => string;
  nodeSelf: (node: number) => number;
  nodeId: (node: number) => number;
  edgeName: (edge: number) => string;
  edgeTarget: (edge: number) => number;
}

function stringTypes(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`heap snapshot ${label} is missing`);
  }
  return value;
}

function requiredOffset(fields: string[], name: string): number {
  const offset = fields.indexOf(name);
  if (offset < 0) throw new Error(`heap snapshot field ${name} is missing`);
  return offset;
}

export function heapConstructorKey(type: string, name: string): string {
  if ((type === "object" || type === "native") && name.length > 0) return name;
  return `(${type})`;
}

export function analyzeHeapSnapshot(snapshot: ParsedHeapSnapshot): HeapSnapshotAnalysis {
  const nodeFields = snapshot.meta.node_fields;
  const edgeFields = snapshot.meta.edge_fields;
  const nodeWidth = nodeFields.length;
  const edgeWidth = edgeFields.length;
  const nodeTypes = stringTypes(snapshot.meta.node_types[0], "node types");
  const edgeTypes = stringTypes(snapshot.meta.edge_types[0], "edge types");
  const nodeTypeOffset = requiredOffset(nodeFields, "type");
  const nodeNameOffset = requiredOffset(nodeFields, "name");
  const nodeSelfOffset = requiredOffset(nodeFields, "self_size");
  const nodeIdOffset = requiredOffset(nodeFields, "id");
  const nodeEdgeCountOffset = requiredOffset(nodeFields, "edge_count");
  const edgeTypeOffset = requiredOffset(edgeFields, "type");
  const edgeNameOffset = requiredOffset(edgeFields, "name_or_index");
  const edgeTargetOffset = requiredOffset(edgeFields, "to_node");
  const weakType = edgeTypes.indexOf("weak");
  const shortcutType = edgeTypes.indexOf("shortcut");
  const elementType = edgeTypes.indexOf("element");
  const hiddenType = edgeTypes.indexOf("hidden");
  const root = 0;
  const nodeType = (node: number): string => nodeTypes[snapshot.nodes[node * nodeWidth + nodeTypeOffset]!] ?? "unknown";
  const nodeName = (node: number): string => snapshot.strings[snapshot.nodes[node * nodeWidth + nodeNameOffset]!] ?? "";
  const nodeSelf = (node: number): number => snapshot.nodes[node * nodeWidth + nodeSelfOffset]!;
  const nodeId = (node: number): number => snapshot.nodes[node * nodeWidth + nodeIdOffset]!;
  const edgeTarget = (edge: number): number => snapshot.edges[edge * edgeWidth + edgeTargetOffset]! / nodeWidth;
  const edgeName = (edge: number): string => {
    const type = snapshot.edges[edge * edgeWidth + edgeTypeOffset]!;
    const raw = snapshot.edges[edge * edgeWidth + edgeNameOffset]!;
    return type === elementType || type === hiddenType ? `[${raw}]` : (snapshot.strings[raw] ?? `[${raw}]`);
  };
  const essential = (from: number, edge: number): boolean => {
    const type = snapshot.edges[edge * edgeWidth + edgeTypeOffset]!;
    return type !== weakType && (type !== shortcutType || from === root);
  };

  const firstEdge = new Uint32Array(snapshot.nodeCount + 1);
  let edgeTotal = 0;
  for (let node = 0; node < snapshot.nodeCount; node++) {
    firstEdge[node] = edgeTotal;
    edgeTotal += snapshot.nodes[node * nodeWidth + nodeEdgeCountOffset]!;
  }
  firstEdge[snapshot.nodeCount] = edgeTotal;
  if (edgeTotal !== snapshot.edgeCount) throw new Error(`heap snapshot edge counts total ${edgeTotal}, expected ${snapshot.edgeCount}`);

  const reachable = new Uint8Array(snapshot.nodeCount);
  let idom: Uint32Array;
  let retained: Float64Array;
  let total = 0;
  {
  const post = new Uint32Array(snapshot.nodeCount);
  const stackNode = new Uint32Array(snapshot.nodeCount);
  const stackEdge = new Uint32Array(snapshot.nodeCount);
  let stackSize = 1;
  let postCount = 0;
  stackNode[0] = root;
  stackEdge[0] = firstEdge[root]!;
  reachable[root] = 1;
  while (stackSize > 0) {
    const node = stackNode[stackSize - 1]!;
    let edge = stackEdge[stackSize - 1]!;
    const end = firstEdge[node + 1]!;
    let pushed = false;
    while (edge < end) {
      stackEdge[stackSize - 1] = edge + 1;
      if (essential(node, edge)) {
        const child = edgeTarget(edge);
        if (child >= snapshot.nodeCount) throw new Error(`heap snapshot edge ${edge} has an invalid target`);
        if (reachable[child] === 0) {
          reachable[child] = 1;
          stackNode[stackSize] = child;
          stackEdge[stackSize] = firstEdge[child]!;
          stackSize++;
          pushed = true;
          break;
        }
      }
      edge++;
    }
    if (!pushed) {
      stackSize--;
      post[postCount++] = node;
    }
  }
  releaseArrays(stackNode, stackEdge);

  const post2node = new Uint32Array(snapshot.nodeCount);
  let orderCount = 0;
  for (let index = 0; index < postCount; index++) {
    const node = post[index]!;
    if (node !== root) post2node[orderCount++] = node;
  }
  for (let node = 0; node < snapshot.nodeCount; node++) if (reachable[node] === 0) post2node[orderCount++] = node;
  post2node[orderCount++] = root;
  if (orderCount !== snapshot.nodeCount) throw new Error("heap snapshot post-order construction failed");
  releaseArrays(post);
  const node2post = new Uint32Array(snapshot.nodeCount);
  for (let index = 0; index < snapshot.nodeCount; index++) node2post[post2node[index]!] = index;
  const rootPost = snapshot.nodeCount - 1;

  const retainerFirst = new Uint32Array(snapshot.nodeCount + 1);
  for (let from = 0; from < snapshot.nodeCount; from++) {
    for (let edge = firstEdge[from]!; edge < firstEdge[from + 1]!; edge++) {
      if (essential(from, edge)) {
        const at = edgeTarget(edge) + 1;
        retainerFirst[at] = retainerFirst[at]! + 1;
      }
    }
  }
  for (let index = 0; index < snapshot.nodeCount; index++) retainerFirst[index + 1] = retainerFirst[index + 1]! + retainerFirst[index]!;
  const retainers = new Uint32Array(retainerFirst[snapshot.nodeCount]!);
  const fillAt = retainerFirst.slice(0, snapshot.nodeCount);
  for (let from = 0; from < snapshot.nodeCount; from++) {
    for (let edge = firstEdge[from]!; edge < firstEdge[from + 1]!; edge++) {
      if (essential(from, edge)) {
        const target = edgeTarget(edge);
        const at = fillAt[target]!;
        retainers[at] = from;
        fillAt[target] = at + 1;
      }
    }
  }
  releaseArrays(fillAt);

  const domPost = new Uint32Array(snapshot.nodeCount).fill(NONE);
  domPost[rootPost] = rootPost;
  for (let index = 0; index < rootPost; index++) if (reachable[post2node[index]!] === 0) domPost[index] = rootPost;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = rootPost - 1; index >= 0; index--) {
      const node = post2node[index]!;
      if (reachable[node] === 0) continue;
      let candidate = NONE;
      for (let at = retainerFirst[node]!; at < retainerFirst[node + 1]!; at++) {
        const parent = retainers[at]!;
        if (reachable[parent] === 0) continue;
        let parentPost = node2post[parent]!;
        if (domPost[parentPost] === NONE) continue;
        if (candidate === NONE) {
          candidate = parentPost;
          continue;
        }
        let other = candidate;
        while (parentPost !== other) {
          while (parentPost < other) parentPost = domPost[parentPost]!;
          while (other < parentPost) other = domPost[other]!;
        }
        candidate = parentPost;
      }
      if (candidate !== NONE && domPost[index] !== candidate) {
        domPost[index] = candidate;
        changed = true;
      }
    }
  }

  idom = new Uint32Array(snapshot.nodeCount);
  retained = new Float64Array(snapshot.nodeCount);
  for (let node = 0; node < snapshot.nodeCount; node++) {
    const postIndex = node2post[node]!;
    idom[node] = post2node[domPost[postIndex] === NONE ? rootPost : domPost[postIndex]!]!;
    retained[node] = nodeSelf(node);
    total += nodeSelf(node);
  }
  releaseArrays(node2post, retainerFirst, retainers, domPost);
  idom[root] = root;
  for (let index = 0; index < rootPost; index++) {
    const node = post2node[index]!;
    const parent = idom[node]!;
    retained[parent] = retained[parent]! + retained[node]!;
  }
  releaseArrays(post2node);
  }
  releaseArrays(reachable);

  const pathParent = new Uint32Array(snapshot.nodeCount).fill(NONE);
  const pathEdge = new Uint32Array(snapshot.nodeCount).fill(NONE);
  const queue = new Uint32Array(snapshot.nodeCount);
  let queueStart = 0;
  let queueEnd = 1;
  queue[0] = root;
  pathParent[root] = root;
  while (queueStart < queueEnd) {
    const from = queue[queueStart++]!;
    for (let edge = firstEdge[from]!; edge < firstEdge[from + 1]!; edge++) {
      if (!essential(from, edge)) continue;
      const to = edgeTarget(edge);
      if (pathParent[to] !== NONE) continue;
      pathParent[to] = from;
      pathEdge[to] = edge;
      queue[queueEnd++] = to;
    }
  }
  releaseArrays(queue);

  const groupKeys: string[] = [];
  const groupKeyIds = new Map<string, number>();
  const usedGroupKeys = new Set<string>();
  const groupCompositeIds = new Map<string, number>();
  const groupIds = new Int32Array(snapshot.nodeCount).fill(-1);
  const aggregates: ConstructorGroup[] = [];
  for (let node = 1; node < snapshot.nodeCount; node++) {
    const type = nodeType(node);
    const name = nodeName(node);
    const base = heapConstructorKey(type, name);
    const composite = `${type}\0${base}`;
    let groupId = groupCompositeIds.get(composite);
    if (groupId === undefined) {
      groupId = groupKeys.length;
      let key = base;
      if (usedGroupKeys.has(key)) {
        key = `${base} [${type}]`;
        let suffix = 2;
        while (usedGroupKeys.has(key)) key = `${base} [${type} ${suffix++}]`;
      }
      groupKeys.push(key);
      usedGroupKeys.add(key);
      groupCompositeIds.set(composite, groupId);
      groupKeyIds.set(key, groupId);
      aggregates.push({ key, type, name: type === "object" || type === "native" ? name : "", count: 0, self: 0, retained: 0 });
    }
    groupIds[node] = groupId;
    const group = aggregates[groupId]!;
    group.count++;
    group.self += nodeSelf(node);
  }

  {
  const childFirst = new Uint32Array(snapshot.nodeCount + 1);
  for (let node = 1; node < snapshot.nodeCount; node++) {
    const at = idom[node]! + 1;
    childFirst[at] = childFirst[at]! + 1;
  }
  for (let node = 0; node < snapshot.nodeCount; node++) childFirst[node + 1] = childFirst[node + 1]! + childFirst[node]!;
  const children = new Uint32Array(snapshot.nodeCount - 1);
  const childFill = childFirst.slice(0, snapshot.nodeCount);
  for (let node = 1; node < snapshot.nodeCount; node++) {
    const parent = idom[node]!;
    const at = childFill[parent]!;
    children[at] = node;
    childFill[parent] = at + 1;
  }
  releaseArrays(childFill);
  const activeGroups = new Int32Array(groupKeys.length);
  const walkNode = new Uint32Array(snapshot.nodeCount);
  const walkNext = new Uint32Array(snapshot.nodeCount);
  let walkDepth = 1;
  walkNode[0] = root;
  walkNext[0] = childFirst[root]!;
  while (walkDepth > 0) {
    const frame = walkDepth - 1;
    const node = walkNode[frame]!;
    const next = walkNext[frame]!;
    if (next < childFirst[node + 1]!) {
      const child = children[next]!;
      walkNext[frame] = next + 1;
      const groupId = groupIds[child]!;
      if (groupId >= 0) {
        if (activeGroups[groupId] === 0) aggregates[groupId]!.retained += retained[child]!;
        activeGroups[groupId] = activeGroups[groupId]! + 1;
      }
      walkNode[walkDepth] = child;
      walkNext[walkDepth] = childFirst[child]!;
      walkDepth++;
      continue;
    }
    const groupId = groupIds[node]!;
    if (groupId >= 0) activeGroups[groupId] = activeGroups[groupId]! - 1;
    walkDepth--;
  }
  releaseArrays(childFirst, children, activeGroups, walkNode, walkNext);
  }
  const groups = [...aggregates].sort((a, b) => b.retained - a.retained || b.self - a.self || a.key.localeCompare(b.key));

  const areasByName = new Map<string, SnapshotArea>();
  const locationFields = snapshot.meta.location_fields ?? [];
  const locationWidth = locationFields.length;
  const objectOffset = locationFields.indexOf("object_index");
  const namedTarget = (node: number, name: string): number | undefined => {
    for (let edge = firstEdge[node]!; edge < firstEdge[node + 1]!; edge++) {
      if (edgeName(edge) === name) return edgeTarget(edge);
    }
    return undefined;
  };
  if (locationWidth > 0 && objectOffset >= 0) {
    const counted = new Uint8Array(snapshot.nodeCount);
    for (let at = 0; at < snapshot.locations.length; at += locationWidth) {
      const node = snapshot.locations[at + objectOffset]! / nodeWidth;
      if (nodeType(node) !== "closure" || counted[node] !== 0) continue;
      const shared = namedTarget(node, "shared");
      const script = shared === undefined ? undefined : namedTarget(shared, "script");
      if (script === undefined) continue;
      const path = nodeName(script);
      if (path.length === 0) continue;
      const area = classifyScriptArea(path);
      const entry = areasByName.get(area) ?? { area, count: 0, self: 0 };
      entry.count++;
      entry.self += nodeSelf(node);
      areasByName.set(area, entry);
      counted[node] = 1;
    }
  }
  const areas = [...areasByName.values()].sort((a, b) => b.self - a.self || b.count - a.count);

  releaseArrays(firstEdge);
  return { snapshot, total, root, idom, retained, pathParent, pathEdge, groups, groupIdByKey: groupKeyIds, nodeGroup: groupIds, areas, nodeType, nodeName, nodeSelf, nodeId, edgeName, edgeTarget };
}

export type RetainingPathPart = { node: number; edge: string | undefined } | { cut: true; continuationNode: number };

export function retainingPath(analysis: HeapSnapshotAnalysis, node: number, maxDepth = 8): RetainingPathPart[] {
  const reversed: { node: number; edge: string | undefined }[] = [];
  let current = node;
  while (current !== analysis.root && current !== NONE) {
    const edge = analysis.pathEdge[current]!;
    reversed.push({ node: current, edge: edge === NONE ? undefined : analysis.edgeName(edge) });
    current = analysis.pathParent[current]!;
  }
  if (current === NONE) return [{ node: analysis.root, edge: undefined }, { cut: true, continuationNode: node }, { node, edge: undefined }];
  reversed.push({ node: analysis.root, edge: undefined });
  const path = reversed.reverse();
  if (path.length <= maxDepth) return path;
  const suffix = path.slice(path.length - Math.max(1, maxDepth - 2));
  suffix[0] = { ...suffix[0]!, edge: undefined };
  return [path[0]!, { cut: true, continuationNode: suffix[0]!.node }, ...suffix];
}
