// Regression coverage for report/lines.ts's source-preview safety (isReadableSourceFile). The
// realistic threat here is a source map's own `sources` entry, not the profiled script's own url:
// a map can name ANY path at all (it is untrusted input, no different from a profile's own JSON),
// so `lines` must never open one it should not - a FIFO with no writer (an open+read would hang
// this command forever), or a file with no code extension (a map naming, say, ~/.ssh/id_rsa would
// otherwise get its first line printed as a "source text" preview). Each scratch script here is a
// real, ordinary, readable file (so classify()'s own map-loading step - unrelated to this guard -
// never has anything to hang on); only the MAPPED path the map's own `sources` names is unsafe.
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile } from "../src/model.js";
import { buildLines } from "../src/report/lines.js";

/**
 * One own function ("hot") in a real, readable generated.js, mapped by a real generated.js.map
 * whose `sources` entry is `mappedSourcePath` (untrusted, and never itself opened by mapping -
 * only by report/lines.ts's own preview read, which this test is about). One positionTicks line
 * (generated line 1) lands on that same mapping.
 */
function analyzeMappedLineProfile(dir: string, mappedSourcePath: string) {
  const scriptPath = join(dir, "generated.js");
  writeFileSync(scriptPath, `console.log("generated");\n//# sourceMappingURL=generated.js.map\n`);
  writeFileSync(join(dir, "generated.js.map"), JSON.stringify({ version: 3, sources: [mappedSourcePath], names: [], mappings: "AAAA" }));

  const raw = {
    nodes: [
      { id: 0, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [1] },
      {
        id: 1,
        callFrame: { functionName: "hot", url: scriptPath, lineNumber: 0, columnNumber: 0 },
        children: [],
        positionTicks: [{ line: 1, ticks: 1 }],
      },
    ],
    samples: [1, 1],
    timeDeltas: [0, 100, 100],
  };
  const analysis = analyzeCpuProfile(parseCpuProfile(raw), { root: dir });
  const fn = [...analysis.functions.values()].find((f) => f.name === "hot")!;
  return buildLines(analysis, fn, "profile.cpuprofile");
}

test(
  "a source map naming a FIFO gives no preview and does not hang",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "finderscope-lines-fifo-"));
    // Named with a real code extension on purpose - the FIFO itself, not its name, must be what
    // stops the read (isReadableSourceFile's own statSync().isFile() check).
    const fifoPath = join(dir, "secret.js");
    try {
      execFileSync("mkfifo", [fifoPath]);
      const data = analyzeMappedLineProfile(dir, fifoPath);
      assert.equal(data.note, undefined);
      assert.equal(data.lines.length, 1);
      assert.equal(data.lines[0]!.source, undefined, "expected no preview from a FIFO, and no hang reading it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  5_000,
);

test("a source map naming a file with no code extension gives no preview", () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-lines-noext-"));
  const secretPath = join(dir, "id_rsa");
  try {
    writeFileSync(secretPath, "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key, just a test fixture\n");
    const data = analyzeMappedLineProfile(dir, secretPath);
    assert.equal(data.note, undefined);
    assert.equal(data.lines.length, 1);
    assert.equal(data.lines[0]!.source, undefined, "expected no preview from a non-code extension");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a source map naming a real, ordinary code file still gets its line previewed (control case)", () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-lines-ok-"));
  const okPath = join(dir, "ok.ts");
  try {
    writeFileSync(okPath, "const hot = 1;\n");
    const data = analyzeMappedLineProfile(dir, okPath);
    assert.equal(data.lines[0]!.source, "const hot = 1;");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
