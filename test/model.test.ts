// Example tests for model.ts's area classification: "own" means a real file the agent can edit,
// regardless of --root (a pnpm-nested node_modules path, and a file outside --root that is still
// "own", with its absolute path); and the four frame shapes that can never be "own" because they
// have no real file at all (native, wasm, eval, and the constructor-collision regression).
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { parseHeapProfile } from "../src/profile/heap.js";
import { analyzeCpuProfile, analyzeHeapProfile } from "../src/model.js";
import { resolveFunction } from "../src/query.js";
import { buildSummary, formatSummaryText } from "../src/report/summary.js";

/**
 * The last frame is sampled twice: with a single sample, the last-sample-gets-the-median rule
 * (cpu.ts) always yields a median of an empty array, i.e. 0 - no self time at all - so at least
 * two samples of the same leaf are needed for a nonzero, classifiable self time.
 */
function profileWithFrames(frames: { functionName: string; url: string }[]): unknown {
  const nodes = frames.map((frame, id) => ({
    id,
    callFrame: { functionName: frame.functionName, url: frame.url, lineNumber: 0, columnNumber: 0 },
    children: id === 0 ? frames.slice(1).map((_, i) => i + 1) : [],
  }));
  const leafId = frames.length - 1;
  return { nodes, samples: [leafId, leafId], timeDeltas: [0, 100, 100] };
}

test("a pnpm-nested node_modules path resolves to the real package name", () => {
  const json = profileWithFrames([
    { functionName: "(root)", url: "" },
    { functionName: "leaf", url: "file:///project/node_modules/.pnpm/left-pad@1.0.0/node_modules/left-pad/index.js" },
  ]);
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  const fn = [...analysis.functions.values()].find((f) => f.name === "leaf")!;
  assert.equal(fn.area, "left-pad");
});

test("a scoped package keeps its scope in the area name", () => {
  const json = profileWithFrames([
    { functionName: "(root)", url: "" },
    { functionName: "leaf", url: "file:///project/node_modules/@scope/pkg/index.js" },
  ]);
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  const fn = [...analysis.functions.values()].find((f) => f.name === "leaf")!;
  assert.equal(fn.area, "@scope/pkg");
});

// "own" means source the agent can edit, not "under --root": a profiled process routinely loads
// a real file from a sibling checkout, a global install, or anywhere else on disk, and none of
// that is a dependency. --root only shortens the printed path when the file happens to be under
// it; outside --root, the key falls back to the file's own absolute path, unshortened.
test("a real file outside --root is still \"own\", printed with its absolute path", () => {
  const json = profileWithFrames([
    { functionName: "(root)", url: "" },
    { functionName: "leaf", url: "file:///somewhere/else/lib.js" },
  ]);
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  const fn = [...analysis.functions.values()].find((f) => f.name === "leaf")!;
  assert.equal(fn.area, "own");
  assert.equal(fn.key, "leaf /somewhere/else/lib.js:1:1");
});

test("an injected preload is a finderscope frame, not own code", () => {
  const json = profileWithFrames([
    { functionName: "(root)", url: "" },
    { functionName: "sample", url: "file:///tmp/finderscope-abcd/heap-snapshot-preload.cjs" },
  ]);
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  const fn = [...analysis.functions.values()].find((entry) => entry.name === "sample")!;
  assert.equal(fn.area, "finderscope");
  assert.equal(buildSummary(analysis, "profile.cpuprofile").fixCandidates.length, 0);
});

test("do: does not target work reached only through finderscope's injected preload", () => {
  const json = {
    nodes: [
      {
        id: 0,
        callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 },
        children: [1],
      },
      {
        id: 1,
        callFrame: { functionName: "capture", url: "file:///tmp/finderscope-abcd/heap-snapshot-preload.cjs", lineNumber: 0, columnNumber: 0 },
        children: [2],
      },
      {
        id: 2,
        callFrame: { functionName: "writeHeapSnapshot", url: "node:v8", lineNumber: 90, columnNumber: 26 },
        children: [],
      },
    ],
    samples: [2, 2],
    timeDeltas: [0, 100, 100],
  };
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  assert.equal(
    buildSummary(analysis, "profile.cpuprofile").do,
    "finderscope top 'profile.cpuprofile'",
  );
});

