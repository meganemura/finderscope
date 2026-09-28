// Example/regression tests for src/run.ts and cli.ts's "run" case: a missing command and a
// command that does not exist are caller errors with their own `do:`, not "finderscope bug"; "no
// profile written" gets an explicit warning and `do:`; and `run --json` prints one combined
// object, not one JSON blob per profile.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteForNodeOptions, runCommand, RunInputError } from "../src/run.js";
import { main, noProfileWarning } from "../src/cli.js";
import { formatValue, shQuote } from "../src/report/summary.js";

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

test("run captures bounded child tails and writes the JSON report", async () => {
  const { io, out } = capture();
  const script = "for(let i=0;i<12;i++)console.log('line-'+i+'-'+ 'x'.repeat(240)); console.error('problem')";
  assert.equal(await main(["run", "--json", "--", process.execPath, "-e", script], io), 0);
  const data = JSON.parse(out.join(""));
  assert.equal(data.child.exitCode, 0);
  assert.equal(data.child.stdout.tail.length, 10);
  assert.equal(data.child.stdout.tail[0].startsWith("line-2-"), true);
  assert.ok(data.child.stdout.tail.every((line: string) => line.length <= 200));
  assert.deepEqual(data.child.stderr.tail, ["problem"]);
  assert.equal(readFileSync(data.report, "utf8").includes('"profiles"'), true);
  assert.equal(readFileSync(data.child.stdout.path, "utf8").includes("line-0-"), true);
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

test("--heap-snapshot replaces the earlier snapshot as heapUsed reaches a larger peak", async () => {
  const script = `
const held = [];
const grow = (from, count) => { for (let i = from; i < from + count; i++) held.push({ i, text: "held-" + i + "-" + "x".repeat(48) }); };
grow(0, 30000);
setTimeout(() => {
  grow(30000, 30000);
  setTimeout(() => {
    held.length = 100;
    setTimeout(() => {}, 100);
  }, 250);
}, 250);
`;
  const { io, out } = capture();
  assert.equal(await main([
    "run", "--json", "--heap-snapshot", "--heap-snapshot-threshold", "10", "--heap-snapshot-min", "1", "--",
    process.execPath, "-e", script,
  ], io), 0);
  const result = JSON.parse(out.join(""));
  assert.equal(result.heapSnapshots.length, 1);
  assert.match(result.heapSnapshots[0], /heap-peak-\d+-0-[0-9a-f]{8}\.heapsnapshot$/);
  assert.ok(result.profiles.some((profile: { metric?: unknown }) => profile.metric === "heap-snapshot"));
  assert.ok(result.heapSnapshotCaptures.length >= 2, `expected at least two captures, got ${result.heapSnapshotCaptures.length}`);
  assert.ok(result.heapSnapshotCaptures.at(-1).heapUsed > result.heapSnapshotCaptures[0].heapUsed);
  assert.equal(result.heapSnapshotStats.snapshotsWritten, result.heapSnapshotCaptures.length);
  assert.ok(result.heapSnapshotStats.cpuTimeUs > 0);
  const snapshotCount = result.heapSnapshotStats.snapshotsWritten;
  assert.equal(
    result.heapSnapshotNote,
    `${snapshotCount} heap ${snapshotCount === 1 ? "snapshot" : "snapshots"} written; snapshot writing used ${formatValue("time", result.heapSnapshotStats.cpuTimeUs)} CPU time and can need about the heap size in extra memory`,
  );
}, 60_000);

test("--heap-snapshot reports a sampled peak and a lower-floor rerun when no snapshot qualifies", async () => {
  const { io, out } = capture();
  assert.equal(await main([
    "run", "--json", "--heap-snapshot", "--heap-snapshot-min", "64", "--",
    process.execPath, "-e", "setTimeout(() => {}, 30)",
  ], io), 0);
  const result = JSON.parse(out.join(""));
  assert.equal(result.heapSnapshots.length, 0);
  assert.equal(result.heapSnapshotStats.snapshotsWritten, 0);
  assert.ok(result.heapSnapshotStats.peakHeapUsed > 0);
  assert.equal(
    result.heapSnapshotNote,
    `0 heap snapshots written; snapshot writing used ${formatValue("time", result.heapSnapshotStats.cpuTimeUs)} CPU time; no snapshot qualified; peak heapUsed ${formatValue("bytes", result.heapSnapshotStats.peakHeapUsed)}; minimum growth was 64MB`,
  );
  const observedGrowthMb = result.heapSnapshotStats.maxGrowth / (1024 * 1024);
  const lowerFloor = Math.min(32, observedGrowthMb || 32);
  assert.equal(
    result.do,
    `finderscope run --heap-snapshot --heap-snapshot-min ${lowerFloor} --json -- ${shQuote(process.execPath)} ${shQuote("-e")} ${shQuote("setTimeout(() => {}, 30)")}`,
  );

  const text = capture();
  assert.equal(await main([
    "run", "--heap-snapshot", "--heap-snapshot-min", "64", "--",
    process.execPath, "-e", "setTimeout(() => {}, 30)",
  ], text.io), 0);
  assert.match(text.out.join(""), /note: 0 heap snapshots written; snapshot writing used .* CPU time; no snapshot qualified; peak heapUsed .*; minimum growth was 64MB/);
  assert.match(text.out.join(""), /do: finderscope run --heap-snapshot --heap-snapshot-min [\d.]+ -- /);
});

test("--heap-snapshot checks a synchronous heap peak again during process exit", async () => {
  const script = `
globalThis.held = Array.from({ length: 150000 }, (_, i) => ({ i, text: "held-" + i + "-" + "x".repeat(48) }));
`;
  const result = await runCommand({
    heap: false,
    heapPeak: false,
    heapSnapshot: true,
    heapSnapshotMinMb: 1,
    heapSnapshotThreshold: 1,
    command: [process.execPath, "-e", script],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.heapSnapshots.length, 1);
  assert.equal(result.heapSnapshotStats?.snapshotsWritten, 1);
}, 60_000);

test("--heap-snapshot says so when the captured heap was mostly garbage by the time it was written", async () => {
  // The array is garbage once the function returns, but heapUsed at exit still counts it. The snapshot
  // is written after a full GC, so it holds almost none of it.
  const script = `
(function () { const dropped = new Array(8000000).fill(1.5); return dropped.length; })();
`;
  const { io, out } = capture();
  assert.equal(await main([
    "run", "--json", "--heap-snapshot", "--heap-snapshot-min", "1", "--heap-snapshot-threshold", "1", "--",
    process.execPath, "-e", script,
  ], io), 0);
  const result = JSON.parse(out.join(""));
  assert.equal(result.heapSnapshotStats.snapshotsWritten, 1);
  const kept = result.heapSnapshotCaptures[0];
  assert.ok(kept.liveAfter < kept.heapUsed / 2, `live ${kept.liveAfter} vs heapUsed ${kept.heapUsed}`);
  assert.match(
    result.heapSnapshotGarbageNote,
    /^the snapshot holds about .* of live objects, but heapUsed was .* at capture; the rest was already garbage, so the peak's retainers may be gone; find the peak time with finderscope run --heap-peak, then call v8\.writeHeapSnapshot\(\) at that point in the program$/,
  );
}, 60_000);

test("--heap-snapshot adds no garbage note when the snapshot holds the captured heap", async () => {
  const script = `
globalThis.held = Array.from({ length: 150000 }, (_, i) => ({ i, text: "held-" + i + "-" + "x".repeat(48) }));
`;
  const { io, out } = capture();
  assert.equal(await main([
    "run", "--json", "--heap-snapshot", "--heap-snapshot-min", "1", "--heap-snapshot-threshold", "1", "--",
    process.execPath, "-e", script,
  ], io), 0);
  const result = JSON.parse(out.join(""));
  assert.equal(result.heapSnapshotGarbageNote, undefined);
}, 60_000);

test("--heap-snapshot reports a sampler gap caused by synchronous work", async () => {
  const { io, out } = capture();
  assert.equal(await main([
    "run", "--json", "--heap-snapshot", "--heap-snapshot-min", "1024", "--",
    process.execPath, "-e", "const end = Date.now() + 2000; while (Date.now() < end) {}",
  ], io), 0);
  const result = JSON.parse(out.join(""));
  assert.ok(result.heapSnapshotStats.maxSamplerGapMs >= 1900, `gap was ${result.heapSnapshotStats.maxSamplerGapMs}ms`);
  assert.match(
    result.heapSnapshotGapNote,
    /^the heap sampler could not run for .* at a time because synchronous work blocked it; a peak inside that stretch may be missed; find the peak time with finderscope run --heap-peak, then call v8\.writeHeapSnapshot\(\) at that point in the program$/,
  );

  const text = capture();
  assert.equal(await main([
    "run", "--heap-snapshot", "--heap-snapshot-min", "1024", "--",
    process.execPath, "-e", "const end = Date.now() + 1500; while (Date.now() < end) {}",
  ], text.io), 0);
  assert.match(text.out.join(""), /note: the heap sampler could not run for .* because synchronous work blocked it; a peak inside that stretch may be missed/);
}, 10_000);

test("an all-idle run explains missing work and reruns the same command with --exit-on-signal", async () => {
  const { io, out } = capture();
  assert.equal(await main(["run", "--json", "--root", "/project root", "--", process.execPath, "-e", "setTimeout(() => {}, 600)"], io), 0);
  const result = JSON.parse(out.join(""));
  assert.equal(result.idleNote, "every CPU profile was at least 80% idle; a child may have ended by a signal, run native code, or done work in a process that was not Node. --exit-on-signal keeps the profile of a child ended by SIGTERM, SIGINT, or SIGHUP, but a child busy in synchronous code then exits only when it yields");
  assert.equal(
    result.do,
    `finderscope run --exit-on-signal --root ${shQuote("/project root")} --json -- ${shQuote(process.execPath)} ${shQuote("-e")} ${shQuote("setTimeout(() => {}, 600)")}`,
  );
});

test("without --exit-on-signal, SIGTERM promptly stops a child stuck in synchronous code", async () => {
  const childCode = "while (true) {}";
  const parentCode = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" });
setTimeout(() => child.kill("SIGTERM"), 200);
const fallback = setTimeout(() => child.kill("SIGKILL"), 1200);
child.on("exit", (code, signal) => {
  clearTimeout(fallback);
  process.exitCode = code === null && signal === "SIGTERM" ? 0 : 70;
});
`;
  const started = Date.now();
  const result = await runCommand({ heap: false, heapPeak: false, command: [process.execPath, "-e", parentCode] });
  assert.equal(result.exitCode, 0);
  assert.ok(Date.now() - started < 1100, "the child did not stop before the SIGKILL fallback");
}, 5_000);

test("run --exit-on-signal lets a SIGTERM-ended idle Node child write its CPU profile", async () => {
  const childCode = `
function childIdle() {}
setInterval(childIdle, 50);
process.stdout.write("ready");
`;
  const parentCode = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => child.kill("SIGTERM"));
child.on("exit", (code, signal) => { process.exitCode = code === 143 && signal === null ? 0 : 70; });
`;
  const { io, out } = capture();
  assert.equal(await main(["run", "--json", "--exit-on-signal", "--", process.execPath, "-e", parentCode], io), 0);
  const result = JSON.parse(out.join(""));
  assert.ok(result.profiles.length >= 2, `expected parent and child profiles, got ${result.profiles.length}`);
}, 30_000);

test("with --exit-on-signal, a Node child with its own SIGTERM listener keeps cleanup and its own exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-signal-cleanup-"));
  const marker = join(dir, "cleanup.txt");
  const childCode = `
const fs = require("node:fs");
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())); process.exit(42); });
setInterval(() => {}, 1000);
process.stdout.write("ready");
`;
  const parentCode = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: ["ignore", "pipe", "ignore"] });
