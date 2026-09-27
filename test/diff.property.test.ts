// Property: diffing a profile against itself always reports no change - every function's and
// every area's share is identical to itself, so buildDiff's own before/after subtraction must
// land on exactly 0 (see diff.ts's comment on why float equality is safe here).
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile } from "../src/model.js";
import { buildDiff } from "../src/report/diff.js";
import { drawCpuProfileJson } from "./helpers/profile-gen.js";

test("a removed function's do: points at the before profile, since it no longer exists in after", () => {
  const beforeJson = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 }, children: [2] },
      { id: 2, callFrame: { functionName: "main", url: "file:///project/src/main.js", lineNumber: 0, columnNumber: 0 }, children: [3] },
      {
        id: 3,
        callFrame: { functionName: "removedFn", url: "file:///project/src/removed.js", lineNumber: 0, columnNumber: 0 },
        children: [],
      },
    ],
    samples: [3, 3],
    timeDeltas: [0, 100, 100],
  };
  const afterJson = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 }, children: [2] },
      { id: 2, callFrame: { functionName: "main", url: "file:///project/src/main.js", lineNumber: 0, columnNumber: 0 }, children: [] },
    ],
    samples: [2, 2],
    timeDeltas: [0, 100, 100],
  };

  const before = analyzeCpuProfile(parseCpuProfile(beforeJson), { root: "/project" });
  const after = analyzeCpuProfile(parseCpuProfile(afterJson), { root: "/project" });
  const data = buildDiff(before, after, "before.cpuprofile", "after.cpuprofile");

  const removed = data.functions.find((f) => f.key.startsWith("removedFn"));
  assert.ok(removed !== undefined, "expected removedFn to show up as the dominant change");
  assert.equal(removed!.afterShare, 0);
  assert.ok(!after.functions.has(removed!.key), "removedFn must not exist in after.functions at all");
  assert.equal(data.do, `finderscope callees 'before.cpuprofile' '${removed!.key}'`);
});

test(
  "diff(p, p) reports no change",
  () => {
    hegel.test(
      (tc) => {
        const json = drawCpuProfileJson(tc, 8, 15);
        const before = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
        const after = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
        const data = buildDiff(before, after, "before.cpuprofile", "after.cpuprofile");
        assert.deepEqual(data.functions, []);
        assert.equal(data.functionsCut, 0);
        assert.deepEqual(data.areas, []);
        assert.equal(data.areasCut, 0);
      },
      { testCases: 100 },
    );
  },
  20_000,
);
