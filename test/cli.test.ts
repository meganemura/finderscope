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
// 4 own roots (only 3 shown) and, under the heaviest one, 6 distinct node: leaf children (only 5
// shown) - the one fixture in this file wide enough to force a "… N more" cut hint inside "your
// code, top down" itself, both at the root list and inside a root's own tree.
const WIDE_FIXTURE = "test/fixtures/wide.cpuprofile";
// One deep own chain (bigRoot -> step1 -> ... -> step5, one linear path, so all six own functions
// on it share the SAME total) plus one small, shallow own root (smallRoot) with a smaller total -
// the fixture for "--by root" vs. "--area own --by total": the six tied, large totals along the
// deep chain fill every slot of a small -n before smallRoot's own (smaller) total ever gets a
// turn, even though smallRoot is a real, distinct root "your code, top down" always shows.
const DEEP_ROOT_FIXTURE = "test/fixtures/deep-root.cpuprofile";
// One own function ("main") with a real positionTicks array - test/lines.test.ts covers `lines`'s
// exact text/JSON in full; this file only needs its do:/note: lines fed into allOutputs below.
const LINES_FIXTURE = "test/fixtures/lines.cpuprofile";
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

your code, top down:
     4.4ms   81.5%  main src/main.js:10:3
     1.0ms   18.5%    (self)
     2.9ms   53.7%    lodash: helper lodash/index.js:15:7
     0.5ms    9.3%    compute src/util.js:4:2
     0.5ms    9.3%      (self)

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
      unit: "us",
      total: 5400,
      topDown: [
        {
          key: "main src/main.js:10:3",
          area: "own",
          value: 4400,
          share: 0.815,
          isSelf: false,
          children: [
            { key: "(self)", area: "own", value: 1000, share: 0.185, isSelf: true, children: [], childrenCut: 0 },
            { key: "helper lodash/index.js:15:7", area: "lodash", value: 2900, share: 0.537, isSelf: false, children: [], childrenCut: 0 },
            {
              key: "compute src/util.js:4:2",
              area: "own",
              value: 500,
              share: 0.093,
              isSelf: false,
              children: [{ key: "(self)", area: "own", value: 500, share: 0.093, isSelf: true, children: [], childrenCut: 0 }],
              childrenCut: 0,
            },
          ],
          childrenCut: 0,
        },
      ],
      topDownCut: 0,
      areas: [
        { area: "lodash", value: 2900, share: 0.537 },
        { area: "own", value: 1500, share: 0.278 },
        { area: "idle", value: 900, share: 0.167 },
        { area: "program", value: 100, share: 0.019 },
      ],
      topSelf: [
        { key: "helper lodash/index.js:15:7", value: 2900, share: 0.537 },
        { key: "main src/main.js:10:3", value: 1000, share: 0.185 },
        { key: "(idle)", value: 900, share: 0.167 },
        { key: "compute src/util.js:4:2", value: 500, share: 0.093 },
        { key: "(program)", value: 100, share: 0.019 },
      ],
      topSelfCut: 0,
      yourCodeByTotal: [
        { key: "main src/main.js:10:3", value: 4400, share: 0.815 },
        { key: "compute src/util.js:4:2", value: 500, share: 0.093 },
      ],
      yourCodeByTotalCut: 0,
      handoffs: [
        {
          area: "lodash",
          areaShare: 0.537,
          frames: [{ key: "main src/main.js:10:3", share: 0.537 }],
        },
      ],
      paths: [
        { segments: ["main src/main.js:10:3", "helper lodash/index.js:15:7"], value: 2900, share: 0.537 },
        { segments: ["main src/main.js:10:3"], value: 1000, share: 0.185 },
        { segments: ["(idle)"], value: 900, share: 0.167 },
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

your code, top down:
     8.0KB  100.0%  allocateBuffers src/alloc.js:6:4
     2.0KB   25.0%    (self)
     6.0KB   75.0%    leftpad: helperAlloc leftpad/index.js:3:2

areas:
  leftpad                 6.0KB  75.0%
  own                     2.0KB  25.0%

top by self:
     6.0KB   75.0%  helperAlloc leftpad/index.js:3:2
     2.0KB   25.0%  allocateBuffers src/alloc.js:6:4

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

  // Regression target: "your code, top down" is the one section whose "… N more" hints name a
  // node other than the profile's own top-level anchor (a nested node's own key, or - for the root
  // list itself - a different command altogether, `top --by root`). Both must still carry the
  // REAL profile path, single-quoted, not a bare "<profile>" placeholder - this fixture is wide
  // enough (4 own roots, 6 leaf children under the heaviest) to force a cut at both the root list
  // and inside a root's own tree in the same run.
  test("top-down's own \"… N more\" hints carry the real profile path and a real node key", async () => {
    const { io, out } = capture();
    const code = await main([WIDE_FIXTURE, ...ROOT], io);
    assert.equal(code, 0);
    const text = out.join("");
    assert.ok(
      text.includes(`… 1 more (finderscope callees '${WIDE_FIXTURE}' 'ownA src/a.js:1:1' -n 6)`),
      `expected the nested cut hint to name the real profile path and node key, got:\n${text}`,
    );
    assert.ok(
      text.includes(`… 1 more (finderscope top '${WIDE_FIXTURE}' --by root -n 4)`),
      `expected the root-list cut hint to name the real profile path, got:\n${text}`,
    );
    assert.doesNotMatch(text, /<profile>|<function>/);
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

do: finderscope callers '${CPU_FIXTURE}' 'helper lodash/index.js:15:7'
`,
    );

    const json = capture();
    await main(["top", CPU_FIXTURE, ...ROOT, "--json"], json.io);
    const data = JSON.parse(json.out.join(""));
    assert.equal(data.unit, "us");
    assert.equal(data.by, "self");
    assert.equal(data.cut, 0);
    assert.equal(data.do, `finderscope callers '${CPU_FIXTURE}' 'helper lodash/index.js:15:7'`);
    assert.deepEqual(
      data.entries.map((e: { key: string }) => e.key),
      ["helper lodash/index.js:15:7", "main src/main.js:10:3", "(idle)", "compute src/util.js:4:2", "(program)"],
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

  test("--by root ranks top-down's own roots; --area own --by total can hide a small one behind a deep tied chain", async () => {
    const byTotal = capture();
    const codeByTotal = await main(["top", DEEP_ROOT_FIXTURE, ...ROOT, "--area", "own", "--by", "total", "-n", "3", "--json"], byTotal.io);
    assert.equal(codeByTotal, 0);
    const byTotalData = JSON.parse(byTotal.out.join(""));
    const byTotalKeys = byTotalData.entries.map((e: { key: string }) => e.key);
    assert.equal(byTotalKeys.length, 3);
    assert.ok(
      byTotalKeys.every((k: string) => k.startsWith("step")),
      `expected --area own --by total -n 3 to fill up on the deep chain's tied totals alone, got: ${byTotalKeys.join(", ")}`,
    );
    assert.ok(!byTotalKeys.some((k: string) => k.startsWith("smallRoot")), "smallRoot should be hidden behind the deep chain here");

    const byRoot = capture();
    const codeByRoot = await main(["top", DEEP_ROOT_FIXTURE, ...ROOT, "--by", "root", "--json"], byRoot.io);
    assert.equal(codeByRoot, 0);
    const byRootData = JSON.parse(byRoot.out.join(""));
    assert.equal(byRootData.unit, "us");
    assert.equal(byRootData.cut, 0);
    assert.deepEqual(byRootData.entries, [
      { key: "bigRoot src/big.js:1:1", area: "own", value: 500, share: 0.833 },
      { key: "smallRoot src/small.js:1:1", area: "own", value: 100, share: 0.167 },
    ]);
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
      unit: "us",
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

describe("finderscope lines", () => {
  // Full exact text/JSON coverage lives in test/lines.test.ts; this only needs to feed the new
  // verb's do:/note: lines into allOutputs so the sh -n check at the bottom of this file covers it.
  test("text and json both end with a runnable do:", async () => {
    const text = capture();
    const code = await main(["lines", LINES_FIXTURE, "main", ...ROOT], text.io);
    assert.equal(code, 0);
    assert.match(text.out.join(""), /\ndo: finderscope callees /);

    const json = capture();
    await main(["lines", LINES_FIXTURE, "main", ...ROOT, "--json"], json.io);
    const data = JSON.parse(json.out.join(""));
    assert.equal(data.unit, "us");
    assert.equal(data.lines.length, 2);
  });

  test("no positionTicks at all: a note:, not an error, still ends with do:", async () => {
    const { io, out } = capture();
    const code = await main(["lines", CPU_FIXTURE, "main", ...ROOT], io);
    assert.equal(code, 0);
    assert.match(out.join(""), /^note: /m);
    assert.match(out.join(""), /\ndo: finderscope callees /);
  });
});

// This describe block runs last (vitest runs a file's own tests in declaration order), after
// every test above has pushed its own stdout into allOutputs - so by the time this runs, it has
// every `do:` line AND every "… N more" cut-hint command this whole file produced, text and JSON
// alike, with no second, separately maintained list of commands to keep in sync by hand. Every
// one of these strings is a command an agent is expected to copy and run as-is, so each must both
// parse under `sh` and actually be runnable: no unresolved "<profile>"/"<function>" placeholder
// left in place of a real value the command already had in hand.
describe("every do: and \"… N more\" command this file produced parses and is runnable as-is", () => {
  test("sh -n -c reports no syntax error, and none of them still carries a <placeholder>", () => {
    assert.ok(allOutputs.length > 0, "allOutputs is empty - did the tests above run first?");

    const commands = new Set<string>();
    for (const output of allOutputs) {
      // Text output: a line starting with "do: ", or a "… N more (<command>)" cut hint - both
      // `finderscope`'s own summary/topDown/top/callers/callees renderers and `run`'s per-profile
      // text blocks print these. JSON output: a top-level "do" field (JSON has no cut-hint command
      // string of its own - a cut is a plain integer field there, e.g. "topDownCut").
      for (const match of output.matchAll(/^do: (.+)$/gm)) {
        commands.add(match[1]!);
      }
      for (const match of output.matchAll(/… \d+ more \((.+)\)$/gm)) {
        commands.add(match[1]!);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        continue;
      }
      if (parsed !== null && typeof parsed === "object" && "do" in parsed && typeof (parsed as { do: unknown }).do === "string") {
        commands.add((parsed as { do: string }).do);
      }
    }
    assert.ok(commands.size > 0, "found no do:/… more commands at all among allOutputs - the extraction above is broken");

    for (const command of commands) {
      const result = spawnSync("sh", ["-n", "-c", command]);
      assert.equal(result.status, 0, `sh -n -c reported a syntax error for: ${command}\n${result.stderr.toString()}`);
      // Only a real "finderscope <subcommand> ..." command is checked for a leftover
      // <placeholder>: it is always built from data the code already had in hand (a profile path,
      // a resolved function key), so "<profile>"/"<function>" there means a real value was dropped
      // on the floor. The bare USAGE string (this file's own "no arguments at all" test) legitimately
      // uses "<profile>"/"<fn>" - there is no profile at all yet for it to name, and it starts with
      // "usage: ", not "finderscope ", so this filter leaves it alone.
      if (command.startsWith("finderscope ")) {
        assert.doesNotMatch(
          command,
          /<[a-zA-Z][\w-]*>/,
          `command still carries an unresolved <placeholder> instead of the real value it had in hand: ${command}`,
        );
      }
    }
  });
});
