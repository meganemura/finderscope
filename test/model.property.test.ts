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
import { buildTop } from "../src/report/top.js";
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
    const name = tc.draw(gs.sampledFrom(["heap-snapshot-preload.cjs", "signal-exit-preload.cjs", "cpu-prof-preload.cjs"]));
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

test(
  "caused values and not-caused values partition the profile total exactly",
  () => {
    hegel.test((tc) => {
      const analysis = analyzeCpuProfile(parseCpuProfile(drawCpuProfileJson(tc)), { root: "/project" });
      const caused = [...analysis.caused.values()].reduce((sum, entry) => sum + entry.value, 0);
      const notCaused = [...analysis.notCaused.values()].reduce((sum, value) => sum + value, 0);
      assert.equal(caused + notCaused, analysis.total);
    }, { testCases: 200 });
  },
  20_000,
);

test(
  "caused cost never exceeds the function's inclusive total",
  () => {
    hegel.test((tc) => {
      const analysis = analyzeCpuProfile(parseCpuProfile(drawCpuProfileJson(tc)), { root: "/project" });
      for (const fn of analysis.functions.values()) {
        assert.ok(fn.caused <= fn.total, `${fn.key}: caused ${fn.caused} > total ${fn.total}`);
      }
    }, { testCases: 200 });
  },
  20_000,
);

test(
  "entry values sum to each candidate's non-own caused cost",
  () => {
    hegel.test((tc) => {
      const analysis = analyzeCpuProfile(parseCpuProfile(drawCpuProfileJson(tc)), { root: "/project" });
      for (const candidate of analysis.caused.values()) {
        const entries = [...candidate.entries.values()].reduce((sum, entry) => sum + entry.value, 0);
        assert.equal(entries, candidate.value - candidate.self, candidate.key);
      }
    }, { testCases: 200 });
  },
  20_000,
);

test(
  "top --leaf rows sum to the leaf self time reached from own code",
  () => {
    hegel.test((tc) => {
      const analysis = analyzeCpuProfile(parseCpuProfile(drawCpuProfileJson(tc)), { root: "/project" });
      for (const leaf of analysis.functions.values()) {
        const expected = analysis.paths
          .filter((path) => path.keys.at(-1) === leaf.key && path.keys.some((key) => analysis.functions.get(key)?.area === "own"))
          .reduce((sum, path) => sum + path.value, 0);
        const actual = buildTop(analysis, "profile.cpuprofile", { leaf: leaf.key, n: Number.MAX_SAFE_INTEGER }).entries
          .reduce((sum, row) => sum + row.value, 0);
        assert.equal(actual, expected, leaf.key);
      }
    }, { testCases: 200 });
  },
  20_000,
);

type LoaderFrame = { functionName: string; url: string; lineNumber: number; loads: boolean };

// Names and urls seen in real `node --cpu-prof` profiles on Node 24.22.0. A frame with `loads`
// runs only while a module is read, compiled, linked, or evaluated for the first time. The others
// also run for a cached require(), a cached import(), require.resolve(), or import.meta.resolve().
const LOADER_FRAMES: LoaderFrame[] = [
  { functionName: "wrapSafe", url: "node:internal/modules/cjs/loader", lineNumber: 1693, loads: true },
  { functionName: "loadSource", url: "node:internal/modules/cjs/loader", lineNumber: 1100, loads: true },
  { functionName: "loadESMFromCJS", url: "node:internal/modules/cjs/loader", lineNumber: 1500, loads: true },
  { functionName: "loadAndTranslate", url: "node:internal/modules/esm/loader", lineNumber: 500, loads: true },
  { functionName: "compileSourceTextModule", url: "node:internal/modules/esm/utils", lineNumber: 340, loads: true },
  { functionName: "ModuleJob", url: "node:internal/modules/esm/module_job", lineNumber: 120, loads: true },
  { functionName: "", url: "file:///project/node_modules/pkg/index.js", lineNumber: 0, loads: true },
  { functionName: "getOrCreateModuleJob", url: "node:internal/modules/esm/loader", lineNumber: 600, loads: false },
  { functionName: "resolveSync", url: "node:internal/modules/esm/loader", lineNumber: 760, loads: false },
  { functionName: "wrapModuleLoad", url: "node:internal/modules/cjs/loader", lineNumber: 230, loads: false },
  { functionName: "", url: "node:internal/modules/cjs/loader", lineNumber: 1180, loads: false },
  { functionName: "resolveForCJSWithHooks", url: "node:internal/modules/cjs/loader", lineNumber: 1380, loads: false },
  { functionName: "stat", url: "node:internal/modules/cjs/loader", lineNumber: 250, loads: false },
  { functionName: "readFileSync", url: "node:fs", lineNumber: 430, loads: false },
  { functionName: "internalModuleStat", url: "", lineNumber: 0, loads: false },
  { functionName: "parse", url: "file:///project/node_modules/pkg/index.js", lineNumber: 40, loads: false },
];

