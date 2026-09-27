// Property: for a generated heap call tree, sum(self) == total and self <= total(fn) for every
// function - the same two invariants test/model.property.test.ts checks for a cpu profile,
// checked here against a real .heapprofile-shaped tree instead (heap.ts has no sample-time
// reconstruction to share with cpu.ts, so this is not redundant with the cpu property).
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { TestCase } from "@hegeldev/hegel";
import { parseHeapProfile } from "../src/profile/heap.js";
import { analyzeHeapProfile } from "../src/model.js";

interface RawHeapNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  selfSize: number;
  children: RawHeapNode[];
}

const FRAME_POOL = [
  { functionName: "own1", url: "file:///project/src/a.js" },
  { functionName: "libFn", url: "file:///project/node_modules/some-lib/index.js" },
  { functionName: "constructor", url: "file:///project/src/b.js" },
];

/** Builds a random heap tree (a JS object tree, not id-referenced - heap.ts's own shape), width
 *  and depth both bounded, with a random selfSize (including 0) at every node. */
function drawHeapNode(tc: TestCase, nextId: { value: number }, depthRemaining: number): RawHeapNode {
  const id = nextId.value++;
  const frame = tc.draw(gs.sampledFrom(FRAME_POOL));
  const selfSize = tc.draw(gs.integers({ minValue: 0, maxValue: 1000 }));
  const childCount = depthRemaining > 0 ? tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) : 0;
  const children: RawHeapNode[] = [];
  for (let i = 0; i < childCount; i++) {
    children.push(drawHeapNode(tc, nextId, depthRemaining - 1));
  }
  return { id, callFrame: { functionName: frame.functionName, url: frame.url, lineNumber: 0, columnNumber: 0 }, selfSize, children };
}

function drawHeapProfileJson(tc: TestCase): unknown {
  const nextId = { value: 0 };
  const head = drawHeapNode(tc, nextId, 4);
  return { head };
}

test(
  "sum(self) == total and self <= total(fn), for a generated heap profile",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseHeapProfile(drawHeapProfileJson(tc));
        const analysis = analyzeHeapProfile(profile, { root: "/project" });

        const sumSelf = [...analysis.functions.values()].reduce((sum, f) => sum + f.self, 0);
        assert.equal(sumSelf, analysis.total);

        for (const fn of analysis.functions.values()) {
          assert.ok(fn.self <= fn.total, `${fn.key}: self ${fn.self} > total ${fn.total}`);
          assert.ok(fn.total <= analysis.total, `${fn.key}: total ${fn.total} > profile total ${analysis.total}`);
        }
      },
      { testCases: 150 },
    );
  },
  20_000,
);
