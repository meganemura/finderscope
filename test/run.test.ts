// Example/regression tests for src/run.ts and cli.ts's "run" case: a missing command and a
// command that does not exist are caller errors with their own `do:`, not "finderscope bug"; "no
// profile written" gets an explicit warning and `do:`; and `run --json` prints one combined
// object, not one JSON blob per profile.
import { test } from "vitest";
import assert from "node:assert/strict";
import { runCommand, RunInputError } from "../src/run.js";
import { main, noProfileWarning } from "../src/cli.js";

function capture() {
  const out: string[] = [];
  return { io: { stdout: (s: string) => out.push(s), stderr: () => {} }, out };
}

test("no command after -- is a RunInputError with its own do:", async () => {
  await assert.rejects(runCommand({ heap: false, heapPeak: false, command: [] }), (e: unknown) => {
    assert.ok(e instanceof RunInputError);
    assert.match(e.message, /no command given/);
    assert.ok(e.do.length > 0);
    return true;
  });
});

test("a command that does not exist (ENOENT) is a RunInputError with its own do:", async () => {
  await assert.rejects(runCommand({ heap: false, heapPeak: false, command: ["finderscope-test-does-not-exist-xyz"] }), (e: unknown) => {
    assert.ok(e instanceof RunInputError);
    assert.match(e.message, /command not found/);
    assert.ok(e.do.length > 0);
    return true;
  });
});

test("cli.ts's `run` attributes a missing command to the caller, not to a finderscope bug", async () => {
  const { io, out } = capture();
  const code = await main(["run", "--"], io);
  assert.equal(code, 1);
  assert.match(out.join(""), /^error: no command given after --\ndo: /);
  assert.doesNotMatch(out.join(""), /finderscope bug/);
});

test("cli.ts's `run` attributes an ENOENT command to the caller, not to a finderscope bug", async () => {
  const { io, out } = capture();
  const code = await main(["run", "--", "finderscope-test-does-not-exist-xyz"], io);
  assert.equal(code, 1);
  assert.match(out.join(""), /^error: command not found: finderscope-test-does-not-exist-xyz\ndo: /);
  assert.doesNotMatch(out.join(""), /finderscope bug/);
});

test("run --json still prints exactly one JSON object, even when no profile was written", async () => {
  // A non-Node command: NODE_OPTIONS is set, but nothing here is Node to read it, so no profile
  // is ever written - the actual "no profile" case, unlike `node -e ...` (which does write one:
  // --cpu-prof is on Node's own NODE_OPTIONS allowlist, confirmed by hand before writing this).
  const { io, out } = capture();
  const code = await main(["run", "--json", "--", "true"], io);
  assert.equal(code, 0);
  assert.equal(out.length, 1, `expected exactly one stdout write, got ${out.length}`);
  const data = JSON.parse(out[0]!);
  assert.equal(typeof data.scratchDir, "string");
  assert.deepEqual(data.profiles, []);
  assert.deepEqual(data.errors, []);
  assert.equal(typeof data.do, "string");
});

test("run --json prints one object with a real profile summary inside, and a real command exit code passes through", async () => {
  const { io, out } = capture();
  const code = await main(["run", "--json", "--", process.execPath, "-e", "process.exitCode = 3"], io);
  assert.equal(code, 3);
  assert.equal(out.length, 1);
  const data = JSON.parse(out[0]!);
  assert.equal(typeof data.scratchDir, "string");
  assert.ok(Array.isArray(data.profiles));
  assert.ok(Array.isArray(data.errors));
  assert.equal(typeof data.do, "string");
});