let signaledAt = 0;
child.stdout.once("data", () => { signaledAt = Date.now(); child.kill("SIGTERM"); });
child.on("exit", (code) => { const handledAt = Number(fs.readFileSync(${JSON.stringify(marker)}, "utf8")); process.exitCode = code === 42 && handledAt - signaledAt < 100 ? 42 : 71; });
`;
  try {
    const result = await runCommand({ heap: false, heapPeak: false, exitOnSignal: true, command: [process.execPath, "-e", parentCode] });
    assert.equal(result.exitCode, 42);
    assert.ok(Number.isFinite(Number(readFileSync(marker, "utf8"))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a metadata path that becomes a directory cannot change child stderr or exit", async () => {
  const inner = `
const fs = require("node:fs");
const path = require("node:path");
const preload = /--require="([^"]*heap-snapshot-preload\\.cjs)"/.exec(process.env.NODE_OPTIONS)[1];
const dir = path.dirname(preload);
const name = fs.readdirSync(dir).find((item) => item.startsWith("heap-peak-" + process.pid + "-") && item.endsWith(".json"));
const metadata = path.join(dir, name);
fs.unlinkSync(metadata);
fs.mkdirSync(metadata);
setTimeout(() => process.stderr.write("sentinel\\n"), 100);
`;
  const parent = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(inner)}], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => stderr += chunk);
child.on("exit", (code) => { process.exitCode = code === 0 && stderr === "sentinel\\n" ? 0 : 70; });
`;
  const result = await runCommand({ heap: false, heapPeak: false, heapSnapshot: true, command: [process.execPath, "-e", parent] });
  assert.equal(result.exitCode, 0);
}, 30_000);

