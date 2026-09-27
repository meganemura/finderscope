// Property: a hand-off's value can never exceed the area total it hands off into - checked
// against generated call trees wide and deep enough to routinely dip back into "own" code and out
// again (recursion through the FRAME_POOL, which includes real own/package/node/special frames),
// exactly the shape that made the pre-fix computeHandoffs (model.ts) double-count a single
// contribution once per own->non-own transition on one path instead of attributing it to at most
// one (fromKey, toArea) pair.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile } from "../src/model.js";
import { drawCpuProfileJson } from "./helpers/profile-gen.js";

test(
  "sum(handoffs into an area) <= that area's own total, for every area",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawCpuProfileJson(tc, 15, 40));
        const analysis = analyzeCpuProfile(profile, { root: "/project" });

        const handoffSumByArea = new Map<string, number>();
        for (const h of analysis.handoffs) {
          handoffSumByArea.set(h.toArea, (handoffSumByArea.get(h.toArea) ?? 0) + h.value);
        }

        for (const [area, sum] of handoffSumByArea) {
          const areaTotal = analysis.areaTotals.get(area) ?? 0;
          assert.ok(sum <= areaTotal, `area "${area}": hand-offs sum to ${sum}, but its own total is only ${areaTotal}`);
        }
      },
      { testCases: 200 },
    );
  },
  20_000,
);

test(
  "each individual hand-off's value is also, on its own, at most that area's total",
  () => {
    hegel.test(
      (tc) => {
        const profile = parseCpuProfile(drawCpuProfileJson(tc, 15, 40));
        const analysis = analyzeCpuProfile(profile, { root: "/project" });

        for (const h of analysis.handoffs) {
          const areaTotal = analysis.areaTotals.get(h.toArea) ?? 0;
          assert.ok(h.value <= areaTotal, `${h.fromKey} -> ${h.toArea}: ${h.value} > area total ${areaTotal}`);
        }
      },
      { testCases: 200 },
    );
  },
  20_000,
);
