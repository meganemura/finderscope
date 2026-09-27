// Example tests for `lines`: exact text and JSON on test/fixtures/lines.cpuprofile (one own
// function, "main", with a real positionTicks array - two lines, tick counts 3 and 1, so the
// tick-to-time apportionment divides evenly with no remainder to distribute, keeping the expected
// numbers easy to verify by hand), and the "no positionTicks at all" case on the existing
// tiny.cpuprofile fixture (no positionTicks at all is a fact about the profile, not an error).
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile } from "../src/model.js";
import { buildLines } from "../src/report/lines.js";

const LINES_FIXTURE = "test/fixtures/lines.cpuprofile";
const NO_TICKS_FIXTURE = "test/fixtures/tiny.cpuprofile";
const ROOT = ["--root", "/project"];

function capture() {
  const out: string[] = [];
  return { io: { stdout: (s: string) => out.push(s), stderr: () => {} }, out };
}

test("lines text: ranked by self time, with path:line and both shares", async () => {
  const { io, out } = capture();
  const code = await main(["lines", LINES_FIXTURE, "main", ...ROOT], io);
  assert.equal(code, 0);
  assert.equal(
    out.join(""),
    `profile: ${LINES_FIXTURE}

finderscope lines "main src/main.js:1:1" (self 0.4ms)

     0.3ms   75.0%   60.0%  src/main.js:2
     0.1ms   25.0%   20.0%  src/main.js:3
note: each row is self time only - V8's positionTicks never carries a call site, so a line that calls a hot function looks cold here; see where a line's time goes with the callees command

callees by source line (name matches, not measured):
  no direct callees

do: finderscope callees '${LINES_FIXTURE}' 'main src/main.js:1:1'
`,
  );
});

test("lines json carries unit and the same numbers as the text", async () => {
  const { io, out } = capture();
  const code = await main(["lines", LINES_FIXTURE, "main", ...ROOT, "--json"], io);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.join("")), {
    metric: "time",
    unit: "us",
    function: "main src/main.js:1:1",
    self: 400,
    total: 500,
    lines: [
      { key: "src/main.js:2", value: 300, selfShare: 0.75, totalShare: 0.6 },
      { key: "src/main.js:3", value: 100, selfShare: 0.25, totalShare: 0.2 },
    ],
    cut: 0,
    calleesBySourceLine: [],
    calleesCut: 0,
    note: "each row is self time only - V8's positionTicks never carries a call site, so a line that calls a hot function looks cold here; see where a line's time goes with the callees command",
    do: `finderscope callees '${LINES_FIXTURE}' 'main src/main.js:1:1'`,
  });
});

// No positionTicks anywhere in the profile is a fact to state, never an error - the command
// still exits 0 and still ends with a runnable do:, falling back to callees.
test("a profile with no positionTicks at all says so and falls back to callees, not an error", async () => {
  const { io, out } = capture();
  const code = await main(["lines", NO_TICKS_FIXTURE, "main", ...ROOT], io);
  assert.equal(code, 0);
  assert.equal(
    out.join(""),
    `profile: ${NO_TICKS_FIXTURE}

finderscope lines "main src/main.js:10:3" (self 1.0ms)

note: this profile has no positionTicks at all - an older Node build, or a .heapprofile, never carries per-line tick data

callees by source line (name matches, not measured):
     2.9ms   65.9%  helper lodash/index.js:15:7
     0.5ms   11.4%  compute src/util.js:4:2
  call sites not found in source for any callee

do: finderscope callees '${NO_TICKS_FIXTURE}' 'main src/main.js:10:3'
`,
  );

  const json = capture();
  await main(["lines", NO_TICKS_FIXTURE, "main", ...ROOT, "--json"], json.io);
  const data = JSON.parse(json.out.join(""));
  assert.equal(data.unit, "us");
  assert.equal(data.lines.length, 0);
  assert.equal(data.cut, 0);
  assert.deepEqual(data.calleesBySourceLine, [
    { key: "helper lodash/index.js:15:7", value: 2900, share: 0.659, nameAppearsOn: [] },
    { key: "compute src/util.js:4:2", value: 500, share: 0.114, nameAppearsOn: [] },
  ]);
  assert.equal(data.calleesCut, 0);
  assert.equal(data.note, "this profile has no positionTicks at all - an older Node build, or a .heapprofile, never carries per-line tick data");
  assert.equal(data.do, `finderscope callees '${NO_TICKS_FIXTURE}' 'main src/main.js:10:3'`);
});

test("an unknown flag on lines is a CliError with a do:", async () => {
  const { io, out } = capture();
  const code = await main(["lines", LINES_FIXTURE, "main", ...ROOT, "--expnad"], io);
  assert.equal(code, 1);
  assert.match(out.join(""), /^error: unknown flag --expnad\ndo: /);
});

// The real query, single-quoted - not the '<function>' placeholder - since the query was already
// in hand before -n was ever parsed.
test("an invalid -n on lines reports a do: with the real function query, not a placeholder", async () => {
  const { io, out } = capture();
  const code = await main(["lines", LINES_FIXTURE, "main", ...ROOT, "-n", "5abc"], io);
  assert.equal(code, 1);
  assert.equal(
    out.join(""),
    `error: invalid -n 5abc\ndo: finderscope lines '${LINES_FIXTURE}' 'main' -n '<positive integer>'\n`,
  );
});

