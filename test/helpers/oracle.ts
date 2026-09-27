// Deliberately naive, separately written re-implementation of the self/total/area-total
// aggregation analyzeCpuProfile (model.ts) computes, and of cpu.ts's own sample-time convention -
// used only to cross-check the real implementation's output in test/oracle.property.test.ts.
// Walks every sample with a plain loop; no chain caching, no per-node memoization, no Set-based
// pathKeys reuse, nothing shared with model.ts's own aggregation code - a bug shared between this
// file and the real implementation would have to be the same bug, written twice, independently.
//
// Imports ONLY classify() (and its GenericNode/GenericFrame types) from model.ts - the key and
// area classification for one frame. This oracle does not re-test classification itself (own vs
// package vs node vs wasm vs eval vs native, --root handling, source maps, ...); it takes
// whatever classify() says about a frame as given, and checks whether the SUMS the real
// aggregation computes from that classification are correct.

import { classify, type GenericNode } from "../../src/model.js";
import { createSourceMapper } from "../../src/sourcemap.js";

export interface RawCallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface RawNode {
  id: number;
  callFrame: RawCallFrame;
  children: number[];
}

export interface RawOracleProfile {
  nodes: RawNode[];
  samples: number[];
  timeDeltas: number[];
}

export interface OracleResult {
  self: Map<string, number>;
  total: Map<string, number>;
  areaTotals: Map<string, number>;
  profileTotal: number;
}

function medianLower(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * Each sample's time: the NEXT sample's delta, clamped to 0 when negative; the last sample gets
 * the lower median of the others. Recomputed here from the raw samples/timeDeltas arrays, not
 * borrowed from cpu.ts's own already-computed sampleTimes field - this oracle re-derives the
 * convention itself instead of trusting the real code got it right.
 */
function computeSampleTimes(samples: number[], timeDeltas: number[]): number[] {
  const times: number[] = new Array(samples.length).fill(0);
  for (let i = 0; i < samples.length - 1; i++) {
    const raw = timeDeltas[i + 1] ?? 0;
    times[i] = Math.max(0, raw);
  }
  if (samples.length > 0) {
    times[samples.length - 1] = medianLower(times.slice(0, samples.length - 1));
  }
  return times;
}

export function computeOracle(raw: RawOracleProfile, root: string): OracleResult {
  const mapper = createSourceMapper();

  // The full parent map, built by a plain loop over the raw children arrays - not by reusing
  // cpu.ts's own node-building code.
  const parentOf = new Map<number, number | undefined>();
  const frameOf = new Map<number, RawCallFrame>();
  for (const n of raw.nodes) {
    if (!parentOf.has(n.id)) parentOf.set(n.id, undefined);
    frameOf.set(n.id, n.callFrame);
  }
  for (const n of raw.nodes) {
    for (const childId of n.children) parentOf.set(childId, n.id);
  }

  const classifyCache = new Map<number, { key: string; area: string }>();
  function classifyId(id: number): { key: string; area: string } {
    const cached = classifyCache.get(id);
    if (cached !== undefined) return cached;
    const frame = frameOf.get(id)!;
    const node: GenericNode = {
      id,
      parentId: parentOf.get(id),
      frame: { functionName: frame.functionName, url: frame.url, line: frame.lineNumber, column: frame.columnNumber },
    };
    const result = classify(node, root, mapper);
    classifyCache.set(id, result);
    return result;
  }

  // Every id from `id` up to the root, via the parent map, with its own simple loop - not
  // model.ts's chainOf/pathKeysOf.
  function stackOf(id: number): number[] {
    const stack: number[] = [];
    let current: number | undefined = id;
    while (current !== undefined) {
      stack.push(current);
      current = parentOf.get(current);
    }
    return stack;
  }

  const sampleTimes = computeSampleTimes(raw.samples, raw.timeDeltas);

  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const areaTotals = new Map<string, number>();
  let profileTotal = 0;

  for (let i = 0; i < raw.samples.length; i++) {
    const time = sampleTimes[i]!;
    if (time <= 0) continue;
    profileTotal += time;

    const nodeId = raw.samples[i]!;
    const own = classifyId(nodeId);
    self.set(own.key, (self.get(own.key) ?? 0) + time);
    areaTotals.set(own.area, (areaTotals.get(own.area) ?? 0) + time);

    // total(fn): the sample counts once for every distinct key on its stack, even if that key
    // recurs at more than one depth - a plain Set built fresh per sample, not a cached/shared one.
    const seenKeys = new Set<string>();
    for (const ancestorId of stackOf(nodeId)) {
      seenKeys.add(classifyId(ancestorId).key);
    }
    for (const key of seenKeys) {
      total.set(key, (total.get(key) ?? 0) + time);
    }
  }

  return { self, total, areaTotals, profileTotal };
}
