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

const LOADER_FRAMES = [
  { functionName: "compileSourceTextModule", url: "node:internal/modules/esm/utils" },
  { functionName: "getOrCreateModuleJob", url: "node:internal/modules/esm/loader" },
  { functionName: "Module._load", url: "node:internal/modules/cjs/loader" },
  { functionName: "readFileSync", url: "node:fs" },
  { functionName: "decode", url: "node:internal/encoding" },
  { functionName: "nativeFn", url: "" },
];

function chainProfile(frames: { functionName: string; url: string }[], sampledDepths: number[], timeDeltas: number[]): unknown {
  const nodes = frames.map((frame, id) => ({
    id,
    callFrame: { functionName: frame.functionName, url: frame.url, lineNumber: 0, columnNumber: 0 },
    children: id + 1 < frames.length ? [id + 1] : [],
  }));
  return { nodes, samples: sampledDepths, timeDeltas };
}

test(
  "a module graph loaded through import() from own code reports the same module loading as a static import of it",
  () => {
    hegel.test((tc) => {
      const loader = tc.draw(gs.arrays(gs.sampledFrom(LOADER_FRAMES), { minSize: 1, maxSize: 6 }));
      const sampleCount = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
      const sampled = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: loader.length - 1 }), { minSize: sampleCount, maxSize: sampleCount }));
      const timeDeltas = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 500 }), { minSize: sampleCount, maxSize: sampleCount }));

      const staticEntry = [
        { functionName: "(root)", url: "" },
        { functionName: "executeUserEntryPoint", url: "node:internal/modules/run_main" },
      ];
      const dynamicEntry = [
        { functionName: "(root)", url: "" },
        { functionName: "", url: "file:///project/src/main.mjs" },
        { functionName: "start", url: "file:///project/src/main.mjs" },
        { functionName: "importModuleDynamicallyCallback", url: "node:internal/modules/esm/utils" },
      ];
      const asStatic = analyzeCpuProfile(
        parseCpuProfile(chainProfile([...staticEntry, ...loader], sampled.map((d) => d + staticEntry.length), timeDeltas)),
        { root: "/project" },
      );
      const asDynamic = analyzeCpuProfile(
        parseCpuProfile(chainProfile([...dynamicEntry, ...loader], sampled.map((d) => d + dynamicEntry.length), timeDeltas)),
        { root: "/project" },
      );
      assert.deepEqual([...asDynamic.caused.keys()], []);
      assert.deepEqual([...asDynamic.notCaused], [...asStatic.notCaused]);
    }, { testCases: 200 });
  },
  20_000,
);
