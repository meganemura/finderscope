// Property: analyzeCpuProfile's real self/total/area aggregation agrees with a deliberately
// naive, separately written oracle (test/helpers/oracle.ts) on generated profiles that include
// recursion (the same function at more than one depth on one path), "(root)", negative deltas, a
// non-integer delta, and shared subtrees (several samples under one common ancestor). Compared
// within a relative error of 1e-9, not exact equality: a non-integer delta makes the two
// implementations' summation order differ, and floating point addition is not associative.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { TestCase } from "@hegeldev/hegel";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile } from "../src/model.js";
import { computeOracle, type RawNode, type RawOracleProfile } from "./helpers/oracle.js";

const FRAME_POOL = [
  { functionName: "own1", url: "file:///project/src/a.js" },
  { functionName: "own2", url: "file:///project/src/b.js" },
  { functionName: "libFn", url: "file:///project/node_modules/some-lib/index.js" },
  { functionName: "nodeFn", url: "node:fs" },
  { functionName: "(idle)", url: "" },
  { functionName: "(garbage collector)", url: "" },
];
// A fixed small set of names reused at different tree depths, on purpose, so recursion (the same
// function key appearing more than once on one sample's own path to the root) is guaranteed, not
// merely possible.
const RECURSIVE_NAMES = ["recurseA", "recurseB"];

/**
 * Node 0 is always "(root)", like every real profile (and like test/helpers/profile-gen.ts's
 * shared generator). Every other node either reuses one of RECURSIVE_NAMES (so some function
 * necessarily recurs across the generated tree) or draws from FRAME_POOL. Every node with id > 0
 * and id < nodeCount - 1 can be a parent of more than one later node, which is what makes several
 * samples land under one shared subtree - not a special case, just what a small random tree with
 * several samples does most of the time.
 */
function drawOracleTree(tc: TestCase, maxNodes: number): { nodes: RawNode[]; nodeCount: number } {
  const nodeCount = tc.draw(gs.integers({ minValue: 3, maxValue: maxNodes }));
  const nodes: RawNode[] = [];
  for (let id = 0; id < nodeCount; id++) {
    let frame: { functionName: string; url: string };
    if (id === 0) {
      frame = { functionName: "(root)", url: "" };
    } else if (tc.draw(gs.booleans())) {
      const name = tc.draw(gs.sampledFrom(RECURSIVE_NAMES));
      frame = { functionName: name, url: "file:///project/src/recursive.js" };
    } else {
      frame = tc.draw(gs.sampledFrom(FRAME_POOL));
    }
    nodes.push({ id, callFrame: { functionName: frame.functionName, url: frame.url, lineNumber: 0, columnNumber: 0 }, children: [] });
    if (id > 0) {
      const parentId = tc.draw(gs.integers({ minValue: 0, maxValue: id - 1 }));
      nodes[parentId]!.children.push(id);
    }
  }
  return { nodes, nodeCount };
}

function drawOracleProfileJson(tc: TestCase): RawOracleProfile {
  const { nodes, nodeCount } = drawOracleTree(tc, 12);
  const sampleCount = tc.draw(gs.integers({ minValue: 1, maxValue: 25 }));
  const samples: number[] = [];
  const timeDeltas: number[] = [0]; // timeDeltas[0] is the pre-first-sample gap, unused either way
  for (let i = 0; i < sampleCount; i++) {
    samples.push(tc.draw(gs.integers({ minValue: 0, maxValue: nodeCount - 1 })));
  }
  for (let i = 0; i < sampleCount; i++) {
    // Negative (a clock adjustment, clamped to 0 by both implementations) and non-integer (a
    // real, if unusual, finite delta) deltas, mixed with plain nonnegative integers.
    const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
    if (kind === 0) timeDeltas.push(tc.draw(gs.integers({ minValue: -200, maxValue: 500 })));
    else if (kind === 1) timeDeltas.push(tc.draw(gs.floats({ minValue: 0, maxValue: 500, allowNan: false, allowInfinity: false })));
    else timeDeltas.push(tc.draw(gs.floats({ minValue: -200, maxValue: 500, allowNan: false, allowInfinity: false })));
  }
  return { nodes, samples, timeDeltas };
}

function assertClose(actual: number, expected: number, label: string): void {
  const scale = Math.max(Math.abs(actual), Math.abs(expected), 1);
  const relativeError = Math.abs(actual - expected) / scale;
  assert.ok(relativeError <= 1e-9, `${label}: actual ${actual}, expected ${expected} (relative error ${relativeError})`);
}

test(
  "the real aggregation agrees with the independent oracle: self, total, and area totals, for every function",
  () => {
    hegel.test(
      (tc) => {
        const json = drawOracleProfileJson(tc);
        const root = "/project";

        const profile = parseCpuProfile(json);
        const analysis = analyzeCpuProfile(profile, { root });
        const oracle = computeOracle(json, root);

        assertClose(analysis.total, oracle.profileTotal, "profile total");

        const allKeys = new Set([...analysis.functions.keys(), ...oracle.self.keys(), ...oracle.total.keys()]);
        for (const key of allKeys) {
          const realFn = analysis.functions.get(key);
          assertClose(realFn?.self ?? 0, oracle.self.get(key) ?? 0, `self(${key})`);
          assertClose(realFn?.total ?? 0, oracle.total.get(key) ?? 0, `total(${key})`);
        }

        const allAreas = new Set([...analysis.areaTotals.keys(), ...oracle.areaTotals.keys()]);
        for (const area of allAreas) {
          assertClose(analysis.areaTotals.get(area) ?? 0, oracle.areaTotals.get(area) ?? 0, `area(${area})`);
        }
      },
      { testCases: 300 },
    );
  },
  20_000,
);
