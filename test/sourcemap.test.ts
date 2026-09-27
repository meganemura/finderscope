// Example/regression tests for src/sourcemap.ts. Each builds one small script and map on disk in
// the shape that breaks a naive decoder: a map in another directory than its script, null entries
// in sources/names, a file:// sourceRoot, a non-file scheme such as webpack://, and a
// percent-encoded (not base64) data: URI.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createSourceMapper } from "../src/sourcemap.js";

function withScratchDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-sourcemap-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("sources resolve against the MAP file's own directory, not the script's directory", () => {
  withScratchDir((dir) => {
    mkdirSync(join(dir, "out"), { recursive: true });
    mkdirSync(join(dir, "maps"), { recursive: true });
    // A relative source with no "../" - resolving it against "out/" (the script's own directory,
    // the old, wrong baseDir) lands at out/src/x.ts; resolving it against "maps/" (the map's own
    // directory, the fix) lands at maps/src/x.ts - the two disagree, so this case actually
    // distinguishes the bug from the fix (a source like "../src/x.ts" would coincidentally agree
    // when out/ and maps/ sit at the same depth, which is why the original repro's first case
    // needed a second one to actually catch this).
    writeFileSync(join(dir, "out", "x.js"), "a();\n//# sourceMappingURL=../maps/x.js.map\n");
    writeFileSync(join(dir, "maps", "x.js.map"), JSON.stringify({ version: 3, sources: ["src/x.ts"], names: [], mappings: "AAAA" }));

    const result = createSourceMapper().map(join(dir, "out", "x.js"), 0, 0);
    assert.equal(result?.source, join(dir, "maps", "src", "x.ts"));
  });
});

test("a null entry in \"sources\" keeps every later index aligned, not shifted", () => {
  withScratchDir((dir) => {
    writeFileSync(join(dir, "y.js"), "a();b();\n//# sourceMappingURL=y.js.map\n");
    // mappings "ACAA" decodes to sourceIndex delta +1 from a running total starting at 0, landing
    // on index 1 - "real.ts". A sources-filtering bug that dropped the null in-place shifted index
    // 1 down to what was really index 2 (out of bounds here - undefined; "real.ts" itself in the
    // two-entry case).
    writeFileSync(join(dir, "y.js.map"), JSON.stringify({ version: 3, sources: [null, "real.ts"], names: [], mappings: "ACAA" }));

    const result = createSourceMapper().map(join(dir, "y.js"), 0, 0);
    assert.equal(result?.source, join(dir, "real.ts"));
  });
});

test("a null entry earlier in \"sources\" does not shift a later real entry either", () => {
  withScratchDir((dir) => {
    writeFileSync(join(dir, "y2.js"), "a();\n//# sourceMappingURL=y2.js.map\n");
    writeFileSync(
      join(dir, "y2.js.map"),
      JSON.stringify({ version: 3, sources: [null, "real.ts", "other.ts"], names: [], mappings: "ACAA" }),
    );

    const result = createSourceMapper().map(join(dir, "y2.js"), 0, 0);
    assert.equal(result?.source, join(dir, "real.ts"));
  });
});

test("a file:// sourceRoot becomes a local path, not a raw file:// string", () => {
  withScratchDir((dir) => {
    writeFileSync(join(dir, "z.js"), "a();\n//# sourceMappingURL=z.js.map\n");
    writeFileSync(
      join(dir, "z.js.map"),
      JSON.stringify({ version: 3, sourceRoot: "file:///proj/", sources: ["src/z.ts"], names: [], mappings: "AAAA" }),
    );

    const result = createSourceMapper().map(join(dir, "z.js"), 0, 0);
    assert.equal(result?.source, "/proj/src/z.ts");
  });
});

test("a data: URI that is not base64 (plain percent-encoding) is decoded, not silently dropped", () => {
  withScratchDir((dir) => {
    const map = JSON.stringify({ version: 3, sources: ["d.ts"], names: [], mappings: "AAAA" });
    writeFileSync(join(dir, "d.js"), `a();\n//# sourceMappingURL=data:application/json,${encodeURIComponent(map)}\n`);

    const result = createSourceMapper().map(join(dir, "d.js"), 0, 0);
    assert.equal(result?.source, join(dir, "d.ts"));
  });
});

test("a percent-encoded file:// script url (a space in the path) still finds its sibling .map", () => {
  withScratchDir((dir) => {
    const sub = join(dir, "a b");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "w.js"), "a();\n//# sourceMappingURL=w.js.map\n");
    writeFileSync(join(sub, "w.js.map"), JSON.stringify({ version: 3, sources: ["w.ts"], names: [], mappings: "AAAA" }));

    const result = createSourceMapper().map(pathToFileURL(join(sub, "w.js")).href, 0, 0);
    assert.equal(result?.source, join(sub, "w.ts"));
  });
});
