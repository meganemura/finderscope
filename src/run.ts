// Responsibility: `run` extends NODE_OPTIONS so each Node process writes CPU, optional heap, and
// optional peak-snapshot data into one kept scratch directory. On request, it lets catchable
// signals flush profiles, waits for the named command, and returns every artifact largest first.
// Boundary: never adds a wrapper command and never parses or summarizes a profile. cli.ts owns
// reports and the callers/callees/top/retainers commands that re-query the kept artifacts.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  /** Periodically replaces one snapshot per Node process as heapUsed reaches new highs. Unlike
   *  heapPeak, this does not require a configured V8 heap limit. */
  heapSnapshot?: boolean;
  heapSnapshotThreshold?: number;
  heapSnapshotMinMb?: number;
  /** Converts otherwise unhandled catchable signals to conventional numeric exits so V8 flushes
   *  profiles. Opt-in because a synchronous loop cannot run a JavaScript signal listener. */
  exitOnSignal?: boolean;
  command: string[];
}

export interface RunResult {
  exitCode: number;
  /** Set only when the child ended via an unconverted signal, such as SIGKILL, a crash, or a
   *  catchable signal when exitOnSignal was not requested. */
  signal: NodeJS.Signals | null;
  scratchDir: string;
  /** Absolute paths, largest file first. */
  profiles: string[];
  /** Absolute paths to heap snapshots captured by --heap-peak or --heap-snapshot, largest first. */
  heapSnapshots: string[];
  /** Set only when --heap-peak was given but the command had no heap cap (--max-old-space-size) -
   *  a fact to report, not an error: without a cap, V8 never approaches a limit at all, so
   *  --heapsnapshot-near-heap-limit would never trigger. */
  heapPeakNote: string | undefined;
  heapSnapshotCaptures: { path: string; heapUsed: number; cpuTimeUs: number; liveAfter?: number; threadId: number }[];
  heapSnapshotStats: { snapshotsWritten: number; peakHeapUsed: number; maxGrowth: number; cpuTimeUs: number; maxSamplerGapMs: number; errors: string[]; exitSkipped: string[] } | undefined;
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
export function quoteForNodeOptions(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
    if (options.exitOnSignal) {
      const signalPreloadPath = join(scratchDir, "signal-exit-preload.cjs");
      // V8 flushes CPU profiles on normal process exit. This handler converts an otherwise
      // unhandled catchable termination signal into the conventional numeric exit without taking
      // control from a program that installed its own shutdown listener. It is opt-in because a
      // signal cannot interrupt synchronous JavaScript to run this listener.
      writeFileSync(signalPreloadPath, `
const os = require("node:os");
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  const number = os.constants.signals[signal];
  if (typeof number !== "number") continue;
  try {
process.on(signal, () => {
      if (process.listenerCount(signal) === 1) {
        process.exit(128 + number);
        return;
      }
      const grace = setTimeout(() => process.exit(128 + number), 2000);
      grace.unref();
    });
  } catch {}
}
`);
      flags.push(`--require=${quoteForNodeOptions(signalPreloadPath)}`);
    }
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
    if (options.heapSnapshot) {
      const preloadPath = join(scratchDir, "heap-snapshot-preload.cjs");
      const threshold = options.heapSnapshotThreshold ?? 25;
      const minimum = options.heapSnapshotMinMb ?? 64;
      // The module lives in the scratch directory because NODE_OPTIONS must reach child Node
      // processes too; a path beside finderscope's installed JS would bind collection to one
      // package layout and would not let each run own its output file.
      writeFileSync(preloadPath, `
const fs = require("node:fs");
const path = require("node:path");
const v8 = require("node:v8");
const crypto = require("node:crypto");
const threadId = require("node:worker_threads").threadId;
const stem = "heap-peak-" + process.pid + "-" + threadId + "-" + crypto.randomBytes(4).toString("hex");
const target = path.join(${JSON.stringify(scratchDir)}, stem + ".heapsnapshot");
const metadata = path.join(${JSON.stringify(scratchDir)}, stem + ".json");
const threshold = ${JSON.stringify(threshold / 100)};
const minimum = ${JSON.stringify(minimum * 1024 * 1024)};
const start = process.memoryUsage().heapUsed;
let lastWritten = start;
let peakHeapUsed = start;
let writing = false;
const captures = [];
let snapshotCpuTimeUs = 0;
let lastSamplerTickMs = Date.now();
let maxSamplerGapMs = 0;
let failure;
let exitSkipped;
let timer;
const persist = () => {
  try {
    fs.writeFileSync(metadata, JSON.stringify({ start, peakHeapUsed, captures, snapshotCpuTimeUs, maxSamplerGapMs, threadId, target, failure, exitSkipped }));
    return true;
  } catch {
    return false;
  }
};
const stopWithFailure = (error) => {
  if (failure !== undefined) return;
  failure = error instanceof Error ? error.message : String(error);
  if (timer !== undefined) clearInterval(timer);
  persist();
};
const observeSamplerGap = () => {
  const now = Date.now();
  maxSamplerGapMs = Math.max(maxSamplerGapMs, now - lastSamplerTickMs);
  lastSamplerTickMs = now;
};
const captureIfQualified = (heapUsed) => {
  peakHeapUsed = Math.max(peakHeapUsed, heapUsed);
  if (writing || heapUsed < start + minimum || heapUsed < lastWritten * (1 + threshold)) return;
  writing = true;
  const next = target + ".next";
  try {
    if (fs.existsSync(next)) fs.unlinkSync(next);
    const before = process.cpuUsage();
    v8.writeHeapSnapshot(next);
    const cpu = process.cpuUsage(before);
    const cpuTimeUs = cpu.user + cpu.system;
    fs.renameSync(next, target);
    // writeHeapSnapshot collects garbage first, so heapUsed right after it is close to the live
    // heap the file holds. The report compares it with heapUsed at capture.
    captures.push({ heapUsed, cpuTimeUs, liveAfter: process.memoryUsage().heapUsed });
    snapshotCpuTimeUs += cpuTimeUs;
    lastWritten = heapUsed;
    if (!persist()) stopWithFailure("could not write heap snapshot metadata");
  } catch (error) {
    stopWithFailure(error);
  } finally {
    writing = false;
  }
};
if (!persist()) failure = "could not write heap snapshot metadata";
if (failure === undefined) timer = setInterval(() => {
  observeSamplerGap();
  captureIfQualified(process.memoryUsage().heapUsed);
  // Snapshot writing blocks this timer too, but the profiled program cannot create a missed peak
  // while V8 has paused it. Start the next user-work interval after finderscope's write completes.
  lastSamplerTickMs = Date.now();
}, 20);
if (timer !== undefined) timer.unref();
process.on("exit", () => {
  if (failure !== undefined) return;
  observeSamplerGap();
  try {
    if (process.memoryUsage().heapUsed >= v8.getHeapStatistics().heap_size_limit * 0.5) {
      exitSkipped = "near heap limit";
      if (!persist()) stopWithFailure("could not write heap snapshot metadata");
      return;
    }
    captureIfQualified(process.memoryUsage().heapUsed);
    if (!persist()) stopWithFailure("could not write heap snapshot metadata");
  } catch (error) {
    stopWithFailure(error);
  }
});
`);
      flags.push(`--require=${quoteForNodeOptions(preloadPath)}`);
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
      const heapSnapshots = written
        .filter((f) => f.endsWith(".heapsnapshot"))
        .map((f) => join(scratchDir, f))
        .sort((a, b) => statSync(b).size - statSync(a).size);
      const snapshotMetadata = written.filter((file) => /^heap-peak-\d+-\d+-[0-9a-f]{8}\.json$/.test(file)).flatMap((file) => {
        const metadataPath = join(scratchDir, file);
        try {
          const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
            start?: unknown;
            peakHeapUsed?: unknown;
            snapshotCpuTimeUs?: unknown;
            maxSamplerGapMs?: unknown;
            captures?: unknown;
            threadId?: unknown;
            target?: unknown;
            failure?: unknown;
            exitSkipped?: unknown;
          };
          if (typeof metadata.start !== "number" || typeof metadata.peakHeapUsed !== "number" || !Array.isArray(metadata.captures)) return [];
          const path = typeof metadata.target === "string" ? metadata.target : metadataPath.replace(/\.json$/, ".heapsnapshot");
          const threadId = typeof metadata.threadId === "number" ? metadata.threadId : 0;
          const captures = metadata.captures.flatMap((capture) => {
            if (typeof capture !== "object" || capture === null) return [];
            const value = capture as { heapUsed?: unknown; cpuTimeUs?: unknown; liveAfter?: unknown };
            return typeof value.heapUsed === "number" && typeof value.cpuTimeUs === "number"
              ? [{ path, heapUsed: value.heapUsed, cpuTimeUs: value.cpuTimeUs, threadId, ...(typeof value.liveAfter === "number" ? { liveAfter: value.liveAfter } : {}) }]
              : [];
          });
          return [{
            start: metadata.start,
            peakHeapUsed: metadata.peakHeapUsed,
            cpuTimeUs: typeof metadata.snapshotCpuTimeUs === "number" ? metadata.snapshotCpuTimeUs : 0,
            maxSamplerGapMs: typeof metadata.maxSamplerGapMs === "number" ? metadata.maxSamplerGapMs : 0,
            failure: typeof metadata.failure === "string" ? metadata.failure : undefined,
            exitSkipped: typeof metadata.exitSkipped === "string" ? metadata.exitSkipped : undefined,
            captures,
          }];
        } catch {
          return [];
        }
      });
      const heapSnapshotCaptures = snapshotMetadata.flatMap((metadata) => metadata.captures);
      const heapSnapshotStats = options.heapSnapshot ? {
        snapshotsWritten: heapSnapshotCaptures.length,
        peakHeapUsed: snapshotMetadata.reduce((peak, metadata) => Math.max(peak, metadata.peakHeapUsed), 0),
        maxGrowth: snapshotMetadata.reduce((growth, metadata) => Math.max(growth, metadata.peakHeapUsed - metadata.start), 0),
        cpuTimeUs: snapshotMetadata.reduce((total, metadata) => total + metadata.cpuTimeUs, 0),
        maxSamplerGapMs: snapshotMetadata.reduce((gap, metadata) => Math.max(gap, metadata.maxSamplerGapMs), 0),
        errors: snapshotMetadata.flatMap((metadata) => metadata.failure === undefined ? [] : [metadata.failure]),
        exitSkipped: snapshotMetadata.flatMap((metadata) => metadata.exitSkipped === undefined ? [] : [metadata.exitSkipped]),
      } : undefined;
      resolvePromise({ exitCode, signal, scratchDir, profiles, heapSnapshots, heapPeakNote, heapSnapshotCaptures, heapSnapshotStats });
    });
  });
}
