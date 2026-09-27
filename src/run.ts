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
  /** A transient heap PEAK (not what --heap already reports - memory still live at exit) needs a
   *  heap snapshot taken near the moment the process actually approached its limit, which only
   *  happens when the caller also capped the heap - see hasHeapCap()'s own comment on why this
   *  never adds the flag otherwise. */
  heapPeak: boolean;
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
  /** Absolute paths to any .heapsnapshot --heapsnapshot-near-heap-limit wrote into scratchDir
   *  (--diagnostic-dir steers it there instead of its own default, the caller's cwd) - empty when
   *  --heap-peak was not given, or was given but the command had no heap cap to make it fire. */
  heapSnapshots: string[];
  /** Set only when --heap-peak was given but the command had no heap cap (--max-old-space-size) -
   *  a fact to report, not an error: without a cap, V8 never approaches a limit at all, so
   *  --heapsnapshot-near-heap-limit would never trigger. */
  heapPeakNote: string | undefined;
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

// Every real spelling V8/Node accepts for a heap cap: the dash form, the underscore form (V8's own
// flag parser treats `-`/`_` interchangeably in a flag name), and the newer --max-heap-size.
const HEAP_CAP_PATTERN = /--max[-_]old[-_]space[-_]size(=|\s|$)|--max-heap-size(=|\s|$)/;

/**
 * True when the command's own argv, or the environment's existing NODE_OPTIONS, already caps the
 * heap - the one condition `--heap-peak` requires before it adds --heapsnapshot-near-heap-limit at
 * all: without a cap, V8 never approaches a heap LIMIT (it just grows to whatever the machine
 * allows), so the flag would sit there and never fire - silently doing nothing is worse than a
 * caller believing --heap-peak "did not work", so this is checked up front and reported as a note,
 * never as a silent no-op.
 */
function hasHeapCap(command: string[], existingNodeOptions: string): boolean {
  return command.some((arg) => HEAP_CAP_PATTERN.test(arg)) || HEAP_CAP_PATTERN.test(existingNodeOptions);
}

export function runCommand(options: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    if (options.command.length === 0) {
      reject(new RunInputError("no command given after --", "finderscope run [--heap] [--heap-peak] -- '<command...>'"));
      return;
    }

    const scratchDir = mkdtempSync(join(tmpdir(), "finderscope-"));
    const existingNodeOptions = process.env["NODE_OPTIONS"] ?? "";
    const flags = [`--cpu-prof`, `--cpu-prof-dir=${quoteForNodeOptions(scratchDir)}`];
    if (options.heap) flags.push(`--heap-prof`, `--heap-prof-dir=${quoteForNodeOptions(scratchDir)}`);
    const capped = hasHeapCap(options.command, existingNodeOptions);
    let heapPeakNote: string | undefined;
    if (options.heapPeak) {
      if (capped) {
        // --diagnostic-dir steers the snapshot into the SAME scratch dir every other profile
        // already lands in - its own default (the current directory) is not that, and a real
        // heap snapshot can be well over 100MB, not something to leave wherever the command
        // happened to be run from.
        flags.push(`--heapsnapshot-near-heap-limit=1`, `--diagnostic-dir=${quoteForNodeOptions(scratchDir)}`);
      } else {
        heapPeakNote =
          "--heap-peak had no --max-old-space-size to work with, so it added nothing - a heap snapshot near the limit needs a limit to be near; pass --max-old-space-size to the profiled command too";
      }
    }
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
      const written = readdirSync(scratchDir);
      const profiles = written
        .filter((f) => f.endsWith(".cpuprofile") || f.endsWith(".heapprofile"))
        .map((f) => join(scratchDir, f))
        .sort((a, b) => statSync(b).size - statSync(a).size);
      const heapSnapshots = written.filter((f) => f.endsWith(".heapsnapshot")).map((f) => join(scratchDir, f));
      resolvePromise({ exitCode, signal, scratchDir, profiles, heapSnapshots, heapPeakNote });
    });
  });
}