test("the breakdown line names an anonymous entry by file and line, and merges entries that print alike", () => {
  // run (own) calls three package functions: an anonymous one, and two distinct functions that
  // share the name "walk". Each gets two samples.
  const frame = (id: number, functionName: string, url: string, lineNumber: number, children: number[]) =>
    ({ id, callFrame: { functionName, url, lineNumber, columnNumber: 0 }, children });
  const json = {
    nodes: [
      frame(0, "(root)", "", 0, [1]),
      frame(1, "run", "file:///project/src/run.js", 0, [2, 3, 4]),
      frame(2, "", "file:///project/node_modules/pkg/lib/core.js", 41, []),
      frame(3, "walk", "file:///project/node_modules/pkg/lib/a.js", 0, []),
      frame(4, "walk", "file:///project/node_modules/pkg/lib/b.js", 0, []),
    ],
    samples: [2, 2, 3, 3, 4, 4],
    timeDeltas: [0, 100, 100, 100, 100, 100, 100],
  };
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  const summary = buildSummary(analysis, "profile.cpuprofile");
  // JSON keeps one entry per function, so every key still round trips.
  assert.equal(summary.fixCandidates[0]!.entries.length, 3);
  const text = formatSummaryText(summary, "profile.cpuprofile");
  const breakdown = text.split("\n").find((line) => line.includes("pkg ") && line.includes("walk"))!;
  assert.match(breakdown, /pkg \(anonymous\) core\.js:42 /);
  assert.equal(breakdown.match(/pkg walk /g)?.length, 1);
});

test("a node: url is area \"node\" regardless of path shape", () => {
  const json = profileWithFrames([
    { functionName: "(root)", url: "" },
    { functionName: "leaf", url: "node:internal/fs/utils" },
  ]);
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  const fn = [...analysis.functions.values()].find((f) => f.name === "leaf")!;
  assert.equal(fn.area, "node");
});

// Regression: a function literally named "constructor" (ordinary in any class-based code) made
// classify()'s special-frame lookup, `SPECIAL_AREAS[functionName]`, resolve through
// Object.prototype to Object.prototype.constructor (the Object function) instead of returning
// undefined - a plain object used as a lookup table always has that prototype chain. The area
// then held a function instead of a string, and formatSummaryText's `a.area.padEnd(20)` crashed
// on the first real profile of any class with a constructor. Every one of these names is a real
// Object.prototype own property, so every one is a shape the old `SPECIAL_AREAS[name]` lookup got
// wrong.
for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
  test(`a function literally named "${name}" is classified as an ordinary "own" function, not a special frame`, () => {
    const json = profileWithFrames([
      { functionName: "(root)", url: "" },
      { functionName: name, url: "file:///project/src/a.js" },
    ]);
    const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
    const fn = [...analysis.functions.values()].find((f) => f.name === name)!;
    assert.equal(typeof fn.area, "string");
    assert.equal(fn.area, "own");

    // The actual crash was here: formatting the summary once the area was corrupted.
    const data = buildSummary(analysis, "profile.cpuprofile");
    assert.doesNotThrow(() => formatSummaryText(data, "profile.cpuprofile"));
  });
}

// Shorter printed positions (own: project-relative; package: package-relative, including the
// package name - a real bare specifier; node: kept full; native: no line/col at all), each
// checked to still round-trip as a <function> argument through query.ts's exact-key match.
test("an \"own\" frame prints a project-relative path", () => {
  const json = profileWithFrames([
    { functionName: "(root)", url: "" },
    { functionName: "check", url: "file:///project/dist/verbs/check.js" },
  ]);
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  const fn = [...analysis.functions.values()].find((f) => f.name === "check")!;
  assert.equal(fn.key, "check dist/verbs/check.js:1:1");
  assert.equal(resolveFunction(analysis, fn.key, "finderscope top 'p'", "/project"), fn);
});

