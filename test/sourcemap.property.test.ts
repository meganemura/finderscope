// Properties: a VLQ-encoded single segment decodes back to the fields it was built from (the
// encoder here is a small, independent implementation written for this test, not src/sourcemap.ts's
// own decoder reused backwards); and a generated source map, referenced from a real generated
// script file via a sourceMappingURL comment, maps a generated position back to the exact
// original position it was built to produce.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMappings, createSourceMapper } from "../src/sourcemap.js";

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
  "a single-segment VLQ mapping line round-trips through decodeMappings",
  () => {
    hegel.test(
      (tc) => {
        const genCol = tc.draw(gs.integers({ minValue: 0, maxValue: 2000 }));
        const srcIdx = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
        const srcLine = tc.draw(gs.integers({ minValue: 0, maxValue: 2000 }));
        const srcCol = tc.draw(gs.integers({ minValue: 0, maxValue: 2000 }));
        const hasName = tc.draw(gs.booleans());
        const nameIdx = hasName ? tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) : undefined;

        const fields = [genCol, srcIdx, srcLine, srcCol, ...(nameIdx !== undefined ? [nameIdx] : [])];
        const mappings = fields.map(encodeVlq).join("");

        const decoded = decodeMappings(mappings);
        assert.equal(decoded.length, 1);
        assert.equal(decoded[0]!.length, 1);
        const segment = decoded[0]![0]!;
        assert.equal(segment.generatedColumn, genCol);
        assert.equal(segment.sourceIndex, srcIdx);
        assert.equal(segment.sourceLine, srcLine);
        assert.equal(segment.sourceColumn, srcCol);
        assert.equal(segment.nameIndex, nameIdx);
      },
      { testCases: 200 },
    );
  },
  20_000,
);

test(
  "multiple segments across multiple lines round-trip through decodeMappings, including negative deltas",
  () => {
    hegel.test(
      (tc) => {
        const lineCount = tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
        // Running totals, exactly as decodeMappings accumulates them: sourceIndex/sourceLine/
        // sourceColumn/nameIndex persist across the whole mappings string; generatedColumn resets
        // to 0 at the start of each line. Each field's own DELTA (not absolute value) is drawn,
        // and can be negative - a real source map legitimately has a mapping "before" the
        // previous one in source order (e.g. after inlining).
        let sourceIndex = 0;
        let sourceLine = 0;
        let sourceColumn = 0;
        let nameIndex = 0;
        const expectedLines: { generatedColumn: number; sourceIndex: number; sourceLine: number; sourceColumn: number; nameIndex: number | undefined }[][] = [];
        const lineStrs: string[] = [];

        for (let line = 0; line < lineCount; line++) {
          const segCount = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
          let generatedColumn = 0;
          const expectedSegments: (typeof expectedLines)[number] = [];
          const segStrs: string[] = [];
          for (let s = 0; s < segCount; s++) {
            const gcDelta = tc.draw(gs.integers({ minValue: 0, maxValue: 50 })); // generatedColumn only increases within a line, like a real map
            generatedColumn += gcDelta;
            const siDelta = tc.draw(gs.integers({ minValue: -20, maxValue: 20 }));
            const slDelta = tc.draw(gs.integers({ minValue: -20, maxValue: 20 }));
            const scDelta = tc.draw(gs.integers({ minValue: -20, maxValue: 20 }));
            sourceIndex += siDelta;
            sourceLine += slDelta;
            sourceColumn += scDelta;
            const hasName = tc.draw(gs.booleans());
            const fields = [gcDelta, siDelta, slDelta, scDelta];
            if (hasName) {
              const niDelta = tc.draw(gs.integers({ minValue: -5, maxValue: 5 }));
              nameIndex += niDelta;
              fields.push(niDelta);
            }
            segStrs.push(fields.map(encodeVlq).join(""));
            expectedSegments.push({
              generatedColumn,
              sourceIndex,
              sourceLine,
              sourceColumn,
              nameIndex: hasName ? nameIndex : undefined,
            });
          }
          lineStrs.push(segStrs.join(","));
          expectedLines.push(expectedSegments);
        }

        const decoded = decodeMappings(lineStrs.join(";"));
        assert.equal(decoded.length, expectedLines.length);
        for (let line = 0; line < expectedLines.length; line++) {
          const expectedSegments = [...expectedLines[line]!].sort((a, b) => a.generatedColumn - b.generatedColumn);
          assert.deepEqual(decoded[line], expectedSegments);
        }
      },
      { testCases: 150 },
    );
  },
  20_000,
);

test(
  "a real source map FILE, in a directory other than the generated script's, resolves sources against the MAP's own directory",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "finderscope-sourcemap-realfile-"));
    try {
      hegel.test(
        (tc) => {
          const genCol = tc.draw(gs.integers({ minValue: 0, maxValue: 500 }));
          const srcLine = tc.draw(gs.integers({ minValue: 0, maxValue: 500 }));
          const srcCol = tc.draw(gs.integers({ minValue: 0, maxValue: 500 }));

          const outDir = join(dir, "out");
          const mapsDir = join(dir, "maps");
          mkdirSync(outDir, { recursive: true });
          mkdirSync(mapsDir, { recursive: true });

          const map = { version: 3, sources: ["src/original.ts"], names: [], mappings: [genCol, 0, srcLine, srcCol].map(encodeVlq).join("") };
          writeFileSync(join(mapsDir, "generated.js.map"), JSON.stringify(map));
          const scriptPath = join(outDir, "generated.js");
          writeFileSync(scriptPath, `console.log("generated");\n//# sourceMappingURL=../maps/generated.js.map\n`);

          const mapper = createSourceMapper();
          const result = mapper.map(scriptPath, 0, genCol);
          assert.ok(result !== undefined);
          // Relative to maps/ (the map's own directory), not out/ (the script's) - the two
          // disagree here on purpose (see sourcemap.ts's own comment on the bug this is testing).
          assert.equal(result!.source, join(mapsDir, "src", "original.ts"));
          assert.equal(result!.line, srcLine);
          assert.equal(result!.column, srcCol);
        },
        { testCases: 30 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20_000,
);

test(
  "a generated position maps back to the original source position the map was built for",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "finderscope-sourcemap-"));
    try {
      hegel.test(
        (tc) => {
          const genCol = tc.draw(gs.integers({ minValue: 0, maxValue: 500 }));
          const srcLine = tc.draw(gs.integers({ minValue: 0, maxValue: 500 }));
          const srcCol = tc.draw(gs.integers({ minValue: 0, maxValue: 500 }));
          const hasName = tc.draw(gs.booleans());

          const map = {
            version: 3,
            sources: ["src/original.ts"],
            names: hasName ? ["originalName"] : [],
            mappings: [genCol, 0, srcLine, srcCol, ...(hasName ? [0] : [])].map(encodeVlq).join(""),
          };
          const dataUri = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;

          const scriptPath = join(dir, "generated.js");
          writeFileSync(scriptPath, `console.log("generated");\n//# sourceMappingURL=${dataUri}\n`);

          const mapper = createSourceMapper();
          const result = mapper.map(scriptPath, 0, genCol);
          assert.ok(result !== undefined);
          assert.equal(result!.source, join(dir, "src", "original.ts"));
          assert.equal(result!.line, srcLine);
          assert.equal(result!.column, srcCol);
          assert.equal(result!.name, hasName ? "originalName" : undefined);
        },
        { testCases: 40 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20_000,
);
