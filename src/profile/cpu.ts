// Responsibility: parse a .cpuprofile into a normalized call tree with a self-time-in-microseconds
// number attached to every sample, using integer arithmetic throughout so sum(self) == total holds
// exactly (float error would otherwise make that property flaky).
// Boundary: does not classify frames into areas or apply source maps - model.ts does both, after
// merging nodes that map to the same function key.

import { ProfileShapeError } from "./detect.js";

export interface CpuFrame {
  functionName: string;
  url: string;
  /** 0-based, as V8 stores it. model.ts converts to 1-based after any source mapping. */
  line: number;
  /** 0-based, as V8 stores it. */
  column: number;
}

export interface CpuNode {
  id: number;
  frame: CpuFrame;
  parentId: number | undefined;
  childIds: number[];
  /** V8's own per-line sample counts inside this node's function, when the profiler wrote them -
   *  an older Node, or a profile V8 wrote without --detailed-line-info (`positionTicks` is not
   *  guaranteed on every build), leaves this undefined. `line` is 1-based, in the GENERATED
   *  script - unlike callFrame's own 0-based lineNumber - because that is what V8 itself writes;
   *  model.ts's report/lines.ts converts it the same way classify() converts callFrame's line, so
   *  a caller never sees the two conventions mixed. */
  positionTicks: { line: number; ticks: number }[] | undefined;
}

export interface NormalizedCpuProfile {
  kind: "cpu";
  nodes: Map<number, CpuNode>;
  rootId: number;
  /** Node id hit by each sample, in order. */
  samples: number[];
  /**
   * Microseconds attributed to each sample, same length and order as `samples`. Sample i's time
   * is timeDeltas[i + 1] - the delta to the NEXT sample - matching how Chrome DevTools attributes
   * time, because a sample marks where a stack was caught, not how long it ran; the duration
   * belongs to the interval that follows it. The gap before the first sample (timeDeltas[0]) is
   * not attributed to any sample - it is profiler startup, not code. The last sample has no
   * following delta, so it gets the lower median of the other sample times, rounded down to stay
   * an integer. Real V8 output can contain a negative delta (a clock adjustment); it is clamped to
   * 0 rather than allowed to make a sample's or the total's time go backwards.
   */
  sampleTimes: number[];
  /** Sum of sampleTimes, not endTime - startTime, so it agrees with sum(self) exactly. */
  totalDuration: number;
}

interface RawCallFrame {
  functionName?: unknown;
  url?: unknown;
  lineNumber?: unknown;
  columnNumber?: unknown;
}

interface RawPositionTick {
  line?: unknown;
  ticks?: unknown;
}

interface RawCpuNode {
  id?: unknown;
  callFrame?: RawCallFrame;
  children?: unknown;
  parent?: unknown;
  positionTicks?: unknown;
}

/**
 * An entry missing line/ticks entirely, or carrying a non-number one, is dropped rather than
 * rejecting the whole profile - positionTicks is optional data lines.ts treats as absent, not a
 * shape a cpuprofile is validated against the way nodes/samples/timeDeltas are. A negative or
 * non-integer `ticks`, though, is not a shape mismatch to shrug off the same way: a real V8 tick
 * count is always a nonnegative integer, so one that isn't means the file itself is corrupt in a
 * way model.ts's apportionTicks (largest-remainder over an integer self time) has no correct
 * answer for - a negative or fractional tick count would apportion a NEGATIVE or fractional share
 * of a line's self time, silently breaking the "per-line times sum to exactly self time" invariant
 * report/lines.ts and its own Hegel property test rely on. That is worth failing the whole
 * profile for, the same as a malformed nodes/samples/timeDeltas shape.
 */
function parsePositionTicks(raw: unknown, nodeId: number): { line: number; ticks: number }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: { line: number; ticks: number }[] = [];
  for (const entry of raw as RawPositionTick[]) {
    if (typeof entry?.line !== "number" || typeof entry?.ticks !== "number") continue;
    if (!Number.isInteger(entry.ticks) || entry.ticks < 0) {
      throw new ProfileShapeError(`node ${nodeId}'s positionTicks has a non-integer or negative ticks value (got ${JSON.stringify(entry.ticks)})`);
    }
    result.push({ line: entry.line, ticks: entry.ticks });
  }
  return result.length > 0 ? result : undefined;
}

interface RawCpuProfile {
  nodes?: unknown;
  samples?: unknown;
  timeDeltas?: unknown;
}

function medianLower(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted[mid]!;
}

/**
 * A node's parentId chain must reach a node with no parent within `nodes.size` steps; if it
 * doesn't, one of the ids visited already appeared earlier in THIS SAME walk, i.e. a cycle -
 * model.ts's chain-building assumes an acyclic parent chain and would otherwise grow that chain
 * forever. Iterative (a plain walk with a per-run visited set), not recursive, and O(n) overall:
 * a node whose walk reaches an already-fully-verified node stops immediately.
 */
