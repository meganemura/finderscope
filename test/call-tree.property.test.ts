// Property: a call tree's "(self)" row plus the sum of its own direct children's values always
// equals its own value - true at the root (fn.self... well, the synthetic "(self)" row - plus its
// direct callees - equals fn.total) and, recursively, at every expanded node beneath it. Checked
// with depth and the per-level children cap both set high enough that nothing gets cut, since the
// invariant is a fact about the underlying grouping, not about how much of it a bounded display
// chooses to show (see model.ts's buildCallTree comment).
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile, buildCallTree, buildTopDown, type CallTreeNode, type ProfileAnalysis } from "../src/model.js";
import { drawCpuProfileJson } from "./helpers/profile-gen.js";

const UNCUT = { depth: 50, childrenPerLevel: 10_000, expand: true };
const UNCUT_TOP_DOWN = { ...UNCUT, rootCount: 10_000 };

/**
 * True when `key` calls itself DIRECTLY at its first occurrence on some real (positive-value)
 * path: the frame right after that first occurrence is `key` again. A "down" tree is rooted at
 * each path's first occurrence (buildCallTree), so the root's `recursive` marker describes exactly
 * that adjacency. A later self-call on the same path, such as the one in [A, B, A, A], sits under
 * B and is folded into that nested A node, which carries its own marker. Checked against
 * analysis.paths, the raw per-sample chains, independent of buildCallTree's folding logic.
 */
function hasDirectSelfCall(analysis: ProfileAnalysis, key: string): boolean {
  return analysis.paths.some((p) => {
    const first = p.keys.indexOf(key);
    return p.value > 0 && first !== -1 && p.keys[first + 1] === key;
  });
}

function checkInvariant(nodes: CallTreeNode[], parentValue: number, label: string): void {
  const sum = nodes.reduce((s, n) => s + n.value, 0);
  assert.equal(sum, parentValue, `${label}: children (incl. self) sum to ${sum}, not ${parentValue}`);
  for (const node of nodes) {
    if (node.children.length > 0) {
      assert.equal(node.childrenCut, 0, `${label} -> ${node.key}: expected no cut with UNCUT options`);
      checkInvariant(node.children, node.value, `${label} -> ${node.key}`);
    }
  }
}

test(
  "self + direct children == total, at every expanded level of a \"down\" (callees) call tree",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawCpuProfileJson(tc));
        const analysis = analyzeCpuProfile(profile, { root: "/project" });
        tc.assume(analysis.functions.size > 0);
        for (const fn of analysis.functions.values()) {
          const tree = buildCallTree(analysis, fn, "down", UNCUT);
          assert.equal(tree.childrenCut, 0);
          checkInvariant(tree.children, fn.total, fn.key);
          assert.equal(tree.recursive, hasDirectSelfCall(analysis, fn.key), `${fn.key}: recursive flag disagrees with a direct self-call actually existing`);
        }
      },
      { testCases: 100 },
    );
  },
  20_000,
);

test(
  "direct callers sum to at most total, for an \"up\" call tree (no self row)",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawCpuProfileJson(tc));
        const analysis = analyzeCpuProfile(profile, { root: "/project" });
        tc.assume(analysis.functions.size > 0);
        for (const fn of analysis.functions.values()) {
          const tree = buildCallTree(analysis, fn, "up", UNCUT);
          assert.equal(tree.childrenCut, 0);
          const sum = tree.children.reduce((s, c) => s + c.value, 0);
          // No "(self)" row upward - every path either has a real caller (contributing to `sum`)
          // or fn is the very first frame in that path (no caller at all, e.g. only "(root)" is
          // above it), which contributes nothing here. So the sum is at most fn.total, and is
          // usually exactly equal to it in any real profile.
          assert.ok(sum <= fn.total, `${fn.key}: callers sum ${sum} > total ${fn.total}`);
        }
      },
      { testCases: 100 },
    );
  },
  20_000,
);

test(
  "self + direct children == the root's own value, at every expanded level of \"your code, top down\"",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawCpuProfileJson(tc));
        const analysis = analyzeCpuProfile(profile, { root: "/project" });
        const { roots, rootsCut } = buildTopDown(analysis, UNCUT_TOP_DOWN);
        // drawCpuProfileJson's own frame pool has plenty of "own" (under /project) entries, so a
        // profile with any samples at all usually has at least one root; skip the rare draw with
        // none rather than asserting a property that requires the same invariant checkInvariant
        // already covers on an empty tree.
        tc.assume(roots.length > 0);
        assert.equal(rootsCut, 0);
        for (const root of roots) {
          checkInvariant(root.children, root.value, root.key);
        }
      },
      { testCases: 100 },
    );
  },
  20_000,
);

test(
  "direct callers sum to EXACTLY total, for any function that is never its own path's first frame",
  () => {
    // drawCpuProfileJson always makes node 0 "(root)" - so the only way a function can be a
    // path's first frame at all is by literally being "(root)" itself. Excluding that one key
    // means every remaining function has a real caller on every path that reaches it, so the
    // "at most" from the property above becomes an exact equality - proving the "usually" in its
    // own comment is not hiding a looser invariant than the one that actually holds.
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawCpuProfileJson(tc));
        const analysis = analyzeCpuProfile(profile, { root: "/project" });
        for (const fn of analysis.functions.values()) {
          if (fn.key === "(root)") continue;
          const tree = buildCallTree(analysis, fn, "up", UNCUT);
          assert.equal(tree.childrenCut, 0);
          const sum = tree.children.reduce((s, c) => s + c.value, 0);
          assert.equal(sum, fn.total, `${fn.key}: callers sum ${sum} !== total ${fn.total}`);
        }
      },
      { testCases: 150 },
    );
  },
  20_000,
);
