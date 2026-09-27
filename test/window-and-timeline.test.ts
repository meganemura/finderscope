// Regression tests: a `--from`/`--to` window restricts self/total/area numbers to the samples
// inside it, a window over the whole profile matches no window at all, a partition of windows
// sums back to the whole, and `timeline`'s 20 buckets exist to let an agent pick one. A heap
// profile has no timestamps, so both are rejected there through cli.ts.
import { test } from "vitest";
import assert from "node:assert/strict";
import { analyzeCpuProfile, buildTimeline } from "../src/model.js";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { main } from "../src/cli.js";

const ROOT = "/project";

// 10 samples, 1000us apart, each landing on "busy" - a simple, evenly spaced timeline to check
// windowing arithmetic against by hand.
function tenSampleProfile() {
  return {
    nodes: [
      { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
      { id: 1, callFrame: { functionName: "busy", url: "file:///project/src/busy.js", lineNumber: 0, columnNumber: 0 }, children: [] },
    ],
    samples: new Array(10).fill(1),
    timeDeltas: new Array(11).fill(1000),
  };
}

test("a window over the whole profile matches no window at all", () => {
  const profile = parseCpuProfile(tenSampleProfile());
  const whole = analyzeCpuProfile(profile, { root: ROOT });
  const windowed = analyzeCpuProfile(profile, { root: ROOT, window: { from: 0, to: profile.totalDuration + 1_000_000 } });
  assert.equal(windowed.total, whole.total);
  const busyWhole = [...whole.functions.values()].find((f) => f.name === "busy")!;
  const busyWindowed = [...windowed.functions.values()].find((f) => f.name === "busy")!;
  assert.equal(busyWindowed.self, busyWhole.self);
});

test("two adjacent, non-overlapping windows sum to the whole profile's own total", () => {
  const profile = parseCpuProfile(tenSampleProfile());
  const whole = analyzeCpuProfile(profile, { root: ROOT });
  const mid = Math.floor(profile.totalDuration / 2);
  const first = analyzeCpuProfile(profile, { root: ROOT, window: { from: 0, to: mid } });
  const second = analyzeCpuProfile(profile, { root: ROOT, window: { from: mid, to: profile.totalDuration + 1 } });
  assert.equal(first.total + second.total, whole.total);
});

test("a window with no samples in it has total 0, not a division error", () => {
  const profile = parseCpuProfile(tenSampleProfile());
  const empty = analyzeCpuProfile(profile, { root: ROOT, window: { from: profile.totalDuration + 1000, to: profile.totalDuration + 2000 } });
  assert.equal(empty.total, 0);
  assert.equal(empty.functions.size, 0);
});

test("timeline's 20 buckets sum their own totals back to the profile's total", () => {
  const profile = parseCpuProfile(tenSampleProfile());
  const buckets = buildTimeline(profile, ROOT);
  assert.equal(buckets.length, 20);
  const sum = buckets.reduce((s, b) => s + b.total, 0);
  assert.equal(sum, profile.totalDuration);
  for (const b of buckets) {
    if (b.topOwn !== undefined) assert.ok(b.topOwn.share <= 1 && b.topOwn.share >= 0);
  }
});

function capture() {
  const out: string[] = [];
  return { io: { stdout: (s: string) => out.push(s), stderr: () => {} }, out };
}

test("--from/--to on a heap profile is a caller error with its own do:, not a finderscope bug", async () => {
  const { io, out } = capture();
  const code = await main(["test/fixtures/tiny.heapprofile", "--root", ROOT, "--from", "0", "--to", "10"], io);
  assert.equal(code, 1);
  assert.match(out.join(""), /has no timestamps/);
  assert.doesNotMatch(out.join(""), /finderscope bug/);
});

test("timeline on a heap profile is a caller error, not a finderscope bug", async () => {
  const { io, out } = capture();
  const code = await main(["timeline", "test/fixtures/tiny.heapprofile", "--root", ROOT], io);
  assert.equal(code, 1);
  assert.match(out.join(""), /has no timestamps/);
  assert.doesNotMatch(out.join(""), /finderscope bug/);
});

test("--from without --to is a CliError asking for both", async () => {
  const { io, out } = capture();
  const code = await main(["test/fixtures/tiny.cpuprofile", "--root", ROOT, "--from", "0"], io);
  assert.equal(code, 1);
  assert.match(out.join(""), /--from and --to must be given together/);
});
