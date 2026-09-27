// Properties for model.ts's lineSelfTimes/lineReadPaths (report/lines.ts's own data source):
// - the per-line times summed for one function equal the self time of only the nodes that
//   actually contributed - a node with no positionTicks, or an all-zero one, is excluded, not
//   zero-filled (model.ts's computeLineSelfTimes' own comment); this test computes that expected
//   sum independently, straight from the raw profile JSON and cpu.ts's own sampleTimes, not from
//   anything model.ts itself tracked.
// - a generated positionTicks line, mapped through a real source map, round-trips to the exact
//   original file and line the map was built for - the same style test/sourcemap.property.test.ts
//   already uses for classify()'s own mapping, one level down (a whole line, not a column).
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile, classify, type GenericNode } from "../src/model.js";
import { createSourceMapper } from "../src/sourcemap.js";
import { drawCpuProfileJson } from "./helpers/profile-gen.js";

interface RawNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children?: number[];
  positionTicks?: { line: number; ticks: number }[];
}

/** Independently reconstructs, straight from the raw JSON (not from model.ts's own aggregation),
 *  the self time cpu.ts/model.ts attribute to each node id - the same sampleTimes convention
 *  cpu.ts documents (sample i's time is the delta to the NEXT sample), summed per node. */
function nodeSelfTimes(raw: { samples: number[]; timeDeltas: number[] }): Map<number, number> {
  const deltas = raw.timeDeltas.map((d) => Math.max(0, d));
  const sampleTimes: number[] = raw.samples.map((_, i) => (i < raw.samples.length - 1 ? (deltas[i + 1] ?? 0) : 0));
  if (raw.samples.length > 0) {
    const others = sampleTimes.slice(0, raw.samples.length - 1).sort((a, b) => a - b);
    sampleTimes[raw.samples.length - 1] = others[Math.floor((others.length - 1) / 2)] ?? 0;
  }
  const totals = new Map<number, number>();
  for (let i = 0; i < raw.samples.length; i++) {
    const t = sampleTimes[i]!;
    if (t <= 0) continue;
    totals.set(raw.samples[i]!, (totals.get(raw.samples[i]!) ?? 0) + t);
  }
  return totals;
}

test(
  "sum of a function's per-line times equals the self time of only the nodes with real positionTicks",
  () => {
    hegel.test(
      (tc) => {
        const raw = drawCpuProfileJson(tc, 12, 20, { withPositionTicks: true }) as { nodes: RawNode[]; samples: number[]; timeDeltas: number[] };
        const profile = parseCpuProfile(raw);
        const analysis = analyzeCpuProfile(profile, { root: "/project" });

        const selfTimes = nodeSelfTimes(raw);
        const mapper = createSourceMapper();
        const expected = new Map<string, number>();
        for (const rawNode of raw.nodes) {
          const self = selfTimes.get(rawNode.id) ?? 0;
          if (self <= 0) continue;
          const totalTicks = (rawNode.positionTicks ?? []).reduce((s, t) => s + t.ticks, 0);
          if (totalTicks <= 0) continue;
          // GenericFrame names its fields `line`/`column` (post-normalization, cpu.ts's own
          // convention) - the raw JSON's callFrame still says lineNumber/columnNumber.
          const generic: GenericNode = {
            id: rawNode.id,
            parentId: undefined,
            frame: { functionName: rawNode.callFrame.functionName, url: rawNode.callFrame.url, line: rawNode.callFrame.lineNumber, column: rawNode.callFrame.columnNumber },
          };
          const key = classify(generic, "/project", mapper).key;
          expected.set(key, (expected.get(key) ?? 0) + self);
        }

        for (const [key, expectedSelf] of expected) {
          const actual = [...(analysis.lineSelfTimes.get(key)?.values() ?? [])].reduce((a, b) => a + b, 0);
          assert.equal(actual, expectedSelf, `function ${key}: expected line-time sum ${expectedSelf}, got ${actual}`);
        }
        // No function outside `expected` may show up with a nonzero sum either - that would mean
        // some node without usable positionTicks was included anyway.
        for (const [key, perLine] of analysis.lineSelfTimes) {
          const actual = [...perLine.values()].reduce((a, b) => a + b, 0);
          assert.equal(actual, expected.get(key) ?? 0, `function ${key} has line-time data with no matching expected contribution`);
        }
      },
      { testCases: 200 },
    );
  },
  20_000,
);