test("NODE_OPTIONS quoting preserves backslashes", () => {
  assert.equal(quoteForNodeOptions("/tmp/a\\b/c"), '"/tmp/a\\\\b/c"');
});

test("a snapshot write error does not change the program's exit or stderr", async () => {
  const inner = `
const fs = require("node:fs");
const path = require("node:path");
const preload = /--require="([^"]*heap-snapshot-preload\\.cjs)"/.exec(process.env.NODE_OPTIONS)[1];
const dir = path.dirname(preload);
const metadata = fs.readdirSync(dir).find((name) => name.startsWith("heap-peak-" + process.pid + "-") && name.endsWith(".json"));
const target = JSON.parse(fs.readFileSync(path.join(dir, metadata), "utf8")).target;
fs.mkdirSync(target + ".next");
globalThis.held = Array.from({ length: 150000 }, (_, i) => ({ i, text: "held-" + i + "-" + "x".repeat(48) }));
setTimeout(() => process.stderr.write("sentinel\\n"), 150);
`;
  const parent = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(inner)}], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => stderr += chunk);
child.on("exit", (code) => { process.exitCode = code === 0 && stderr === "sentinel\\n" ? 0 : 70; });
`;
  const { io, out } = capture();
  assert.equal(await main(["run", "--json", "--heap-snapshot", "--heap-snapshot-min", "1", "--heap-snapshot-threshold", "1", "--", process.execPath, "-e", parent], io), 0);
  const result = JSON.parse(out.join(""));
  assert.ok(result.heapSnapshotStats.errors.some((message: string) => /directory|EISDIR|unlink/i.test(message)));
  assert.match(result.heapSnapshotErrorNote, /^heap snapshot sampling stopped after an error: /);
}, 30_000);

test("two workers write distinct per-thread heap snapshots", async () => {
  const worker = `
