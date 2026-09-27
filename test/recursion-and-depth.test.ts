// Regression tests: a direct self-call folds into the recursing node instead of nesting once per
// recursion depth, and a node truncated by the depth limit (not by the per-level children budget)
// carries a depth-cut marker saying so.
import { test } from "vitest";
import assert from "node:assert/strict";
import { analyzeCpuProfile } from "../src/model.js";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { buildCalleesTree } from "../src/report/callees.js";

const ROOT = "/project";

test("direct recursion (A calls A, then A calls B) merges into one node with a real total", () => {
  const json = {
    nodes: [
      { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
      { id: 1, callFrame: { functionName: "A", url: "file:///project/src/a.js", lineNumber: 0, columnNumber: 0 }, children: [2] },
      { id: 2, callFrame: { functionName: "A", url: "file:///project/src/a.js", lineNumber: 0, columnNumber: 0 }, children: [3] },
      { id: 3, callFrame: { functionName: "B", url: "file:///project/src/b.js", lineNumber: 0, columnNumber: 0 }, children: [] },
    ],
    samples: [1, 1, 2, 3, 3],
    timeDeltas: [0, 1000, 1000, 1000, 1000],
  };
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: ROOT });
  const fnA = [...analysis.functions.values()].find((f) => f.name === "A")!;
  const fnB = [...analysis.functions.values()].find((f) => f.name === "B")!;
  // Self across both recursion levels merges into fn.self (model.ts's own aggregation already
  // did this before this feature existed) - the new behavior under test is the TREE.
  assert.equal(fnA.self, 3000);
  assert.equal(fnB.self, 2000);

  const data = buildCalleesTree(analysis, fnA, "profile.cpuprofile");
  assert.equal(data.recursive, true);
  // Exactly one child (B) - not a nested "A" node representing the second recursion level.
  assert.equal(data.children.filter((c) => !c.isSelf).length, 1);
  const selfRow = data.children.find((c) => c.isSelf);
  assert.ok(selfRow !== undefined);
  assert.equal(selfRow!.value, 3000, "both recursion levels' self time merged into (self)");
  const bRow = data.children.find((c) => c.key === fnB.key);
  assert.ok(bRow !== undefined);
  assert.equal(bRow!.value, 2000);
});

test("a node truncated by the depth limit (not the children budget) carries depthCut", () => {
  const json = {
    nodes: [
      { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
      { id: 1, callFrame: { functionName: "A", url: "file:///project/src/a.js", lineNumber: 0, columnNumber: 0 }, children: [2] },
      { id: 2, callFrame: { functionName: "B", url: "file:///project/src/b.js", lineNumber: 0, columnNumber: 0 }, children: [3] },
      { id: 3, callFrame: { functionName: "C", url: "file:///project/src/c.js", lineNumber: 0, columnNumber: 0 }, children: [4] },
      { id: 4, callFrame: { functionName: "D", url: "file:///project/src/d.js", lineNumber: 0, columnNumber: 0 }, children: [] },
    ],
    samples: [4, 4],
    timeDeltas: [0, 1000, 1000],
  };
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: ROOT });
  const fnA = [...analysis.functions.values()].find((f) => f.name === "A")!;
  const fnC = [...analysis.functions.values()].find((f) => f.name === "C")!;

  // Default depth (2): callees(A) shows B, and B's own child C - but C's own child (D) is past
  // the depth budget, so C itself must carry depthCut, not silently look like a leaf.
  const data = buildCalleesTree(analysis, fnA, "profile.cpuprofile");
  const bRow = data.children.find((c) => !c.isSelf)!;
  assert.equal(bRow.key, [...analysis.functions.values()].find((f) => f.name === "B")!.key);
  const cRow = bRow.children.find((c) => !c.isSelf)!;
  assert.equal(cRow.key, fnC.key);
  assert.equal(cRow.depthCut, true);
  assert.equal(cRow.children.length, 0, "D is not shown at all - depthCut says so instead");
});
