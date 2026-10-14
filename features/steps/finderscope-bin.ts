// The built command, reached two ways: directly, and as `finderscope` on
// PATH, which is how a printed `do:` line runs when an agent pastes it.
import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BIN = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

export function pathWithFinderscope(dir: string): string {
  const shim = join(dir, "finderscope");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(shim, 0o755);
  return `${dir}${delimiter}${process.env.PATH ?? ""}`;
}
