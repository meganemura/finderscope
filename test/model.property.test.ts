// Property: for any generated call tree and sample list, four invariants hold regardless of
// shape: every function's area is a string (not, say, a value a plain-object lookup table leaked
// from Object.prototype - see model.ts's SPECIAL_AREAS comment), sum(self) == profile total,
// self <= total(fn) <= profile total for every function, and sum(area totals) == profile total.
// Generates through the real profile/cpu.ts parser (raw JSON in, not a hand-built
// NormalizedCpuProfile), so a bug in self-time reconstruction from timeDeltas would show up here
// too, not only in model.ts.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile, classifyScriptArea } from "../src/model.js";
import { drawCpuProfileJson } from "./helpers/profile-gen.js";

test(
  "every function's area is a string",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawCpuProfileJson(tc));
        const analysis = analyzeCpuProfile(profile, { root: "/project" });
        for (const fn of analysis.functions.values()) {
          assert.equal(typeof fn.area, "string", `${fn.key}: area was a ${typeof fn.area}, not a string`);
        }
        for (const area of analysis.areaTotals.keys()) {
          assert.equal(typeof area, "string");
        }
      },
      { testCases: 200 },
    );
  },
  20_000,
);

test("injected preload paths are always classified outside own code", () =>
  hegel.test((tc) => {
    const suffix = tc.draw(gs.text({ alphabet: "abcdefghijklmnopqrstuvwxyz0123456789", minSize: 1, maxSize: 20 }));
    const name = tc.draw(gs.sampledFrom(["heap-snapshot-preload.cjs", "signal-exit-preload.cjs"]));
    const path = `/tmp/finderscope-${suffix}/${name}`;
    assert.equal(classifyScriptArea(path), "finderscope");
  }, { testCases: 100 }));

test(
  "sum(self) == profile total",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawCpuProfileJson(tc));
        const analysis = analyzeCpuProfile(profile, { root: "/project" });
        const sumSelf = [...analysis.functions.values()].reduce((sum, f) => sum + f.self, 0);
        assert.equal(sumSelf, analysis.total);
      },
      { testCases: 200 },
    );
  },
  20_000,
);

test(
  "self <= total(fn) <= profile total, for every function",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawCpuProfileJson(tc));
        const analysis = analyzeCpuProfile(profile, { root: "/project" });
        for (const fn of analysis.functions.values()) {
          assert.ok(fn.self <= fn.total, `${fn.key}: self ${fn.self} > total ${fn.total}`);
          assert.ok(fn.total <= analysis.total, `${fn.key}: total ${fn.total} > profile total ${analysis.total}`);
        }
      },
      { testCases: 200 },
    );
  },
  20_000,
);

test(
  "sum(area totals) == profile total",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawCpuProfileJson(tc));
        const analysis = analyzeCpuProfile(profile, { root: "/project" });
        const sumAreas = [...analysis.areaTotals.values()].reduce((sum, v) => sum + v, 0);
        assert.equal(sumAreas, analysis.total);
      },
      { testCases: 200 },
    );
  },
  20_000,
);
