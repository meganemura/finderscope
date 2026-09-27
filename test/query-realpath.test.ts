// Regression test: a <function> query whose path spells a symlinked directory differently from
// the profile (a real macOS shape - /tmp is itself a symlink to /private/tmp) still resolves
// through resolveFunction, by comparing realpath once an exact key match fails.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
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

test(
  "a generated realpath alias resolves to the same function",
  () => {
    const real = mkdtempSync(join(tmpdir(), "finderscope-realpath-property-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "finderscope-realpath-property-link-"));
    const link = join(linkParent, "alias");
    try {
      symlinkSync(real, link);
      const scriptPath = join(real, "main.js");
      writeFileSync(scriptPath, "export {};\n");
      hegel.test(
        (tc) => {
          const name = tc.draw(gs.text({ alphabet: "abcdef", minSize: 1, maxSize: 12 }));
          const profile = makeProfile(scriptPath) as { nodes: { callFrame: { functionName: string } }[] };
          profile.nodes[1]!.callFrame.functionName = name;
          const analysis = analyzeCpuProfile(parseCpuProfile(profile), { root: "/project" });
          const fn = [...analysis.functions.values()].find((candidate) => candidate.name === name)!;
          const query = `${name} ${join(link, "main.js")}:1:1`;
          assert.equal(resolveFunction(analysis, query, "finderscope top 'p'", "/project"), fn);
        },
        { testCases: 100 },
      );
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  },
  20_000,
);

test("a missing /tmp spelling matches a recorded /private/tmp path", () => {
  const suffix = `finderscope missing ${process.pid}/main.js`;
  const analysis = analyzeCpuProfile(parseCpuProfile(makeProfile(`/private/tmp/${suffix}`)), { root: "/project" });
  const fn = [...analysis.functions.values()].find((candidate) => candidate.name === "main")!;
  assert.equal(resolveFunction(analysis, `main /tmp/${suffix}:1:1`, "finderscope top 'p'", "/project"), fn);
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

test("an exact bare name wins over another function that only contains the same text", () => {
  const json = makeProfile("/project/main.js");
  (json.nodes[0] as { children: number[] }).children.push(3);
  json.nodes.push({ id: 3, callFrame: { functionName: "mainLoop", url: "file:///project/loop.js", lineNumber: 0, columnNumber: 0 }, children: [] });
  json.samples.push(3);
  json.timeDeltas.push(1000);
  const analysis = analyzeCpuProfile(parseCpuProfile(json), { root: "/project" });
  assert.equal(resolveFunction(analysis, "main", "finderscope top 'p'", "/project").name, "main");
});
