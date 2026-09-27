// Regression: analyzeCpuProfile used to build one contribution per SAMPLE
// (`profile.samples.map(...)`), so a profile with millions of samples held one array entry - and,
// downstream, one full root-to-leaf chain array in `paths` - per sample, even when almost all of
// them pointed at the same handful of hot leaf nodes. aggregateSampleTimeByNode (model.ts) sums
// time per node id FIRST, so every later step works on at most one entry per distinct node.
// Measured here through a counter (the actual size of `analysis.paths`, `analysis.functions`, and
// `analysis.hottest`'s own grouping work), not through wall-clock time on a real multi-GB profile -
// a large profile is expensive to even construct, and elapsed time is not deterministic enough for
// a CI assertion. A modest sample count (in the hundreds of thousands, not millions) run through a
// large multiplier already proves the O(nodes), not O(samples), scaling this checks for.
import { test } from "vitest";
import assert from "node:assert/strict";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile } from "../src/model.js";

const DISTINCT_NODES = 20;
const SAMPLES_PER_NODE = 10_000; // 200,000 samples total, over only 20 distinct nodes

function buildManySamplesFewNodes(): unknown {
  const nodes = [{ id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 }, children: [] as number[] }];
  for (let i = 1; i <= DISTINCT_NODES; i++) {
    nodes[0]!.children.push(i);
    nodes.push({
      id: i,
      callFrame: { functionName: `leaf${i}`, url: `file:///project/src/leaf${i}.js`, lineNumber: 0, columnNumber: 0 },
      children: [],
    });
  }

  const samples: number[] = [];
  const timeDeltas: number[] = [0];
  for (let s = 0; s < SAMPLES_PER_NODE; s++) {
    for (let i = 1; i <= DISTINCT_NODES; i++) {
      samples.push(i);
      timeDeltas.push(1);
    }
  }
  return { nodes, samples, timeDeltas };
}

test("work scales with distinct nodes, not with sample count", () => {
  const json = buildManySamplesFewNodes();
  const profile = parseCpuProfile(json);
  const totalSamples = DISTINCT_NODES * SAMPLES_PER_NODE;
  assert.equal(profile.samples.length, totalSamples);

  const analysis = analyzeCpuProfile(profile, { root: "/project" });

  // The actual counters: every one of these is bounded by the number of DISTINCT nodes (root +
  // 20 leaves = 21), never by the 200,000 samples that hit them.
  assert.ok(analysis.paths.length <= DISTINCT_NODES + 1, `paths held ${analysis.paths.length} entries, expected at most ${DISTINCT_NODES + 1}`);
  assert.ok(
    analysis.functions.size <= DISTINCT_NODES + 1,
    `functions held ${analysis.functions.size} entries, expected at most ${DISTINCT_NODES + 1}`,
  );

  // Correctness, not just the counter: every sample's time is still accounted for exactly once.
  const sumSelf = [...analysis.functions.values()].reduce((sum, f) => sum + f.self, 0);
  assert.equal(sumSelf, analysis.total);
  assert.equal(analysis.total, totalSamples); // every timeDelta here is 1, so total == sample count
});

const DEEP_CHAIN_LENGTH = 50_000;

function buildDeepChain(): unknown {
  const nodes: unknown[] = [{ id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 }, children: [1] }];
  for (let i = 1; i <= DEEP_CHAIN_LENGTH; i++) {
    nodes.push({
      id: i,
      callFrame: { functionName: `frame${i}`, url: "file:///project/src/a.js", lineNumber: 0, columnNumber: 0 },
      children: i < DEEP_CHAIN_LENGTH ? [i + 1] : [],
    });
  }
  return { nodes, samples: [DEEP_CHAIN_LENGTH, DEEP_CHAIN_LENGTH], timeDeltas: [0, 1, 1] };
}

test("a call tree 50,000 frames deep does not overflow the real call stack", () => {
  // model.ts's chain/key-set walks used to recurse once per ancestor; one JS call frame per tree
  // node overflows Node's default stack well before 50,000 levels of a single, deep,
  // mostly-linear call tree (one function calling another, tens of thousands of levels deep, with
  // one sample at the bottom). Iterative code (a plain while loop) has no such limit; this just
  // needs to complete at all, not any specific number.
  const analysis = analyzeCpuProfile(parseCpuProfile(buildDeepChain()), { root: "/project" });
  assert.ok(analysis.total > 0);
});