const { parentPort } = require("node:worker_threads");
globalThis.held = Array.from({ length: 150000 }, (_, i) => ({ i, text: "worker-" + i + "-" + "x".repeat(48) }));
setTimeout(() => parentPort.postMessage("done"), 250);
`;
  const script = `
const { Worker } = require("node:worker_threads");
Promise.all([1, 2].map(() => new Promise((resolve, reject) => {
  const worker = new Worker(${JSON.stringify(worker)}, { eval: true });
  worker.once("message", resolve);
  worker.once("error", reject);
}))).then(() => {});
`;
  const { io, out } = capture();
  assert.equal(await main(["run", "--json", "--heap-snapshot", "--heap-snapshot-min", "1", "--heap-snapshot-threshold", "1", "--", process.execPath, "-e", script], io), 0);
  const result = JSON.parse(out.join(""));
  const workers = new Set(result.heapSnapshotCaptures.map((capture: { threadId: number }) => capture.threadId).filter((id: number) => id > 0));
  assert.deepEqual([...workers].sort(), [1, 2]);
  assert.equal(new Set(result.heapSnapshots).size, result.heapSnapshots.length);
}, 60_000);

test("the exit snapshot is skipped when heapUsed is near the heap limit", async () => {
  const script = `require("node:v8").getHeapStatistics = () => ({ heap_size_limit: 1 }); globalThis.held = [1];`;
  const { io, out } = capture();
  assert.equal(await main(["run", "--json", "--heap-snapshot", "--heap-snapshot-min", "1", "--heap-snapshot-threshold", "1", "--", process.execPath, "-e", script], io), 0);
  const result = JSON.parse(out.join(""));
  assert.ok(result.heapSnapshotStats.exitSkipped.includes("near heap limit"));
  assert.equal(result.heapSnapshotExitNote, "the exit-time heap snapshot was skipped near the heap limit");
}, 30_000);

test("exit-on-signal gives an idle custom listener two seconds, then exits conventionally", async () => {
  const childCode = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready");`;
  const parentCode = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => child.kill("SIGTERM"));
