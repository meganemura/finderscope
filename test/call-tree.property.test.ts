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
import { analyzeCpuProfile, buildCallTree, type CallTreeNode } from "../src/model.js";
import { drawCpuProfileJson } from "./helpers/profile-gen.js";

const UNCUT = { depth: 50, childrenPerLevel: 10_000, expand: true };

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