test("a package frame prints the path inside the package, including the package name", () => {
  const json = profileWithFrames([
    { functionName: "(root)", url: "" },
    { functionName: "scan", url: "file:///project/node_modules/typescript/lib/typescript.js" },
  ]);
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  const fn = [...analysis.functions.values()].find((f) => f.name === "scan")!;
  assert.equal(fn.area, "typescript");
  assert.equal(fn.key, "scan typescript/lib/typescript.js:1:1");
  assert.equal(resolveFunction(analysis, fn.key, "finderscope top 'p'", "/project"), fn);
});

test("a node: frame keeps its full node: specifier", () => {
  const json = profileWithFrames([
    { functionName: "(root)", url: "" },
    { functionName: "detectModuleFormat", url: "node:internal/modules/esm/get_format" },
  ]);
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  const fn = [...analysis.functions.values()].find((f) => f.name === "detectModuleFormat")!;
  assert.equal(fn.key, "detectModuleFormat node:internal/modules/esm/get_format:1:1");
  assert.equal(resolveFunction(analysis, fn.key, "finderscope top 'p'", "/project"), fn);
});

// The three frame shapes with no real file at all: an empty url is "native" (a V8 builtin), a
// `wasm:` url is "wasm", and any other nonempty, non-node:, non-file url ("[eval]",
// "evalmachine.<anonymous>", ...) is "eval". None of them is ever "own", checked against a fixed
// root AND against process.cwd() (--root's actual default): the original native-frame bug was
// exactly a placeholder string ("(native)") quietly resolving as "inside" --root only when --root
// happened to equal the running process's own cwd, via node:path's relative() resolving a
// non-absolute second argument against cwd - so a fixed root alone would not have caught it.
const NON_FILE_FRAMES: { label: string; url: string; area: string }[] = [
  { label: "an empty url", url: "", area: "native" },
  { label: "a wasm: url", url: "wasm:/wasm/abc123", area: "wasm" },
  { label: "a [eval] url", url: "[eval]", area: "eval" },
  { label: "an evalmachine url", url: "evalmachine.<anonymous>", area: "eval" },
];

for (const frame of NON_FILE_FRAMES) {
  for (const root of ["/project", process.cwd()]) {
    test(`${frame.label} is area "${frame.area}", never "own" (root: ${root === process.cwd() ? "process.cwd()" : root})`, () => {
      const json = profileWithFrames([
        { functionName: "(root)", url: "" },
        { functionName: "leaf", url: frame.url },
      ]);
      const analysis = analyzeCpuProfile(parseCpuProfile(json), { root });
      const fn = [...analysis.functions.values()].find((f) => f.name === "leaf")!;
      assert.equal(fn.area, frame.area);
      const expectedKey = frame.url === "" ? "leaf (native)" : `leaf ${frame.url}:1:1`;
      assert.equal(fn.key, expectedKey);
      assert.equal(resolveFunction(analysis, fn.key, "finderscope top 'p'", "/project"), fn);
    });
  }
}

