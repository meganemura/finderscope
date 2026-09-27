// Example tests: exact text and JSON shape for each command, on small hand-written fixtures
// (test/fixtures/tiny.cpuprofile, tiny-after.cpuprofile, tiny.heapprofile). Every expected string
// below was captured from a real run of this same code and re-verified by hand against the
// fixture files' own node ids, samples, and timeDeltas, not guessed.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { main } from "../src/cli.js";

const CPU_FIXTURE = "test/fixtures/tiny.cpuprofile";
const CPU_AFTER_FIXTURE = "test/fixtures/tiny-after.cpuprofile";
const HEAP_FIXTURE = "test/fixtures/tiny.heapprofile";
const ROOT = ["--root", "/project"];

// Every stdout write from every capture() in this file lands here too, so one final test (at the
// bottom, run last within this file - vitest runs a file's own tests in declaration order) can
// check every `do:`/`note:` line this whole file produced, without hand-listing them a second
// time somewhere else.
const allOutputs: string[] = [];

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (s: string) => {
        out.push(s);
        allOutputs.push(s);
      },
      stderr: (s: string) => err.push(s),
    },
    out,
    err,
  };
}

describe("finderscope summary", () => {
  test("text", async () => {
    const { io, out } = capture();
    const code = await main([CPU_FIXTURE, ...ROOT], io);
    assert.equal(code, 0);
    assert.equal(
      out.join(""),
      `profile: ${CPU_FIXTURE}

finderscope summary (time, total 5.4ms)

areas:
  lodash                  2.9ms  53.7%
  own                     1.5ms  27.8%
  idle                    0.9ms  16.7%
  program                 0.1ms  1.9%

top by self:
     2.9ms   53.7%  helper lodash/index.js:15:7
     1.0ms   18.5%  main src/main.js:10:3
     0.9ms   16.7%  (idle)
     0.5ms    9.3%  compute src/util.js:4:2
     0.1ms    1.9%  (program)
     0.0ms    0.0%  (root)

your code by total:
     4.4ms   81.5%  main src/main.js:10:3
     0.5ms    9.3%  compute src/util.js:4:2

where your code hands off:
  lodash 53.7% <- main src/main.js:10:3 (53.7%)

hottest paths:
     2.9ms   53.7%  main src/main.js:10:3 -> helper lodash/index.js:15:7
     1.0ms   18.5%  main src/main.js:10:3
     0.9ms   16.7%  (idle)

do: finderscope callees '${CPU_FIXTURE}' 'main src/main.js:10:3'
`,
    );
  });

  test("json", async () => {
    const { io, out } = capture();
    const code = await main([CPU_FIXTURE, ...ROOT, "--json"], io);
    assert.equal(code, 0);
    const data = JSON.parse(out.join(""));
    assert.deepEqual(data, {
      metric: "time",
      total: 5400,
      areas: [
        { area: "lodash", value: 2900, share: 2900 / 5400 },
        { area: "own", value: 1500, share: 1500 / 5400 },
        { area: "idle", value: 900, share: 900 / 5400 },
        { area: "program", value: 100, share: 100 / 5400 },
      ],
      topSelf: [
        { key: "helper lodash/index.js:15:7", value: 2900, share: 2900 / 5400 },
        { key: "main src/main.js:10:3", value: 1000, share: 1000 / 5400 },
        { key: "(idle)", value: 900, share: 900 / 5400 },
        { key: "compute src/util.js:4:2", value: 500, share: 500 / 5400 },
        { key: "(program)", value: 100, share: 100 / 5400 },
        { key: "(root)", value: 0, share: 0 },
      ],
      topSelfCut: 0,
      yourCodeByTotal: [
        { key: "main src/main.js:10:3", value: 4400, share: 4400 / 5400 },
        { key: "compute src/util.js:4:2", value: 500, share: 500 / 5400 },
      ],
      yourCodeByTotalCut: 0,
      handoffs: [
        {
          area: "lodash",
          areaShare: 2900 / 5400,
          frames: [{ key: "main src/main.js:10:3", share: 2900 / 5400 }],
        },
      ],
      paths: [
        { segments: ["main src/main.js:10:3", "helper lodash/index.js:15:7"], value: 2900, share: 2900 / 5400 },
        { segments: ["main src/main.js:10:3"], value: 1000, share: 1000 / 5400 },
        { segments: ["(idle)"], value: 900, share: 900 / 5400 },
      ],
      do: `finderscope callees '${CPU_FIXTURE}' 'main src/main.js:10:3'`,
    });
  });

  test("heap profile text (still-live-at-exit wording, full key in hand-offs, peak-measurement do:)", async () => {
    const { io, out } = capture();
    const code = await main([HEAP_FIXTURE, ...ROOT], io);
    assert.equal(code, 0);
    assert.equal(
      out.join(""),
      `profile: ${HEAP_FIXTURE}

finderscope summary (bytes, total 8.0KB still live when the process exited - not the peak)

areas:
  leftpad                 6.0KB  75.0%
  own                     2.0KB  25.0%

top by self:
     6.0KB   75.0%  helperAlloc leftpad/index.js:3:2
     2.0KB   25.0%  allocateBuffers src/alloc.js:6:4
        0B    0.0%  (root)

your code by total:
     8.0KB  100.0%  allocateBuffers src/alloc.js:6:4

where your code hands off:
  leftpad 75.0% <- allocateBuffers src/alloc.js:6:4 (75.0%)

hottest paths:
     6.0KB   75.0%  allocateBuffers src/alloc.js:6:4 -> helperAlloc leftpad/index.js:3:2
     2.0KB   25.0%  allocateBuffers src/alloc.js:6:4

note: for peak memory instead of what was still live at exit, use /usr/bin/time -l <command> (macOS) or --heapsnapshot-near-heap-limit
do: finderscope callees '${HEAP_FIXTURE}' 'allocateBuffers src/alloc.js:6:4'
`,
    );
  });

  test("heap profile JSON carries the peak-memory caveat as its own note field, separate from a pure-command do", async () => {
    const { io, out } = capture();
    const code = await main([HEAP_FIXTURE, ...ROOT, "--json"], io);
    assert.equal(code, 0);
    const data = JSON.parse(out.join(""));
    assert.equal(
      data.note,
      "for peak memory instead of what was still live at exit, use /usr/bin/time -l <command> (macOS) or --heapsnapshot-near-heap-limit",
    );
    assert.equal(data.do, `finderscope callees '${HEAP_FIXTURE}' 'allocateBuffers src/alloc.js:6:4'`);
  });
});