// Catches a shape the first property test above cannot: that first test only checks the FUNCTION-
// level sum, so a bug that dumped ALL of one node's self time onto a single line (instead of
// splitting it by that line's own share of the node's ticks) would still sum correctly and slip
// through. This checks each line on its own, against apportionTicks' own formula, directly.
test(
  "within one node, each line's own time is within 1us of self * ticks(line) / ticks(node)",
  () => {
    hegel.test(
      (tc) => {
        const halfSelf = tc.draw(gs.integers({ minValue: 1, maxValue: 5000 }));
        const lineCount = tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
        const ticks: number[] = [];
        for (let i = 0; i < lineCount; i++) ticks.push(tc.draw(gs.integers({ minValue: 0, maxValue: 100 })));

        const raw = {
          nodes: [
            { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
            {
              id: 1,
              callFrame: { functionName: "hot", url: "file:///project/src/a.js", lineNumber: 0, columnNumber: 0 },
              children: [],
              // One entry per line (1-based, all distinct) - the same shape a real node's own
              // positionTicks array has, one {line, ticks} pair per distinct source line touched.
              positionTicks: ticks.map((t, i) => ({ line: i + 1, ticks: t })),
            },
          ],
          samples: [1, 1],
          // Matches test/fixtures/lines.cpuprofile's own construction: sample 0's time is the
          // delta to sample 1 (halfSelf), and the last sample gets the lower median of the rest
          // (also halfSelf here, the only other value) - node 1's own self time is exactly
          // 2 * halfSelf, a value this test controls precisely instead of reverse-engineering it.
          timeDeltas: [0, halfSelf, halfSelf],
        };
        const profile = parseCpuProfile(raw);
        const analysis = analyzeCpuProfile(profile, { root: "/project" });
        const fn = [...analysis.functions.values()].find((f) => f.name === "hot")!;
        const nodeSelf = fn.self;
        const nodeTicks = ticks.reduce((a, b) => a + b, 0);
        const perLine = analysis.lineSelfTimes.get(fn.key);

        for (let i = 0; i < lineCount; i++) {
          const expected = nodeTicks > 0 ? (nodeSelf * ticks[i]!) / nodeTicks : 0;
          const actual = perLine?.get(`src/a.js:${i + 1}`) ?? 0;
          assert.ok(
            Math.abs(actual - expected) <= 1,
            `line ${i + 1}: expected ~${expected} (self ${nodeSelf} * ticks ${ticks[i]} / nodeTicks ${nodeTicks}), got ${actual}`,
          );
        }
      },
      { testCases: 200 },
    );
  },
  20_000,
);

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function encodeVlq(value: number): string {
  let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let result = "";
  do {
    let digit = vlq & 0x1f;
    vlq >>>= 5;
    if (vlq > 0) digit |= 0x20;
    result += BASE64_ALPHABET[digit];
  } while (vlq > 0);
  return result;
}

test(
  "a generated positionTicks line, mapped through a real source map, round-trips to the exact original file and line",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "finderscope-lines-sourcemap-"));
    try {
      hegel.test(
        (tc) => {
          // Fixed at 1 (positionTicks' own 1-based convention), not drawn: the hand-built map
          // below only carries one mapping line (generated line index 0) - see its own comment.
          const generatedLine = 1;
          // Drawn, not fixed at 0: a real compiler's own first segment on an indented line starts
          // at that line's own column, never 0 (tsc --sourceMap does this routinely - see
          // test/fixtures/mapped-source's indented hotFunction). mapLine (sourcemap.ts) must find
          // this segment regardless of its own generatedColumn - the bug this property test would
          // have caught (`map(url, line, 0)` finding nothing when genCol > 0) had this fixed at 0.
          const genCol = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }));
          const srcLine = tc.draw(gs.integers({ minValue: 0, maxValue: 500 }));
          const srcCol = tc.draw(gs.integers({ minValue: 0, maxValue: 500 }));
          const ticks = tc.draw(gs.integers({ minValue: 1, maxValue: 50 }));

          const map = { version: 3, sources: ["src/original.ts"], names: [], mappings: [genCol, 0, srcLine, srcCol].map(encodeVlq).join("") };
          const scriptPath = join(dir, "generated.js");
          writeFileSync(scriptPath, `console.log("generated");\n//# sourceMappingURL=generated.js.map\n`);
          writeFileSync(join(dir, "generated.js.map"), JSON.stringify(map));

          const raw = {
            nodes: [
              { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
              {
                id: 1,
                callFrame: { functionName: "hot", url: scriptPath, lineNumber: 0, columnNumber: 0 },
                children: [],
                positionTicks: [{ line: generatedLine, ticks }],
              },
            ],
            samples: [1, 1],
            timeDeltas: [0, 100, 100],
          };
          const profile = parseCpuProfile(raw);
          const analysis = analyzeCpuProfile(profile, { root: dir });
          const fn = [...analysis.functions.values()].find((f) => f.name === "hot")!;

          const perLine = analysis.lineSelfTimes.get(fn.key)!;
          assert.equal(perLine.size, 1);
          const expectedKey = `src/original.ts:${srcLine + 1}`;
          assert.equal([...perLine.keys()][0], expectedKey);

          const readInfo = analysis.lineReadPaths.get(expectedKey);
          assert.ok(readInfo !== undefined);
          assert.equal(readInfo!.path, join(dir, "src", "original.ts"));
          assert.equal(readInfo!.line, srcLine + 1);
        },
        { testCases: 40 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20_000,
);