// Rebuilt "hottest paths" (model.ts's foldAroundOwnFrames, consumed only by report/summary.ts):
// drop the leading "(root)", show the own frames from the first one reached to the hand-off, then
// exactly one frame of the area handed off to, with any further run of that area collapsed.
test("hottest paths are rebuilt around own frames, dropping (root) and collapsing past the hand-off", () => {
  const json = {
    nodes: [
      { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 }, children: [1] },
      { id: 1, callFrame: { functionName: "check", url: "file:///project/dist/check.js", lineNumber: 0, columnNumber: 0 }, children: [2] },
      {
        id: 2,
        callFrame: { functionName: "scan", url: "file:///project/node_modules/typescript/lib/typescript.js", lineNumber: 0, columnNumber: 0 },
        children: [3],
      },
      {
        id: 3,
        callFrame: { functionName: "scanNext", url: "file:///project/node_modules/typescript/lib/typescript.js", lineNumber: 5, columnNumber: 0 },
        children: [4],
      },
      {
        id: 4,
        callFrame: { functionName: "scanNext2", url: "file:///project/node_modules/typescript/lib/typescript.js", lineNumber: 6, columnNumber: 0 },
        children: [],
      },
    ],
    samples: [4, 4],
    timeDeltas: [0, 100, 100],
  };
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  assert.equal(analysis.hottest.length, 1);
  assert.deepEqual(analysis.hottest[0]!.segments, ["check dist/check.js:1:1", "scan typescript/lib/typescript.js:1:1", "[typescript x2]"]);
});

test("a path with no own frame at all falls back to the ordinary fold, with (root) dropped", () => {
  const json = profileWithFrames([
    { functionName: "(root)", url: "" },
    { functionName: "(idle)", url: "" },
  ]);
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  assert.deepEqual(analysis.hottest[0]!.segments, ["(idle)"]);
});

test("a negative timeDelta is clamped to 0, not allowed to make a sample's time negative", () => {
  const json = {
    nodes: [
      { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
      { id: 1, callFrame: { functionName: "leaf", url: "file:///project/a.js", lineNumber: 0, columnNumber: 0 }, children: [] },
    ],
    samples: [1, 1],
    timeDeltas: [0, -50, 100],
  };
  const profile = parseCpuProfile(json);
  assert.ok(profile.sampleTimes.every((t) => t >= 0));
});

// A mapped source that is itself a URL with a scheme other than file: (webpack://...) - never
// run through relative(), and "own" only when its own text has no node_modules segment.
function withScratchDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-model-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a webpack:// mapped source with no node_modules segment is \"own\", printed as-is", () => {
  withScratchDir((dir) => {
    writeFileSync(join(dir, "bundle.js"), "a();b();\n//# sourceMappingURL=bundle.js.map\n");
    writeFileSync(
      join(dir, "bundle.js.map"),
      JSON.stringify({ version: 3, sources: ["webpack:///./src/thing.ts"], names: [], mappings: "AAAA,EAAC" }),
    );
    const json = {
      nodes: [
        { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
        { id: 1, callFrame: { functionName: "leaf", url: join(dir, "bundle.js"), lineNumber: 0, columnNumber: 0 }, children: [] },
      ],
      samples: [1, 1],
      timeDeltas: [0, 100, 100],
    };
    const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: dir });
    const fn = [...analysis.functions.values()].find((f) => f.name === "leaf")!;
    assert.equal(fn.area, "own");
    assert.equal(fn.key, "leaf webpack:///./src/thing.ts:1:1");
  });
});

test("a webpack:// mapped source with a node_modules segment resolves to the real package", () => {
  withScratchDir((dir) => {
    writeFileSync(join(dir, "bundle.js"), "a();b();\n//# sourceMappingURL=bundle.js.map\n");
    writeFileSync(
      join(dir, "bundle.js.map"),
      JSON.stringify({ version: 3, sources: ["webpack:///./node_modules/leftpad/index.js"], names: [], mappings: "AAAA,EAAC" }),
    );
    const json = {
      nodes: [
        { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
        { id: 1, callFrame: { functionName: "leaf", url: join(dir, "bundle.js"), lineNumber: 0, columnNumber: 0 }, children: [] },
      ],
      samples: [1, 1],
      timeDeltas: [0, 100, 100],
    };
    const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: dir });
    const fn = [...analysis.functions.values()].find((f) => f.name === "leaf")!;
    assert.equal(fn.area, "leftpad");
    assert.equal(fn.key, "leaf webpack:///./node_modules/leftpad/index.js:1:1");
  });
});

