// Property tests for the profile's own time span (NormalizedCpuProfile.spanStart/spanEnd) and the
// --from/--to window built on it: every generated profile forces a real, nonzero gap before the
// first sample (timeDeltas[0]) - a real .cpuprofile always has one - so a property that held only
// because a generator happened to draw 0 there would not catch the bug this guards against (every
// sample past the profile's own total piling into the timeline's last bucket, and a whole-span
// window silently dropping the same samples).
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { TestCase } from "@hegeldev/hegel";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile, buildTimeline } from "../src/model.js";

const ROOT = "/project";

/** A random, valid call tree of own and node: leaves, with a forced positive timeDeltas[0] (the
 *  real profiler-startup gap every .cpuprofile has) and every other delta positive too, so every
 *  sample's own position is well-defined and self/total accounting stays simple to check by hand. */
function drawProfileWithRealGap(tc: TestCase): unknown {
  const nodeCount = tc.draw(gs.integers({ minValue: 2, maxValue: 6 }));
  const nodes: unknown[] = [{ id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [] }];
  const rootChildren: number[] = [];
  for (let id = 1; id < nodeCount; id++) {
    const own = tc.draw(gs.booleans());
    nodes.push({
      id,
      callFrame: { functionName: `fn${id}`, url: own ? `file:///project/src/f${id}.js` : "node:fs", lineNumber: 0, columnNumber: 0 },
      children: [],
    });
    rootChildren.push(id);
  }
  (nodes[0] as { children: number[] }).children = rootChildren;

  const sampleCount = tc.draw(gs.integers({ minValue: 5, maxValue: 40 }));
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(tc.draw(gs.integers({ minValue: 1, maxValue: nodeCount - 1 })));
    timeDeltas.push(tc.draw(gs.integers({ minValue: 1, maxValue: 500 })));
  }
  // Forced, not left to the draw above: a real profile always has a nonzero gap before its first
  // sample, and this is exactly the case the span fix (spanStart != 0) exists for.
  timeDeltas[0] = tc.draw(gs.integers({ minValue: 50, maxValue: 3000 }));
  return { nodes, samples, timeDeltas };
}

test(
  "a window covering the whole span equals no window at all, with a real startup gap",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawProfileWithRealGap(tc));
        const whole = analyzeCpuProfile(profile, { root: ROOT });
        const span = profile.spanEnd - profile.spanStart;
        const windowed = analyzeCpuProfile(profile, { root: ROOT, window: { from: 0, to: span } });
        assert.equal(windowed.total, whole.total);
        for (const [key, fn] of whole.functions) {
          const wfn = windowed.functions.get(key);
          assert.ok(wfn !== undefined, `missing ${key} in the whole-span window`);
          assert.equal(wfn!.self, fn.self);
        }
      },
      { testCases: 150 },
    );
  },
  20_000,
);

test(
  "two adjacent windows that partition the span sum back to the whole, for self, total and area totals",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawProfileWithRealGap(tc));
        const whole = analyzeCpuProfile(profile, { root: ROOT });
        const span = profile.spanEnd - profile.spanStart;
        tc.assume(span > 1);
        const split = tc.draw(gs.integers({ minValue: 1, maxValue: Math.floor(span) - 1 }));

        const first = analyzeCpuProfile(profile, { root: ROOT, window: { from: 0, to: split } });
        const second = analyzeCpuProfile(profile, { root: ROOT, window: { from: split, to: span } });

        assert.equal(first.total + second.total, whole.total);

        const keys = new Set([...whole.functions.keys()]);
        for (const key of keys) {
          const fSelf = first.functions.get(key)?.self ?? 0;
          const sSelf = second.functions.get(key)?.self ?? 0;
          assert.equal(fSelf + sSelf, whole.functions.get(key)!.self, `self for ${key} did not partition`);
        }
        const areas = new Set([...whole.areaTotals.keys()]);
        for (const area of areas) {
          const fArea = first.areaTotals.get(area) ?? 0;
          const sArea = second.areaTotals.get(area) ?? 0;
          assert.equal(fArea + sArea, whole.areaTotals.get(area), `area total for ${area} did not partition`);
        }
      },
      { testCases: 150 },
    );
  },
  20_000,
);

test(
  "each timeline bucket's own total equals the total of a window built from that bucket's own from/to",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawProfileWithRealGap(tc));
        const buckets = buildTimeline(profile, ROOT);
        assert.equal(buckets.length, 20);
        const k = tc.draw(gs.integers({ minValue: 0, maxValue: 19 }));
        const bucket = buckets[k]!;
        const windowed = analyzeCpuProfile(profile, { root: ROOT, window: { from: bucket.from, to: bucket.to } });
        assert.equal(windowed.total, bucket.total, `bucket ${k}'s own window did not reproduce its total`);
      },
      { testCases: 150 },
    );
  },
  20_000,
);
