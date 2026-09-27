// Responsibility: parse a .heapprofile into a normalized call tree with sampled bytes still live
// when the profile was written, self-attributed per node. Node's --heap-prof output already
// aggregates that into each tree node's own `selfSize`, so unlike cpu.ts there is no sample-time
// reconstruction to do here.
// Boundary: does not classify frames into areas or apply source maps - model.ts does both.

import { ProfileShapeError } from "./detect.js";

export interface HeapFrame {
  functionName: string;
  /** 0-based, as V8 stores it. model.ts converts to 1-based after any source mapping. */
  line: number;
  column: number;
  url: string;
}

export interface HeapNode {
  id: number;
  frame: HeapFrame;
  parentId: number | undefined;
  childIds: number[];
  /** Sampled bytes still live when the profile was written, attributed to this frame directly
   *  (not its descendants) - not "bytes allocated": a sampling heap profiler counts what a
   *  sample still found live at write time, which already excludes anything freed before then. */
  selfSize: number;
}

export interface NormalizedHeapProfile {
  kind: "heap";
  nodes: Map<number, HeapNode>;
  rootId: number;
  /** Sum of every node's selfSize. */
  totalBytes: number;
}

interface RawCallFrame {
  functionName?: unknown;
  url?: unknown;
  lineNumber?: unknown;
  columnNumber?: unknown;
}

interface RawHeapNode {
  id?: unknown;
  callFrame?: RawCallFrame;
  selfSize?: unknown;
  children?: unknown;
}

interface RawHeapProfile {
  head?: unknown;
}

export function parseHeapProfile(json: unknown): NormalizedHeapProfile {
  const raw = json as RawHeapProfile;
  if (typeof raw.head !== "object" || raw.head === null) {
    throw new ProfileShapeError("heapprofile has no head node");
  }

  const nodes = new Map<number, HeapNode>();
  let nextSyntheticId = 0;
  let totalBytes = 0;
  let rootId: number | undefined;

  // Iterative (an explicit stack), not recursive: a real heap profile's own call tree can be
  // deep enough that one JS call frame per tree node would risk overflowing the real call stack -
  // the same reasoning model.ts's chain/key-set walks follow. Children are pushed in reverse so
  // popping them back off visits them in their original left-to-right order, matching what a
  // recursive walk would have done (childIds order is not load-bearing downstream, but there is
  // no reason to scramble it either).
  const stack: { rawNode: RawHeapNode; parentId: number | undefined }[] = [{ rawNode: raw.head as RawHeapNode, parentId: undefined }];
  while (stack.length > 0) {
    const { rawNode, parentId } = stack.pop()!;
    const id = typeof rawNode.id === "number" ? rawNode.id : nextSyntheticId++;
    const callFrame = rawNode.callFrame ?? {};
    const frame: HeapFrame = {
      functionName: typeof callFrame.functionName === "string" ? callFrame.functionName : "",
      url: typeof callFrame.url === "string" ? callFrame.url : "",
      line: typeof callFrame.lineNumber === "number" ? callFrame.lineNumber : 0,
      column: typeof callFrame.columnNumber === "number" ? callFrame.columnNumber : 0,
    };

    const rawSelfSize = rawNode.selfSize;
    if (rawSelfSize !== undefined && (typeof rawSelfSize !== "number" || !Number.isFinite(rawSelfSize))) {
      throw new ProfileShapeError(`node ${id}'s selfSize is not a finite number (got ${JSON.stringify(rawSelfSize)})`);
    }
    const selfSize = typeof rawSelfSize === "number" ? rawSelfSize : 0;
    totalBytes += selfSize;

    const node: HeapNode = { id, frame, parentId, childIds: [], selfSize };
    nodes.set(id, node);
    if (parentId !== undefined) nodes.get(parentId)!.childIds.push(id);
    if (rootId === undefined) rootId = id;

    const children = Array.isArray(rawNode.children) ? (rawNode.children as RawHeapNode[]) : [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ rawNode: children[i]!, parentId: id });
    }
  }

  return { kind: "heap", nodes, rootId: rootId!, totalBytes };
}