describe("finderscope top", () => {
  test("text and json agree on the same ranking, and text ends with do:", async () => {
    const text = capture();
    await main(["top", CPU_FIXTURE, ...ROOT], text.io);
    assert.equal(
      text.out.join(""),
      `profile: ${CPU_FIXTURE}

finderscope top (by self, total 5.4ms)

     2.9ms   53.7%  lodash       helper lodash/index.js:15:7
     1.0ms   18.5%  own          main src/main.js:10:3
     0.9ms   16.7%  idle         (idle)
     0.5ms    9.3%  own          compute src/util.js:4:2
     0.1ms    1.9%  program      (program)
     0.0ms    0.0%  program      (root)

do: finderscope callers '${CPU_FIXTURE}' 'helper lodash/index.js:15:7'
`,
    );

    const json = capture();
    await main(["top", CPU_FIXTURE, ...ROOT, "--json"], json.io);
    const data = JSON.parse(json.out.join(""));
    assert.equal(data.by, "self");
    assert.equal(data.cut, 0);
    assert.equal(data.do, `finderscope callers '${CPU_FIXTURE}' 'helper lodash/index.js:15:7'`);
    assert.deepEqual(
      data.entries.map((e: { key: string }) => e.key),
      ["helper lodash/index.js:15:7", "main src/main.js:10:3", "(idle)", "compute src/util.js:4:2", "(program)", "(root)"],
    );
  });

  test("--area filters to one package", async () => {
    const { io, out } = capture();
    const code = await main(["top", CPU_FIXTURE, ...ROOT, "--area", "lodash", "--json"], io);
    assert.equal(code, 0);
    const data = JSON.parse(out.join(""));
    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0].key, "helper lodash/index.js:15:7");
  });

  test("an unknown flag is a CliError with a do:", async () => {
    const { io, out } = capture();
    const code = await main(["top", CPU_FIXTURE, ...ROOT, "--ara", "lodash"], io);
    assert.equal(code, 1);
    assert.match(out.join(""), /^error: unknown flag --ara\ndo: /);
  });

  test("a non-integer -n is a CliError with a do:", async () => {
    const { io, out } = capture();
    const code = await main(["top", CPU_FIXTURE, ...ROOT, "-n", "5abc"], io);
    assert.equal(code, 1);
    assert.match(out.join(""), /^error: invalid -n 5abc\ndo: /);
  });
});

