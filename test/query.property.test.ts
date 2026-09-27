// Property: querying by exactly the key a report printed always resolves back to that same
// function - the whole point of printing a key as `name path:line:col` is that it round-trips as
// the next command's <function> argument.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile } from "../src/model.js";
import { resolveFunction } from "../src/query.js";
import { drawCpuProfileJson } from "./helpers/profile-gen.js";

test(
  "resolveFunction(analysis, fn.key) === fn, for every function in the analysis",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawCpuProfileJson(tc, 10, 15));
        const analysis = analyzeCpuProfile(profile, { root: "/project" });
        tc.assume(analysis.functions.size > 0);
        for (const fn of analysis.functions.values()) {
          const resolved = resolveFunction(analysis, fn.key, "finderscope top 'p'", "/project");
          assert.equal(resolved, fn);
        }
      },
      { testCases: 150 },
    );
  },
  20_000,
);
