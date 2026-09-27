// Regression test: diff's `do:` must never name a function whose own delta rounded to 0.000 - the
// row the displayed "functions"/"areas" lists
// already dropped for exactly that reason (report/diff.ts's own rounding filter). Before the fix,
// chooseDo read the UNROUNDED lists, so a function whose real share barely moved (a raw delta
// too small for 3 decimals to show, but still != 0) could still be `do:`'s target even though no
// row for it exists anywhere in the same report.
import { test } from "vitest";
import assert from "node:assert/strict";
import { analyzeCpuProfile } from "../src/model.js";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { buildDiff } from "../src/report/diff.js";

const ROOT = "/project";

test("do: falls back to top when every real delta rounds to 0.000, not to an invisible row", () => {
  const before = {
    nodes: [
      { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
      { id: 1, callFrame: { functionName: "tiny", url: "file:///project/src/tiny.js", lineNumber: 0, columnNumber: 0 }, children: [] },
    ],
    samples: [1, 1],
    timeDeltas: [0, 500000, 500000],
  };
  const after = {
    nodes: [
      { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1, 2] },
      { id: 1, callFrame: { functionName: "tiny", url: "file:///project/src/tiny.js", lineNumber: 0, columnNumber: 0 }, children: [] },
      { id: 2, callFrame: { functionName: "filler", url: "file:///project/src/tiny.js", lineNumber: 5, columnNumber: 0 }, children: [] },
    ],
    samples: [2, 1, 1],
    timeDeltas: [0, 2, 499999, 499999],
  };

  const beforeAnalysis = analyzeCpuProfile(parseCpuProfile(before), { root: ROOT });
  const afterAnalysis = analyzeCpuProfile(parseCpuProfile(after), { root: ROOT });
  const data = buildDiff(beforeAnalysis, afterAnalysis, "before.cpuprofile", "after.cpuprofile");

  // The report itself shows no change at this precision ...
  assert.equal(data.functions.length, 0);
  assert.equal(data.areas.length, 0);
  // ... so do: must not point at "tiny" (or "filler") anyway - the generic fallback is the only
  // command that has anything to point at here.
  assert.equal(data.do, "finderscope top 'after.cpuprofile'");
});