const ENTRIES = [
  { functionName: "importModuleDynamicallyCallback", url: "node:internal/modules/esm/utils", lineNumber: 200, loads: false },
  { functionName: "require", url: "node:internal/modules/helpers", lineNumber: 130, loads: false },
  { functionName: "resolve", url: "node:internal/modules/helpers", lineNumber: 140, loads: false },
];

const START = { functionName: "start", url: "file:///project/src/main.mjs", lineNumber: 0, loads: false };
const IMPORTED_TOP_LEVEL = { functionName: "", url: "file:///project/src/heavy.mjs", lineNumber: 0, loads: false };
const OWN_KEYS = new Map([[START.url, "start src/main.mjs:1:1"], [IMPORTED_TOP_LEVEL.url, "(anonymous) src/heavy.mjs:1:1"]]);

test(
  "loader work below an own import() or require() is module loading only when a module loads; the rest stays on the nearest own frame",
  () => {
    hegel.test((tc) => {
      const pool = [...LOADER_FRAMES, IMPORTED_TOP_LEVEL];
      const below = tc.draw(gs.arrays(gs.sampledFrom(pool), { minSize: 1, maxSize: 7 }));
      const frames = [{ functionName: "(root)", url: "", lineNumber: 0, loads: false }, START, tc.draw(gs.sampledFrom(ENTRIES)), ...below];
      const sampleCount = tc.draw(gs.integers({ minValue: 2, maxValue: 12 }));
      const sampled = tc.draw(gs.arrays(gs.integers({ minValue: 1, maxValue: frames.length - 1 }), { minSize: sampleCount, maxSize: sampleCount }));
      const timeDeltas = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 500 }), { minSize: sampleCount, maxSize: sampleCount }));
      const nodes = frames.map((frame, id) => ({
        id,
        callFrame: { functionName: frame.functionName, url: frame.url, lineNumber: frame.lineNumber, columnNumber: 0 },
        children: id + 1 < frames.length ? [id + 1] : [],
      }));
      const profile = parseCpuProfile({ nodes, samples: sampled, timeDeltas });
      const analysis = analyzeCpuProfile(profile, { root: "/project" });

      const expectedCaused = new Map<string, number>();
      let expectedLoading = 0;
      profile.samples.forEach((depth, i) => {
        const time = profile.sampleTimes[i]!;
        if (time <= 0) return;
        const stack = frames.slice(0, depth + 1);
        const ownDepth = stack.findLastIndex((frame) => OWN_KEYS.has(frame.url));
        const rest = stack.slice(ownDepth + 1);
        if (rest[0]?.url.startsWith("node:internal/modules/") && rest.some((frame) => frame.loads)) {
          expectedLoading += time;
        } else {
          const key = OWN_KEYS.get(stack[ownDepth]!.url)!;
          expectedCaused.set(key, (expectedCaused.get(key) ?? 0) + time);
        }
      });
      assert.deepEqual(new Map([...analysis.caused].map(([key, entry]) => [key, entry.value])), expectedCaused);
      assert.deepEqual(analysis.notCaused, expectedLoading > 0 ? new Map([["module loading", expectedLoading]]) : new Map());
    }, { testCases: 300 });
  },
  20_000,
);