test("callees by source line reports name matches inside the selected function", () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-callee-lines-"));
  const sourcePath = join(dir, "calls.js");
  try {
    writeFileSync(sourcePath, [
      "function caller({ value }) {",
      "  const noop = () => 1;",
      "  helper",
      "    ();",
      "  // helper();",
      "  const text = 'helper()';",
      "  const pattern = /helper(foo)/;",
      "  service.compute ();",
      "  $helper();",
      "  café();",
      "}",
      "function helper() {}",
      "function compute() {}",
      "function $helper() {}",
      "function café() {}",
    ].join("\n"));
    const json = {
      nodes: [
        { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
        { id: 1, callFrame: { functionName: "caller", url: sourcePath, lineNumber: 0, columnNumber: 0 }, children: [2, 3, 4, 5] },
        { id: 2, callFrame: { functionName: "helper", url: sourcePath, lineNumber: 11, columnNumber: 0 }, children: [] },
        { id: 3, callFrame: { functionName: "compute", url: sourcePath, lineNumber: 12, columnNumber: 0 }, children: [] },
        { id: 4, callFrame: { functionName: "$helper", url: sourcePath, lineNumber: 13, columnNumber: 0 }, children: [] },
        { id: 5, callFrame: { functionName: "café", url: sourcePath, lineNumber: 14, columnNumber: 0 }, children: [] },
      ],
      samples: [2, 3, 4, 5],
      timeDeltas: [0, 1000, 1000, 1000, 1000],
    };
    const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: dir });
    const caller = [...analysis.functions.values()].find((fn) => fn.name === "caller")!;
    const data = buildLines(analysis, caller, "profile.cpuprofile");
    assert.deepEqual(data.calleesBySourceLine.map((callee) => ({ name: analysis.functions.get(callee.key)!.name, lines: callee.nameAppearsOn })), [
      { name: "helper", lines: [3] },
      { name: "compute", lines: [8] },
      { name: "$helper", lines: [9] },
      { name: "café", lines: [10] },
    ]);
    assert.equal(data.do, `finderscope callees 'profile.cpuprofile' 'caller calls.js:1:1'`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a destructured expression arrow includes template interpolation but not a later function", () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-arrow-lines-"));
  const sourcePath = join(dir, "arrow.js");
  try {
    writeFileSync(sourcePath, [
      "items.map(({ x }) =>",
      "  x",
      "    ? `${helper(x)}`",
      "    : `${other(x)}`);",
      "function later() {",
      "  helper();",
      "}",
      "function helper() {}",
    ].join("\n"));
    const json = {
      nodes: [
        { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
        { id: 1, callFrame: { functionName: "caller", url: sourcePath, lineNumber: 0, columnNumber: 0 }, children: [2] },
        { id: 2, callFrame: { functionName: "helper", url: sourcePath, lineNumber: 7, columnNumber: 0 }, children: [] },
      ],
      samples: [2, 2],
      timeDeltas: [0, 1000, 1000],
    };
    const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: dir });
    const caller = [...analysis.functions.values()].find((fn) => fn.name === "caller")!;
    assert.deepEqual(buildLines(analysis, caller, "profile.cpuprofile").calleesBySourceLine[0]!.nameAppearsOn, [3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a same-line outer block does not extend the selected arrow's source range", () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-column-range-"));
  const sourcePath = join(dir, "same-line.js");
  try {
    writeFileSync(sourcePath, [
      "if (ready) { const caller = () => {",
      "  helper();",
      "}",
      "helper();",
      "}",
      "function helper() {}",
    ].join("\n"));
    const json = {
      nodes: [
        { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
        { id: 1, callFrame: { functionName: "caller", url: sourcePath, lineNumber: 0, columnNumber: 13 }, children: [2] },
        { id: 2, callFrame: { functionName: "helper", url: sourcePath, lineNumber: 5, columnNumber: 0 }, children: [] },
      ],
      samples: [2, 2],
      timeDeltas: [0, 1000, 1000],
    };
    const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: dir });
    const caller = [...analysis.functions.values()].find((fn) => fn.name === "caller")!;
    assert.deepEqual(buildLines(analysis, caller, "profile.cpuprofile").calleesBySourceLine[0]!.nameAppearsOn, [2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The next own function `do:` suggests must itself be a real contributor (>= 1% of the profile
// total) - "big" holds effectively all of it (self/total ~= 1.0, well past the 20% bar),
// but the only other own function, "tiny", holds under 0.04% - too small to be worth a whole
// extra `lines` round trip, so `do:` falls back to `callees` on "big" itself.
test("do: opens callees for the same function", () => {
  const json = {
    nodes: [
      { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1, 2] },
      {
        id: 1,
        callFrame: { functionName: "big", url: "file:///project/src/big.js", lineNumber: 0, columnNumber: 0 },
        children: [],
        positionTicks: [{ line: 1, ticks: 1 }],
      },
      { id: 2, callFrame: { functionName: "tiny", url: "file:///project/src/tiny.js", lineNumber: 0, columnNumber: 0 }, children: [] },
    ],
    samples: [2, 1, 1, 1],
    timeDeltas: [0, 1, 1000, 1000],
  };
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  const big = [...analysis.functions.values()].find((f) => f.name === "big")!;
  const tiny = [...analysis.functions.values()].find((f) => f.name === "tiny")!;
  assert.ok(tiny.self / analysis.total < 0.01, "expected tiny to hold under 1% of the total");
  const data = buildLines(analysis, big, "profile.cpuprofile");
  assert.equal(data.do, "finderscope callees 'profile.cpuprofile' 'big src/big.js:1:1'");
});
