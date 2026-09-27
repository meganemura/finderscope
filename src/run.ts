// Responsibility: `run` - spawn exactly the command the caller gave, with NODE_OPTIONS extended
// so every Node process it starts (including child Node processes) writes a .cpuprofile (and,
// with --heap, a .heapprofile) into one scratch directory; wait for it; report every profile
// written there, largest first. The scratch directory is never deleted, on purpose: it is the
// path an agent re-queries with `finderscope callers`/`callees`/`top` after reading the summary
// - see cli.ts's own comment on why that path is printed before any summarizing happens.
// Boundary: never runs anything the caller did not name - no shell, no wrapper command. Does not
// parse or summarize a profile itself - src/cli.ts does that with the same profile/model/report
// modules every other command uses.

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { shQuote } from "./report/summary.js";

export interface RunOptions {
  heap: boolean;
  command: string[];
}

export interface RunResult {
  exitCode: number;
  /** Set only when the child ended via a signal (SIGKILL, a forwarded SIGINT/SIGTERM, a crash) -
   *  not a normal exit. V8 only writes a --cpu-prof/--heap-prof file when the process exits
   *  normally, so a signal-ended child with no profile is expected, not a bug to warn about the
   *  same way an unrelated missing profile would be. */
  signal: NodeJS.Signals | null;
  scratchDir: string;
  /** Absolute paths, largest file first. */
  profiles: string[];
}

/** A caller mistake about the command itself - no command given, or the command does not exist -
 *  not a finderscope bug. Carries its own `do` field, the same shape cli.ts's CliError and every
 *  other expected-error class in this codebase uses, so cli.ts's structural hasDoLine() check
 *  recognizes it without importing this class at all. */
export class RunInputError extends Error {
  readonly do: string;
  constructor(message: string, doLine: string) {
    super(message);
    this.name = "RunInputError";
    this.do = doLine;
  }
}

function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) {
    const signals = osConstants.signals as Record<string, number>;
    return 128 + (signals[signal] ?? 0);
  }
  return 1;
}

/** Double-quoted: NODE_OPTIONS is parsed the way a shell command line is, splitting on
 *  unquoted whitespace - a scratch directory whose own path contains a space (a real TMPDIR
 *  prefix can be exactly that: e.g. "/private/var/.../T/tmp sp/finderscope-xxxxxx") would
 *  otherwise truncate `--cpu-prof-dir` at the first space, silently profiling into the wrong
 *  directory or none at all. */
function quoteForNodeOptions(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function runCommand(options: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    if (options.command.length === 0) {
      reject(new RunInputError("no command given after --", "finderscope run [--heap] -- '<command...>'"));
      return;
    }

    const scratchDir = mkdtempSync(join(tmpdir(), "finderscope-"));
    const existingNodeOptions = process.env["NODE_OPTIONS"] ?? "";
    const flags = [`--cpu-prof`, `--cpu-prof-dir=${quoteForNodeOptions(scratchDir)}`];
    if (options.heap) flags.push(`--heap-prof`, `--heap-prof-dir=${quoteForNodeOptions(scratchDir)}`);
    // Append, never replace: a caller (or its own environment) may already rely on NODE_OPTIONS
    // for something unrelated.
    const nodeOptions = [existingNodeOptions, ...flags].filter((s) => s.length > 0).join(" ");

    const [command, ...args] = options.command;
    const child = spawn(command!, args, {
      stdio: "inherit",
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
    });

    // Forwarded, not left to Node's own default (which would kill finderscope itself and leave
    // the child running): an agent that Ctrl-C's a long `finderscope run` almost always means
    // "stop the profiled command", not "stop finderscope but let it keep running unprofiled".
    const forwardSignal = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);
    const stopForwarding = (): void => {
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      stopForwarding();
      if (err.code === "ENOENT") {
        reject(new RunInputError(`command not found: ${command}`, `check that ${shQuote(command!)} is installed and on PATH`));
        return;
      }
      reject(err);
    });
    child.on("exit", (code, signal) => {
      stopForwarding();
      const exitCode = exitCodeFor(code, signal);
      const profiles = readdirSync(scratchDir)
        .filter((f) => f.endsWith(".cpuprofile") || f.endsWith(".heapprofile"))
        .map((f) => join(scratchDir, f))
        .sort((a, b) => statSync(b).size - statSync(a).size);
      resolvePromise({ exitCode, signal, scratchDir, profiles });
    });
  });
}