// A special frame ((root), (program), (idle), (garbage collector)) is never a valid `do:` target
// - there is no code there to open. Built so (idle) alone holds 100% of self time, well past the
// 20% "point at its callers" threshold that would otherwise fire: do: must skip straight past it
// to the plain top list, not suggest `finderscope callers <profile> "(idle)"`.
test("do: never targets a special frame - an all-idle profile falls back to the plain top list", () => {
  const json = profileWithFrames([
    { functionName: "(root)", url: "" },
    { functionName: "(idle)", url: "" },
  ]);
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  const data = buildSummary(analysis, "profile.cpuprofile");
  assert.equal(data.do, "finderscope top 'profile.cpuprofile'");
});

// The default workflow always opens the first fix candidate. `lines` supplies its own bounded
// fallback when V8 did not record positionTicks, so the summary must not branch on data presence.
test("summary points at the first candidate's lines even when the profile has no positionTicks", () => {
  const json = profileWithFrames([
    { functionName: "(root)", url: "" },
    { functionName: "hot", url: "file:///project/src/a.js" },
  ]);
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  assert.equal(analysis.lineSelfTimes.size, 0, "expected no positionTicks anywhere in this profile");
  const data = buildSummary(analysis, "profile.cpuprofile");
  assert.equal(data.do, "finderscope lines 'profile.cpuprofile' 'hot src/a.js:1:1'");
});

// Heap profiles have no positionTicks. The same stable workflow still applies because `lines`
// reports that limit and falls back without making the printed command invalid.
test("heap summary also points at the first candidate's lines", () => {
  const json = {
    head: {
      id: 0,
      callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 },
      children: [
        {
          id: 1,
          callFrame: { functionName: "alloc", url: "file:///project/src/a.js", lineNumber: 0, columnNumber: 0 },
          selfSize: 1000,
          children: [],
        },
      ],
    },
  };
  const analysis = analyzeHeapProfile(parseHeapProfile(json), { root: "/project" });
  assert.equal(analysis.lineSelfTimes.size, 0);
  const data = buildSummary(analysis, "profile.heapprofile");
  assert.equal(data.do, "finderscope lines 'profile.heapprofile' 'alloc src/a.js:1:1'");
});

test("summary bounds entry detail while JSON keeps full entry keys", () => {
  const names = [
    "firstDependencyFunctionWithAnExcessivelyLongName",
    "secondDependencyFunctionWithAnExcessivelyLongName",
    "thirdDependencyFunctionWithAnExcessivelyLongName",
    "fourthDependencyFunctionWithAnExcessivelyLongName",
  ];
  const json = {
    nodes: [
      { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
      { id: 1, callFrame: { functionName: "candidate", url: "file:///project/src/a.js", lineNumber: 0, columnNumber: 0 }, children: [2, 3, 4, 5] },
      ...names.map((functionName, index) => ({
        id: index + 2,
        callFrame: { functionName, url: `file:///project/node_modules/pkg-${index}/index.js`, lineNumber: 0, columnNumber: 0 },
        children: [],
      })),
    ],
    samples: [2, 3, 4, 5, 2],
    timeDeltas: [0, 1000, 1000, 1000, 1000],
  };
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  const data = buildSummary(analysis, "profile.cpuprofile");
  assert.equal(data.fixCandidates[0]!.entries.length, 3);
  assert.equal(data.fixCandidates[0]!.entriesCut, 1);
  assert.match(data.fixCandidates[0]!.entries[0]!.key, /DependencyFunctionWithAnExcessivelyLongName/);
  const breakdown = formatSummaryText(data, "profile.cpuprofile").split("\n")[4]!;
  assert.ok(breakdown.length <= 120, `breakdown was ${breakdown.length} characters: ${breakdown}`);
  assert.match(breakdown, /…/);
  assert.match(breakdown, /\+1 more/);
});