describe("finderscope callers / callees", () => {
  test("callers text (tree, not distinct paths; ends with do:)", async () => {
    const { io, out } = capture();
    const code = await main(["callers", CPU_FIXTURE, "helper", ...ROOT], io);
    assert.equal(code, 0);
    assert.equal(
      out.join(""),
      `profile: ${CPU_FIXTURE}

finderscope callers "helper lodash/index.js:15:7" (total 2.9ms)

     2.9ms  100.0%  main src/main.js:10:3
     2.9ms  100.0%    program: (root)

do: finderscope callers '${CPU_FIXTURE}' 'main src/main.js:10:3'
`,
    );
  });

  test("callees text (the default tree, merged by key, not distinct paths)", async () => {
    const { io, out } = capture();
    const code = await main(["callees", CPU_FIXTURE, "main", ...ROOT], io);
    assert.equal(code, 0);
    assert.equal(
      out.join(""),
      `profile: ${CPU_FIXTURE}

finderscope callees "main src/main.js:10:3" (total 4.4ms)

     1.0ms   22.7%  (self)
     2.9ms   65.9%  lodash: helper lodash/index.js:15:7
     0.5ms   11.4%  compute src/util.js:4:2
     0.5ms   11.4%    (self)

do: finderscope callees '${CPU_FIXTURE}' 'compute src/util.js:4:2'
`,
    );
  });

  test("callees --paths falls back to the flat per-path list, and still ends with do:", async () => {
    const { io, out } = capture();
    const code = await main(["callees", CPU_FIXTURE, "main", ...ROOT, "--paths"], io);
    assert.equal(code, 0);
    assert.equal(
      out.join(""),
      `profile: ${CPU_FIXTURE}

finderscope callees "main src/main.js:10:3" --paths (total 4.4ms)

     2.9ms   65.9%  main src/main.js:10:3 -> helper lodash/index.js:15:7
     1.0ms   22.7%  main src/main.js:10:3
     0.5ms   11.4%  main src/main.js:10:3 -> compute src/util.js:4:2

do: finderscope callees '${CPU_FIXTURE}' 'main src/main.js:10:3'
`,
    );
  });

  test("an unresolvable function name reports candidates and exits 1", async () => {
    const { io, out } = capture();
    const code = await main(["callers", CPU_FIXTURE, "zzz", ...ROOT, "--json"], io);
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(out.join("")), {
      error: 'no function matches "zzz"; the do: command lists the function keys',
      do: `finderscope top '${CPU_FIXTURE}'`,
    });
  });

  test("an unknown flag on callees is a CliError with a do:", async () => {
    const { io, out } = capture();
    const code = await main(["callees", CPU_FIXTURE, "main", ...ROOT, "--expnad"], io);
    assert.equal(code, 1);
    assert.match(out.join(""), /^error: unknown flag --expnad\ndo: /);
  });
});

describe("finderscope diff", () => {
  test("text shows the biggest share changes and ends with do:", async () => {
    const { io, out } = capture();
    const code = await main(["diff", CPU_FIXTURE, CPU_AFTER_FIXTURE, ...ROOT], io);
    assert.equal(code, 0);
    assert.equal(
      out.join(""),
      `finderscope diff ${CPU_FIXTURE} ${CPU_AFTER_FIXTURE} (time)

areas:
   +11.9%  53.7% -> 65.6%  lodash
    -9.7%  27.8% -> 18.0%  own
    -1.9%  16.7% -> 14.8%  idle
    -0.2%  1.9% -> 1.6%  program

functions:
   +11.9%  53.7% -> 65.6%  helper lodash/index.js:15:7
    +5.5%  9.3% -> 14.8%  compute src/util.js:4:2
    +2.1%  81.5% -> 83.6%  main src/main.js:10:3
    -1.9%  16.7% -> 14.8%  (idle)
    -0.2%  1.9% -> 1.6%  (program)

do: finderscope callees '${CPU_AFTER_FIXTURE}' 'helper lodash/index.js:15:7'
`,
    );
  });

  test("a profile diffed against itself reports no change, and still ends with do:", async () => {
    const { io, out } = capture();
    const code = await main(["diff", CPU_FIXTURE, CPU_FIXTURE, ...ROOT], io);
    assert.equal(code, 0);
    assert.equal(
      out.join(""),
      `finderscope diff ${CPU_FIXTURE} ${CPU_FIXTURE} (time)\n\nno change\n\ndo: finderscope top '${CPU_FIXTURE}'\n`,
    );

    const json = capture();
    await main(["diff", CPU_FIXTURE, CPU_FIXTURE, ...ROOT, "--json"], json.io);
    assert.deepEqual(JSON.parse(json.out.join("")), {
      metric: "time",
      functions: [],
      functionsCut: 0,
      areas: [],
      areasCut: 0,
      do: `finderscope top '${CPU_FIXTURE}'`,
    });
  });
});

