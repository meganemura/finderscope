#!/usr/bin/env node
// Responsibility: the one executable entry point npm's own bin symlink runs - reads real argv and
// process streams, calls main(), and sets the real exit code. Nothing else: every actual command
// lives in src/cli.ts, which test/cli.test.ts runs in-process through main() directly, without
// needing this file, a build, or a child process at all.
// Boundary: no isMainModule / "run only if this is the entry point" check - that check made this
// file behave differently depending on how it was invoked (a symlink's own resolved path did not
// match process.argv[1] the way a plain file did), which is exactly the shape of bug a dedicated,
// always-executed entry point cannot have: this file has no other job to opt out of.

import { main } from "./cli.js";

const io = {
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
};

main(process.argv.slice(2), io).then((code) => {
  process.exitCode = code;
});
