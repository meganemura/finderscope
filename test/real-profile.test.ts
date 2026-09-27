// Example tests against real output, not hand-written JSON: `node --cpu-prof` profiling this
// repo's own fixture script (checks profile/cpu.ts against actual V8 shapes), and a TypeScript
// fixture compiled with `tsc --sourceMap` at test time and then profiled (checks source mapping
// against actual tsc + V8 output). Neither fixture's compiled/profiled output is committed - both
// are produced fresh into os.tmpdir() so the test carries no machine-specific absolute path.
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectProfileKind } from "../src/profile/detect.js";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { analyzeCpuProfile } from "../src/model.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function profileScript(scriptPath: string, cwd: string): { dir: string; json: unknown } {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-real-profile-"));
  execFileSync(process.execPath, [`--cpu-prof`, `--cpu-prof-dir=${dir}`, scriptPath], { cwd });
  const file = readdirSync(dir).find((f) => f.endsWith(".cpuprofile"));
  if (file === undefined) throw new Error("node --cpu-prof wrote no .cpuprofile");
  const json = JSON.parse(readFileSync(join(dir, file), "utf8"));
  return { dir, json };
}

test("a real node --cpu-prof profile of our own fixture script parses and analyzes", () => {
  const scriptPath = join(here, "fixtures", "busy-script.js");
  const { dir, json } = profileScript(scriptPath, here);
  try {
    assert.equal(detectProfileKind(json), "cpu");
    const profile = parseCpuProfile(json);
    const analysis = analyzeCpuProfile(profile, { root: here });

    assert.ok(analysis.total > 0);
    const sumSelf = [...analysis.functions.values()].reduce((sum, f) => sum + f.self, 0);
    assert.equal(sumSelf, analysis.total);

    const busy = [...analysis.functions.values()].find((f) => f.name === "busy");
    assert.ok(busy !== undefined, "expected a function named busy in the real profile");
    assert.ok(busy!.key.includes("busy-script.js"));
    assert.equal(analysis.areaTotals.get("own") !== undefined, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real profile of a tsc-compiled script maps positions back to the .ts source", () => {
  const fixtureDir = join(here, "fixtures", "mapped-source");
  // realpathSync matters here: macOS's os.tmpdir() is under /tmp, a symlink to /private/tmp. tsc
  // computes each source's relative path using the literal --outDir string; V8 later reports the
  // running script's own url through its *resolved* path. Passing tsc the same resolved path up
  // front is what keeps the two arithmetics in agreement - not a sourcemap.ts concern, since a
  // real source map's sources are always relative to the map's own real location.
  const outDir = realpathSync(mkdtempSync(join(tmpdir(), "finderscope-tsc-out-")));
  const tsc = join(repoRoot, "node_modules", ".bin", "tsc");
  try {
    execFileSync(tsc, [
      "original.ts",
      "--ignoreConfig", // this repo's own tsconfig.json is an ancestor of fixtureDir; without this,
      // tsc 6's TS5112 refuses to compile explicit file arguments alongside a discoverable config.
      "--target",
      "es2022",
      "--module",
      "commonjs",
      "--sourceMap",
      "--outDir",
      outDir,
    ], { cwd: fixtureDir });

    const compiled = join(outDir, "original.js");
    const { dir, json } = profileScript(compiled, outDir);
    try {
      const profile = parseCpuProfile(json);
      const analysis = analyzeCpuProfile(profile, { root: fixtureDir });

      const hot = [...analysis.functions.values()].find((f) => f.name === "hotFunction");
      assert.ok(hot !== undefined, "expected hotFunction to be present, mapped back to original.ts");
      assert.ok(hot!.key.includes("original.ts"), `expected a .ts path in the mapped key, got: ${hot!.key}`);
      assert.equal(hot!.area, "own");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