describe("errors", () => {
  test("a missing profile file reports error/do, text and json", async () => {
    const text = capture();
    const code = await main(["test/fixtures/does-not-exist.cpuprofile"], text.io);
    assert.equal(code, 1);
    assert.equal(
      text.out.join(""),
      "error: cannot read profile file test/fixtures/does-not-exist.cpuprofile\ndo: check the path: ls 'test/fixtures/does-not-exist.cpuprofile'\n",
    );

    const json = capture();
    await main(["test/fixtures/does-not-exist.cpuprofile", "--json"], json.io);
    assert.deepEqual(JSON.parse(json.out.join("")), {
      error: "cannot read profile file test/fixtures/does-not-exist.cpuprofile",
      do: "check the path: ls 'test/fixtures/does-not-exist.cpuprofile'",
    });
  });

  test("no arguments at all reports usage", async () => {
    const { io, out } = capture();
    const code = await main([], io);
    assert.equal(code, 1);
    assert.match(out.join(""), /^error: no command or profile given\ndo: usage: finderscope/);
  });

  test("a malformed profile file (a real caller mistake) is not blamed on finderscope", async () => {
    const { io, out } = capture();
    const code = await main(["test/fixtures/empty.cpuprofile"], io);
    assert.equal(code, 1);
    assert.equal(
      out.join(""),
      "error: cpuprofile has no nodes\ndo: open 'test/fixtures/empty.cpuprofile' and check its nodes/samples/timeDeltas, or its head, shape\n",
    );
  });

  // Regression: buildDiff's own metric-mismatch check (mixing a .cpuprofile with a .heapprofile,
  // a real caller mistake) used to throw a plain Error with "\ndo:" folded into its message text.
  // Once cli.ts started wrapping every unexpected error as a "finderscope bug" (to fix the
  // padEnd crash below), that plain Error had no `do` field of its own to be recognized by, so it
  // was caught as "unexpected" too and printed as a *second*, misattributed "finderscope bug" do
  // line under the real one. report/diff.ts's DiffInputError (a real class with its own `do`
  // field) is the fix; this checks the caller-facing message survives as the *only* do line.
  test("mixing a .cpuprofile and a .heapprofile in diff is reported once, as the caller's mistake", async () => {
    const { io, out } = capture();
    const code = await main(["diff", CPU_FIXTURE, HEAP_FIXTURE, ...ROOT], io);
    assert.equal(code, 1);
    assert.equal(
      out.join(""),
      "error: cannot diff a time profile against a bytes profile\ndo: pass two .cpuprofile files or two .heapprofile files\n",
    );
  });
});

// This describe block runs last (vitest runs a file's own tests in declaration order), after
// every test above has pushed its own stdout into allOutputs - so by the time this runs, it has
// every `do:` line every example test in this file produced, text and JSON alike, with no second,
// separately maintained list of commands to keep in sync by hand.
describe("every do: line this file produced parses as a real shell command", () => {
  test("sh -n -c reports no syntax error for any of them", () => {
    assert.ok(allOutputs.length > 0, "allOutputs is empty - did the tests above run first?");

    const doLines = new Set<string>();
    for (const output of allOutputs) {
      // Text output: a line starting with "do: ". JSON output: a top-level "do" field.
      for (const match of output.matchAll(/^do: (.+)$/gm)) {
        doLines.add(match[1]!);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        continue;
      }
      if (parsed !== null && typeof parsed === "object" && "do" in parsed && typeof (parsed as { do: unknown }).do === "string") {
        doLines.add((parsed as { do: string }).do);
      }
    }
    assert.ok(doLines.size > 0, "found no do: lines at all among allOutputs - the extraction above is broken");

    for (const line of doLines) {
      const result = spawnSync("sh", ["-n", "-c", line]);
      assert.equal(result.status, 0, `sh -n -c reported a syntax error for do: line: ${line}\n${result.stderr.toString()}`);
    }
  });
});
