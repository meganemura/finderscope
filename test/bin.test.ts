// Example tests for src/bin.ts, the one file this repository actually publishes as an executable.
// Both cases here matter because bin.ts dropped the old `isMainModule` check
// (`import.meta.url === file://${process.argv[1]}`), which compared bin.ts's own resolved path
// against argv[0] - a comparison a symlink or a path a shell had to quote could each fail
// differently, silently turning the whole CLI into a no-op (main() never called, no output, exit
// code 0) instead of an error.
// Boundary: spawns the real, built dist/bin.js as a subprocess - this is the one test in the
// suite that needs a prior `npm run build`, on purpose, since it is checking the built artifact
// itself (the shebang), not src/cli.ts's logic. The build does not chmod +x its own output - npm
// sets the real executable bit on install, from package.json's own "bin" field - so a test that
// needs to actually EXEC the file directly (not run it via `node <path>`) sets that bit itself
// first, the same way npm's own install step would, rather than depending on the build to have
// done it.
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const binPath = join(repoRoot, "dist", "bin.js");
const fixture = join(here, "fixtures", "tiny.cpuprofile");

test("dist/bin.js starts with the node shebang", () => {
  assert.ok(existsSync(binPath), "dist/bin.js is missing - run `npm run build` first");
  const content = readFileSync(binPath, "utf8");
  assert.ok(content.startsWith("#!/usr/bin/env node\n"), `expected a node shebang, got: ${content.slice(0, 40)}`);
});

test("running dist/bin.js through a symlink still works", () => {
  chmodSync(binPath, 0o755);
  const dir = mkdtempSync(join(tmpdir(), "finderscope-bin-symlink-"));
  const link = join(dir, "finderscope-link");
  symlinkSync(binPath, link);
  try {
    const output = execFileSync(link, [fixture, "--root", "/project"], { encoding: "utf8" });
    assert.match(output, /finderscope summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("running dist/bin.js from a path that contains a space still works", () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope bin space "));
  try {
    const output = execFileSync(process.execPath, [binPath, fixture, "--root", "/project"], { encoding: "utf8", cwd: dir });
    assert.match(output, /finderscope summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dist/bin.js invoked directly (no explicit `node`) still works - exercises the shebang", () => {
  chmodSync(binPath, 0o755);
  const dir = mkdtempSync(join(tmpdir(), "finderscope bin space direct "));
  try {
    mkdirSync(dir, { recursive: true });
    const output = execFileSync(binPath, [fixture, "--root", "/project"], { encoding: "utf8", cwd: dir });
    assert.match(output, /finderscope summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: after bin.ts split the entry point out of cli.ts, `node dist/cli.js run -- ...`
// silently exited 0 and printed nothing at all - main() was never called, because cli.ts's own
// isInvokedDirectly() guard compared import.meta.url (a real file:// URL) against a literal
// `file://${process.argv[1]}` string, which agreed only when argv[1] was already the same string
// import.meta.url would produce - never true for a symlink, whose own path differs textually from
// its target's even when both name the same file. A silent, successful-looking no-op is the worst
// possible failure here: an old note that says `node dist/cli.js ...` looks like it ran.
const cliPath = join(repoRoot, "dist", "cli.js");

test("dist/cli.js run -- <command> still actually runs the command when invoked directly", () => {
  const busyScript = join(here, "fixtures", "busy-script.js");
  const output = execFileSync(process.execPath, [cliPath, "run", "--", process.execPath, busyScript], { encoding: "utf8" });
  assert.match(output, /scratch dir:/);
  assert.match(output, /finderscope summary/);
});

test("dist/cli.js works the same through a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-cli-symlink-"));
  const link = join(dir, "finderscope-cli-link.js");
  symlinkSync(cliPath, link);
  try {
    const output = execFileSync(process.execPath, [link, fixture, "--root", "/project"], { encoding: "utf8" });
    assert.match(output, /finderscope summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importing dist/cli.js runs nothing by itself (no main() call, no output)", () => {
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `import { main } from ${JSON.stringify(pathToFileURL(cliPath).href)}; console.log("imported:" + typeof main);`],
    { encoding: "utf8" },
  );
  assert.equal(output.trim(), "imported:function");
});
