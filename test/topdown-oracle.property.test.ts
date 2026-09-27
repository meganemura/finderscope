// Property: "your code, top down" (model.ts's buildTopDown) means what design.md says it means -
// each path's root is its first own frame - checked against an INDEPENDENT grouping of the same
// profile's own per-sample root-to-leaf stacks (test/helpers/oracle.ts's own `paths` field, built
// by this file's own plain loop over classify(), not by model.ts's chainOf/pathKeysOf/buildTopDown
// machinery). Three properties test the meaning directly, not just buildTopDown's own internal
// consistency:
//   (a) the root values split the own-reaching value: sum(root.value) == total - (value of every
//       path that reaches no own frame at all).
//   (b) each root's value is at most that same function's own `.total` (AnalyzedFunction.total) -
//       a root's value can be smaller, since `.total` also counts a path that reaches the same
//       function through a DEEPER own ancestor (recursion, or two different own call sites), which
//       is not attributed to this root at all (see model.ts's buildTopDown comment).
//   (c) every root is the first own key on every path counted under it - not merely A frame
//       somewhere on those paths.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile, buildTopDown } from "../src/model.js";
import { computeOracle, type RawOracleProfile } from "./helpers/oracle.js";
import { drawCpuProfileJson } from "./helpers/profile-gen.js";

test(
  "\"your code, top down\" roots split the own-reaching value by first-own-frame, independently of model.ts's own grouping",
  () => {
    hegel.test(
      (tc) => {
        const json = drawCpuProfileJson(tc);
        const root = "/project";
        const profile = parseCpuProfile(json);
        const analysis = analyzeCpuProfile(profile, { root });
        // drawCpuProfileJson's own output shape (id/callFrame/children nodes, samples,
        // timeDeltas) is exactly computeOracle's RawOracleProfile; there is no shared type between
        // the two test helpers to import instead of asserting it here.
        const oracle = computeOracle(json as RawOracleProfile, root);
        const areaOf = (key: string): string => analysis.functions.get(key)?.area ?? "unknown";

        // Independent grouping, from the oracle's own per-sample stacks: for each sample, the
        // first own key on its root-to-leaf chain is its root; a sample with no own frame at all
        // contributes to neither a root nor `analysis.functions` in any own-reaching sense.
        const independentRootValues = new Map<string, number>();
        let noOwnValue = 0;
        for (const path of oracle.paths) {
          const firstOwnIdx = path.keys.findIndex((k) => areaOf(k) === "own");
          if (firstOwnIdx === -1) {
            noOwnValue += path.value;
            continue;
          }
          const rootKey = path.keys[firstOwnIdx]!;
          independentRootValues.set(rootKey, (independentRootValues.get(rootKey) ?? 0) + path.value);
          // (c): every key on THIS path at or after firstOwnIdx is not itself a different, earlier
          // own frame - firstOwnIdx was found by scanning from the start, so nothing before it on
          // this same path is "own" either; restated directly: the key this path is grouped under
          // is exactly path.keys[firstOwnIdx], never any other key on the path.
          assert.equal(areaOf(path.keys[firstOwnIdx]!), "own", "the key a path is grouped under must itself be own");
          for (let i = 0; i < firstOwnIdx; i++) {
            assert.notEqual(areaOf(path.keys[i]!), "own", "no key before the chosen root may itself be own");
          }
        }

        tc.assume(independentRootValues.size > 0);

        const { roots, rootsCut } = buildTopDown(analysis, { rootCount: 1_000_000 });
        assert.equal(rootsCut, 0);

        // (a): the root values split the own-reaching value.
        const sumRoots = roots.reduce((s, r) => s + r.value, 0);
        assert.equal(sumRoots, analysis.total - noOwnValue, "sum(root.value) != total - no-own-frame value");
        const sumIndependent = [...independentRootValues.values()].reduce((s, v) => s + v, 0);
        assert.equal(sumIndependent, analysis.total - noOwnValue, "independent grouping disagrees with the same identity");

        // buildTopDown's roots and the independent grouping must name the exact same keys with the
        // exact same values - this is the cross-check that (c) actually holds for buildTopDown
        // itself, not just for the independent grouping's own bookkeeping above.
        assert.equal(roots.length, independentRootValues.size);
        for (const r of roots) {
          assert.equal(r.value, independentRootValues.get(r.key), `root ${r.key}: value disagrees with the independent grouping`);

          // (b): a root's value is at most that function's own total.
          const fn = analysis.functions.get(r.key);
          assert.ok(fn !== undefined, `root ${r.key} must be a real function in analysis.functions`);
          assert.ok(r.value <= fn.total, `root ${r.key}: value ${r.value} > total(${fn.total})`);
        }
      },
      { testCases: 200 },
    );
  },
  20_000,
);
