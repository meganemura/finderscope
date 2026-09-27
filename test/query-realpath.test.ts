// Regression test: a <function> query whose path spells a symlinked directory differently from
// the profile (a real macOS shape - /tmp is itself a symlink to /private/tmp) still resolves
// through resolveFunction, by comparing realpath once an exact key match fails.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCpuProfile } from "../src/model.js";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { resolveFunction } from "../src/query.js";

function makeProfile(scriptPath: string) {
  return {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [2] },
      { id: 2, callFrame: { functionName: "main", url: `file://${scriptPath}`, lineNumber: 0, columnNumber: 0 }, children: [] },
    ],
    samples: [2, 2],
    timeDeltas: [0, 1000, 1000],
  };
}

test("a query spelled through a symlinked directory still resolves via realpath", () => {
  const real = mkdtempSync(join(tmpdir(), "finderscope-realpath-real-"));
  const linkParent = mkdtempSync(join(tmpdir(), "finderscope-realpath-link-"));
  const link = join(linkParent, "alias");
  try {
    symlinkSync(real, link);
    const scriptPath = join(real, "main.js");
    writeFileSync(scriptPath, "function main() {}\n");

    const analysis = analyzeCpuProfile(parseCpuProfile(makeProfile(scriptPath)), { root: real });
    const [fn] = [...analysis.functions.values()].filter((f) => f.name === "main");
    assert.ok(fn !== undefined);

    // Query spells the SAME file through the symlink, not the real path the profile recorded -
    // an exact string match fails, but the realpath of both sides is identical.
    const queryPath = join(link, "main.js");
    const query = `main ${queryPath}:1:1`;
    const resolved = resolveFunction(analysis, query, "finderscope top 'p'", real);
    assert.equal(resolved.key, fn!.key);
  } finally {
    rmSync(linkParent, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("a query for a nonexistent path still falls through to substring matching, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-realpath-missing-"));
  try {
    const scriptPath = join(dir, "main.js");
    writeFileSync(scriptPath, "function main() {}\n");
    const analysis = analyzeCpuProfile(parseCpuProfile(makeProfile(scriptPath)), { root: dir });
    const resolved = resolveFunction(analysis, "main", "finderscope top 'p'", dir);
    assert.match(resolved.key, /^main /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