function checkNoCycles(nodes: Map<number, CpuNode>): void {
  const verified = new Set<number>();
  for (const startId of nodes.keys()) {
    if (verified.has(startId)) continue;
    const visitedThisWalk = new Set<number>();
    let current: number | undefined = startId;
    while (current !== undefined && !verified.has(current)) {
      if (visitedThisWalk.has(current)) {
        throw new ProfileShapeError(`the call tree has a cycle involving node ${current}`);
      }
      visitedThisWalk.add(current);
      current = nodes.get(current)!.parentId;
    }
    for (const id of visitedThisWalk) verified.add(id);
  }
}

export function parseCpuProfile(json: unknown): NormalizedCpuProfile {
  const raw = json as RawCpuProfile;
  if (!Array.isArray(raw.nodes)) {
    throw new ProfileShapeError('cpuprofile is missing its "nodes" array');
  }
  const rawNodes = raw.nodes as RawCpuNode[];
  if (rawNodes.length === 0) {
    throw new ProfileShapeError("cpuprofile has no nodes");
  }

  const nodes = new Map<number, CpuNode>();
  for (const rawNode of rawNodes) {
    const id = typeof rawNode.id === "number" ? rawNode.id : undefined;
    if (id === undefined) throw new ProfileShapeError(`cpuprofile node is missing an id (found ${JSON.stringify(rawNode.id)})`);
    const callFrame = rawNode.callFrame ?? {};
    const frame: CpuFrame = {
      functionName: typeof callFrame.functionName === "string" ? callFrame.functionName : "",
      url: typeof callFrame.url === "string" ? callFrame.url : "",
      line: typeof callFrame.lineNumber === "number" ? callFrame.lineNumber : 0,
      column: typeof callFrame.columnNumber === "number" ? callFrame.columnNumber : 0,
    };
    nodes.set(id, { id, frame, parentId: undefined, childIds: [], positionTicks: parsePositionTicks(rawNode.positionTicks, id) });
  }

  // Two shapes exist in the wild: `children: number[]` on each node (node --cpu-prof, and most
  // DevTools captures), or a `parent: number` back-reference with no `children` array at all.
  // Support both; derive whichever side is missing from the one that is present. Either way, a
  // referenced id that names no real node is rejected here rather than left for model.ts to find
  // as an undefined `.parentId` read three files away.
  const anyChildren = rawNodes.some((n) => Array.isArray(n.children));
  if (anyChildren) {
    for (const rawNode of rawNodes) {
      const id = rawNode.id as number;
      const node = nodes.get(id)!;
      const children = Array.isArray(rawNode.children) ? (rawNode.children as unknown[]) : [];
      for (const childId of children) {
        if (typeof childId !== "number") continue;
        if (!nodes.has(childId)) {
          throw new ProfileShapeError(`node ${id}'s child ${childId} does not exist`);
        }
        node.childIds.push(childId);
        nodes.get(childId)!.parentId = id;
      }
    }
  } else {
    for (const rawNode of rawNodes) {
      const id = rawNode.id as number;
      if (typeof rawNode.parent === "number") {
        if (!nodes.has(rawNode.parent)) {
          throw new ProfileShapeError(`node ${id}'s parent ${rawNode.parent} does not exist`);
        }
        const node = nodes.get(id)!;
        node.parentId = rawNode.parent;
        nodes.get(rawNode.parent)!.childIds.push(id);
      }
    }
  }

  checkNoCycles(nodes);

  // The root is always the first node written; every real profile we've seen agrees, and nothing
  // downstream depends on finding it any other way (root's own frame is "(root)" by convention).
  const rootId = rawNodes[0]!.id as number;

  if (!Array.isArray(raw.samples)) {
    throw new ProfileShapeError('cpuprofile is missing its "samples" array');
  }
  if (!Array.isArray(raw.timeDeltas)) {
    throw new ProfileShapeError('cpuprofile is missing its "timeDeltas" array');
  }
  const samples = raw.samples as unknown[];
  for (const [i, sampleId] of samples.entries()) {
    if (typeof sampleId !== "number" || !nodes.has(sampleId)) {
      throw new ProfileShapeError(`samples[${i}] references node ${JSON.stringify(sampleId)}, which does not exist`);
    }
  }

  const timeDeltasRaw = raw.timeDeltas as unknown[];
  const deltas: number[] = timeDeltasRaw.map((d, i) => {
    if (typeof d !== "number" || !Number.isFinite(d)) {
      throw new ProfileShapeError(`timeDeltas[${i}] is not a finite number (got ${JSON.stringify(d)})`);
    }
    return Math.max(0, d);
  });

  const sampleTimes: number[] = new Array(samples.length).fill(0);
  for (let i = 0; i < samples.length; i++) {
    if (i < samples.length - 1) {
      sampleTimes[i] = deltas[i + 1] ?? 0;
    }
  }
  if (samples.length > 0) {
    const others = sampleTimes.slice(0, samples.length - 1);
    sampleTimes[samples.length - 1] = medianLower(others);
  }

  const totalDuration = sampleTimes.reduce((a, b) => a + b, 0);

  return { kind: "cpu", nodes, rootId, samples: samples as number[], sampleTimes, totalDuration };
}