child.on("exit", (code) => { process.exitCode = code === 143 ? 0 : 70; });
`;
  const started = Date.now();
  const result = await runCommand({ heap: false, heapPeak: false, exitOnSignal: true, command: [process.execPath, "-e", parentCode] });
  const elapsed = Date.now() - started;
  assert.equal(result.exitCode, 0);
  assert.ok(elapsed >= 1900 && elapsed < 4000, `elapsed ${elapsed}ms`);
  assert.ok(result.profiles.length >= 2);
}, 10_000);

test("snapshot retry changes only the minimum and preserves all run flags", async () => {
  const { io, out } = capture();
  await main(["run", "--heap", "--heap-peak", "--heap-snapshot", "--heap-snapshot-threshold", "17", "--heap-snapshot-min", "64", "--exit-on-signal", "--root", "/project root", "--json", "--", process.execPath, "-e", "1"], io);
  const data = JSON.parse(out.join(""));
  assert.match(data.do, /^finderscope run --heap --heap-peak --heap-snapshot --heap-snapshot-threshold 17 --heap-snapshot-min [\d.]+ --exit-on-signal --root '\/project root' --json -- /);
}, 30_000);

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

test("run preserves an unrelated NODE_OPTIONS value", async () => {
  const previous = process.env["NODE_OPTIONS"];
  process.env["NODE_OPTIONS"] = "--no-warnings";
  try {
    const result = await runCommand({
      heap: false,
      heapPeak: false,
      command: [process.execPath, "-e", "process.exitCode = process.env.NODE_OPTIONS.includes('--no-warnings') ? 0 : 72"],
    });
    assert.equal(result.exitCode, 0);
  } finally {
    if (previous === undefined) delete process.env["NODE_OPTIONS"];
    else process.env["NODE_OPTIONS"] = previous;
  }
});

// Regression: after an out-of-memory crash, `run` must analyze the real heap snapshot that was
// written, not tell the caller to rerun. Snapshot support makes `retainers` the useful next step.
test(
  "after an OOM crash under --heap-peak, do: analyzes the real snapshot instead of asking for a rerun",
  async () => {
    const { io, out } = capture();
    const script = "const a=[];for(let i=0;i<5_000_000;i++)a.push({i,s:'x'.repeat(100)});console.log(a.length);";
    const code = await main(["run", "--heap-peak", "--", process.execPath, "--max-old-space-size=48", "-e", script], io);
    const text = out.join("");
    assert.notEqual(code, 0);
    assert.match(text, /\.heapsnapshot/);
    assert.doesNotMatch(text, /rerun without sending/);
    assert.match(text, /^do: finderscope retainers '.*\.heapsnapshot' '#\d+'$/m);
  },
  30_000,
);