test("run's text output warns, with a do:, when no profile was written", async () => {
  const { io, out } = capture();
  const code = await main(["run", "--", "true"], io);
  assert.equal(code, 0);
  const text = out.join("");
  assert.match(text, /^scratch dir: .*\(kept on purpose/);
  assert.match(text, /warning: no profile was written/);
  assert.match(text, /\ndo: /);
});

test("run --json's no-profile case carries a warning field with the same text as the text output", async () => {
  const { io, out } = capture();
  const code = await main(["run", "--json", "--", "true"], io);
  assert.equal(code, 0);
  const data = JSON.parse(out[0]!);
  assert.equal(typeof data.warning, "string");
  assert.match(data.warning, /no profile was written/);

  const text = capture();
  await main(["run", "--", "true"], text.io);
  assert.match(text.out.join(""), new RegExp(`warning: ${data.warning.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
});

// noProfileWarning (cli.ts) is checked directly against a known signal, rather than through a
// real child process actually ending via a signal with no profile - confirmed by hand not to be
// reliable to reproduce in this environment: a child self-signaled with SIGKILL immediately after
// starting still had its --cpu-prof profile written, because Node had already flushed something
// to disk in the time before the signal was delivered.
test("noProfileWarning names the signal and says V8 only writes a profile on a normal exit", () => {
  const warning = noProfileWarning("SIGKILL");
  assert.match(warning.message, /no profile was written - the command ended via SIGKILL/);
  assert.match(warning.message, /V8 only writes a --cpu-prof\/--heap-prof file on a normal exit/);
  assert.ok(warning.do.length > 0);
});

test("noProfileWarning's no-signal case asks whether the command even ran node", () => {
  const warning = noProfileWarning(null);
  assert.match(warning.message, /may not have run a Node process at all/);
  assert.ok(warning.do.length > 0);
});

// --heap-peak only adds --heapsnapshot-near-heap-limit when the command ALSO caps the heap
// (--max-old-space-size) - otherwise V8 never approaches a limit at all, so the flag would sit
// there and do nothing; that is reported as a note, not silently ignored.
test("--heap-peak with no heap cap reports a note and writes no snapshot", async () => {
  const result = await runCommand({ heap: false, heapPeak: true, command: [process.execPath, "-e", "1"] });
  assert.deepEqual(result.heapSnapshots, []);
  assert.match(result.heapPeakNote ?? "", /had no --max-old-space-size/);
});

test("--heap-peak with a heap cap adds nothing to report by default (no snapshot without an actual near-limit GC), but no note either", async () => {
  const result = await runCommand({ heap: false, heapPeak: true, command: [process.execPath, "--max-old-space-size=256", "-e", "1"] });
  assert.deepEqual(result.heapSnapshots, []);
  assert.equal(result.heapPeakNote, undefined);
});

test("without --heap-peak, no note and no snapshot regardless of a heap cap", async () => {
  const result = await runCommand({ heap: false, heapPeak: false, command: [process.execPath, "--max-old-space-size=256", "-e", "1"] });
  assert.deepEqual(result.heapSnapshots, []);
  assert.equal(result.heapPeakNote, undefined);
});

test("cli.ts's run --json carries heapSnapshots and, when relevant, heapPeakNote", async () => {
  const { io, out } = capture();
  const code = await main(["run", "--json", "--heap-peak", "--", process.execPath, "-e", "1"], io);
  assert.equal(code, 0);
  const data = JSON.parse(out.join(""));
  assert.ok(Array.isArray(data.heapSnapshots));
  assert.match(data.heapPeakNote, /had no --max-old-space-size/);
});

// The heap cap check also recognizes the underscore spelling (V8's own flag parser treats - and _
// interchangeably) and --max-heap-size, not only the dash form of --max-old-space-size.
test("--heap-peak recognizes --max_old_space_size (underscore) as a real heap cap", async () => {
  const result = await runCommand({ heap: false, heapPeak: true, command: [process.execPath, "--max_old_space_size=256", "-e", "1"] });
  assert.equal(result.heapPeakNote, undefined);
});

test("--heap-peak recognizes --max-heap-size as a real heap cap", async () => {
  const result = await runCommand({ heap: false, heapPeak: true, command: [process.execPath, "--max-heap-size=256", "-e", "1"] });
  assert.equal(result.heapPeakNote, undefined);
});

test("--heap-peak recognizes a heap cap already present in NODE_OPTIONS, not only in argv", async () => {
  const previous = process.env["NODE_OPTIONS"];
  process.env["NODE_OPTIONS"] = "--max-old-space-size=256";
  try {
    const result = await runCommand({ heap: false, heapPeak: true, command: [process.execPath, "-e", "1"] });
    assert.equal(result.heapPeakNote, undefined);
  } finally {
    if (previous === undefined) delete process.env["NODE_OPTIONS"];
    else process.env["NODE_OPTIONS"] = previous;
  }
});

// Regression: after an out-of-memory crash, `run`'s do: must point at the real heap snapshot that
// was actually written, not tell the caller to "rerun without sending it a signal" - nothing
// finderscope did sent that signal, and the crash is not something a rerun changes.
test(
  "after an OOM crash under --heap-peak, do: points at the real snapshot, not 'rerun without a signal'",
  async () => {
    const { io, out } = capture();
    const script = "const a=[];for(let i=0;i<5_000_000;i++)a.push({i,s:'x'.repeat(100)});console.log(a.length);";
    const code = await main(["run", "--heap-peak", "--", process.execPath, "--max-old-space-size=48", "-e", script], io);
    const text = out.join("");
    assert.notEqual(code, 0);
    assert.match(text, /\.heapsnapshot/);
    assert.doesNotMatch(text, /rerun without sending/);
    assert.match(text, /^do: ls -la '.*\.heapsnapshot'$/m);
  },
  30_000,
);
