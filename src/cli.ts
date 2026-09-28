// Responsibility: argument parsing (by hand, no dependency) and command dispatch for every
// `finderscope` command; the one place that turns a parsed args/JSON error into the CLI's error
// text (`error: <what>` / `do: <command>`, or `{"error", "do"}` under --json).
// Boundary: does not parse a profile or compute anything about it - profile/*.ts and model.ts do
// that. Exports `main(argv, io)` so example tests run the whole CLI in-process, without a prior
// build and without spawning a process per test. Importing this file runs nothing by itself - see
// the isInvokedDirectly() guard at the bottom, which only calls main() when this file is itself
// the script node was told to run (src/bin.ts is the file npm's own "bin" field points at; this
// guard exists so an old note that says `node dist/cli.js ...` still works instead of silently
// exiting 0 having done nothing).

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, parse as parsePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeCpuProfile, analyzeHeapProfile, buildTimeline, type ProfileAnalysis, type TimeWindow } from "./model.js";
import { analyzeHeapSnapshot, type HeapSnapshotAnalysis } from "./heapsnapshot.js";
import { detectProfileFileKind, detectProfileKind, ProfileShapeError } from "./profile/detect.js";
import { parseCpuProfile } from "./profile/cpu.js";
import { parseHeapProfile } from "./profile/heap.js";
import { parseHeapSnapshot } from "./profile/heapsnapshot.js";
import { resolveFunction } from "./query.js";
import { buildSummary, formatPercent, formatSummaryText, formatValue } from "./report/summary.js";
import { buildTop, formatTopText, type TopOptions } from "./report/top.js";
import { buildCallersPaths, buildCallersTree, buildOwnCallers, formatCallersPathsText, formatCallersTreeText, formatOwnCallersText } from "./report/callers.js";
import { buildCalleesPaths, buildCalleesTree, formatCalleesPathsText, formatCalleesTreeText } from "./report/callees.js";
import { buildDiff, formatDiffText } from "./report/diff.js";
import { buildLines, formatLinesText } from "./report/lines.js";
import { buildTimelineData, formatTimelineText } from "./report/timeline.js";
import { shQuote } from "./report/summary.js";
import { runCommand } from "./run.js";
import {
  buildHeapSnapshotRetainers,
  buildHeapSnapshotSummary,
  buildHeapSnapshotTop,
  formatHeapSnapshotRetainersText,
  formatHeapSnapshotSummaryText,
  formatHeapSnapshotTopText,
  type SnapshotTopBy,
} from "./report/heapsnapshot.js";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Every error the CLI reports carries a message and a next command, whatever raised it. */
class CliError extends Error {
  readonly do: string;
  constructor(message: string, doLine: string) {
    super(message);
    this.name = "CliError";
    this.do = doLine;
  }
}

/**
 * An error from finderscope's own code, not from the caller's profile or command line - a bug in
 * parsing, analysis, or formatting that got this far uncaught. Distinct from CliError (an expected
 * problem with the input) so the message can say so plainly instead of the generic "check the
 * profile and command", which blamed the caller for finderscope's own mistake. Keeps `cause` as
 * the real Error object (not String(e)), so a caller with access to the process (a test, or a
 * caller reading stderr with more than the CLI's own text) still has the original stack.
 */
class FinderscopeBugError extends Error {
  readonly do: string;
  constructor(message: string, doLine: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "FinderscopeBugError";
    this.do = doLine;
  }
}

/**
 * Every error the CLI already knows how to report - CliError, AmbiguousFunctionError (query.ts),
 * DiffInputError (report/diff.ts), RunInputError (run.ts), FinderscopeBugError - carries its own
 * `do` line rather than folding it into `message`. Checked structurally, not by an `instanceof`
 * list of every such class: a new report module can add its own deliberate, expected error class
 * (the way DiffInputError does for a cpu/heap metric mismatch) without cli.ts having to import it
 * just to recognize it. Anything that does NOT carry a `do` line is, by construction, a raw
 * exception finderscope's own code did not expect - a bug, not a caller mistake.
 */
function hasDoLine(e: unknown): e is Error & { do: string } {
  return e instanceof Error && typeof (e as { do?: unknown }).do === "string";
}

/**
 * Runs `fn`, and turns any error that does not already carry its own `do` line into a
 * FinderscopeBugError naming itself as a finderscope bug and keeping every given profile path in
 * its `do` line - the one thing an agent needs to re-query or attach to a report, and the one
 * thing a generic catch-all cannot know on its own.
 */
function attributeUnexpectedErrorsTo<T>(profilePaths: string[], fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (hasDoLine(e)) throw e;
    const message = e instanceof Error ? e.message : String(e);
    throw new FinderscopeBugError(
      `finderscope bug: ${message}`,
      `this is a bug in finderscope, not in your profile or command; the profile is still at ${profilePaths.join(" and ")} if you want to report it`,
      { cause: e },
    );
  }
}

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["json", "heap", "heap-peak", "heap-snapshot", "exit-on-signal", "expand", "paths"]);

/**
 * A single hand-written pass: `--name value` and `--name=value` both set an option; a flag in
 * BOOLEAN_FLAGS never consumes the next token, so `--json top.cpuprofile` doesn't swallow the
 * profile path as --json's value. A literal `--` stops flag parsing and pushes every remaining
 * token as-is into positionals, which is what `run -- <command...>` needs: the command's own
 * flags must never be parsed as finderscope's.
 */
function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-n") {
      const next = args[i + 1];
      if (next !== undefined) {
        options.set("n", next);
        i++;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        options.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const name = body;
      const next = args[i + 1];
      if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith("-")) {
        options.set(name, true);
      } else {
        options.set(name, next);
        i++;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, options };
}

function optionString(options: Map<string, string | boolean>, name: string): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Rejects a flag this command does not know about - silently ignoring it would make a typo
 *  (`--ara` instead of `--area`) look like it worked while quietly doing the wrong thing. */
function checkKnownOptions(options: Map<string, string | boolean>, allowed: Set<string>, usage: string): void {
  for (const key of options.keys()) {
    if (!allowed.has(key)) {
      throw new CliError(`unknown flag --${key}`, usage);
    }
  }
}

/** -n must be a positive integer, exactly - Number.parseInt("5abc") silently returns 5, which
 *  would make a typo look like it worked. undefined means -n was not given at all. */
function parsePositiveInt(raw: string | undefined, usage: string): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value <= 0 || String(value) !== trimmed) {
    throw new CliError(`invalid -n ${raw}`, usage);
  }
  return value;
}

function snapshotCount(n: number | undefined, command: string): number | undefined {
  if (n !== undefined && n > 500) throw new CliError(`snapshot -n ${n} exceeds the maximum 500`, `${command} -n 500`);
  return n;
}

function parsePositiveNumber(raw: string | undefined, usage: string, label = "percentage"): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) throw new CliError(`invalid ${label} ${raw}`, usage);
  return value;
}

function snapshotFile(path: string): boolean {
  try {
    return detectProfileFileKind(path) === "heap-snapshot";
  } catch {
    throw new CliError(`cannot read profile file ${path}`, `check the path: ls ${shQuote(path)}`);
  }
}

function loadHeapSnapshot(path: string): HeapSnapshotAnalysis {
  try {
    return analyzeHeapSnapshot(parseHeapSnapshot(path));
  } catch (e) {
    if (!(e instanceof ProfileShapeError)) throw e;
    throw new CliError(e.message, `open ${shQuote(path)} and check it is a heap snapshot written by Node or Chrome`);
  }
}

function readProfileJson(path: string): { json: unknown; kind: "cpu" | "heap" } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new CliError(`cannot read profile file ${path}`, `check the path: ls ${shQuote(path)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CliError(`${path} is not valid JSON`, `open ${shQuote(path)} and check it is a real .cpuprofile or .heapprofile`);
  }

  let kind: "cpu" | "heap" | "heap-snapshot";
  try {
    kind = detectProfileKind(json);
  } catch (e) {
    throw new CliError((e as Error).message, `pass a .cpuprofile, .heapprofile, or .heapsnapshot written by Node or Chrome`);
  }
  if (kind === "heap-snapshot") throw new CliError(`${path} is a heap snapshot and must be streamed`, `finderscope ${shQuote(path)}`);
  return { json, kind };
}

function loadAnalysis(path: string, root: string, window?: TimeWindow): ProfileAnalysis {
  const { json, kind } = readProfileJson(path);

  // parseCpuProfile/parseHeapProfile validate the profile's own shape (nodes, samples, ...) and
  // throw ProfileShapeError, a deliberate, expected error about a malformed file - the same kind
  // of caller-facing problem detectProfileKind's error above is, so it gets the same CliError
  // treatment. Whatever analyzeCpuProfile/analyzeHeapProfile does past that point works on an
  // already-valid profile; an error from there is not caught here on purpose, so it reaches
  // attributeUnexpectedErrorsTo's wrapper around this whole call and is named a finderscope bug
  // instead - which is what the padEnd crash this fixed actually was.
  try {
    if (kind === "cpu") {
      return analyzeCpuProfile(parseCpuProfile(json), { root, window });
    }
    // A heap profile has no timestamps at all - a real caller mistake to report as such, not
    // silently ignored (which would make --from/--to look like it worked) and not a finderscope
    // bug (there is nothing wrong with the profile itself).
    if (window !== undefined) {
      throw new CliError(
        `${path} is a heap profile - it has no timestamps, so --from/--to only works on a .cpuprofile`,
        `open ${shQuote(path)} without --from/--to`,
      );
    }
    return analyzeHeapProfile(parseHeapProfile(json), { root });
  } catch (e) {
    if (!(e instanceof ProfileShapeError)) throw e;
    throw new CliError(e.message, `open ${shQuote(path)} and check its nodes/samples/timeDeltas, or its head, shape`);
  }
}

/**
 * Loads a cpu profile for `timeline` specifically - never windowed (a timeline exists to let an
 * agent pick a window in the first place) and never valid for a heap profile (no timestamps at
 * all), the same rule loadAnalysis enforces for --from/--to.
 */
function loadCpuProfileForTimeline(path: string) {
  const { json, kind } = readProfileJson(path);
  if (kind !== "cpu") {
    throw new CliError(
      `${path} is a heap profile - it has no timestamps, so timeline only works on a .cpuprofile`,
      `run finderscope ${shQuote(path)} instead`,
    );
  }
  try {
    return parseCpuProfile(json);
  } catch (e) {
    if (!(e instanceof ProfileShapeError)) throw e;
    throw new CliError(e.message, `open ${shQuote(path)} and check its nodes/samples/timeDeltas, or its head, shape`);
  }
}

/**
 * Parses `--from <ms>`/`--to <ms>` (decimal MILLISECONDS, converted to integer microseconds) into
 * a half-open TimeWindow, plus the exact `--from .../--to ...` suffix every do:/cut-hint command in
 * the same report must carry so the next command an agent runs does not silently drop the window.
 * Both are offsets from the profile's own observed span start (model.ts's samplePosition -
 * NormalizedCpuProfile.spanStart, the first sample's own position, not absolute zero: a real
 * profile always has a nonzero gap, timeDeltas[0], before its first sample even exists), so `--from
 * 0` means "starting at the first sample", the same point `timeline`'s bucket 0 starts from.
 * Requires BOTH flags together, never just one: an open-ended window would need either an Infinity
 * (not valid JSON) or the profile's own span (which loadAnalysis does not know before it has
 * already analyzed the profile) as its missing bound - requiring both sidesteps that with no loss
 * an agent would actually miss, since "from the start" is `--from 0` and "to the end" needs the end
 * anyway, which `timeline` prints for every bucket.
 */
function parseWindow(options: Map<string, string | boolean>, usage: string): { window: TimeWindow | undefined; windowArgs: string } {
  const fromRaw = optionString(options, "from");
  const toRaw = optionString(options, "to");
  if (fromRaw === undefined && toRaw === undefined) return { window: undefined, windowArgs: "" };
  if (fromRaw === undefined || toRaw === undefined) {
    throw new CliError("--from and --to must be given together", usage);
  }
  const fromMs = Number(fromRaw.trim());
  const toMs = Number(toRaw.trim());
  if (!Number.isFinite(fromMs) || fromMs < 0) throw new CliError(`invalid --from ${fromRaw}`, usage);
  if (!Number.isFinite(toMs) || toMs < 0) throw new CliError(`invalid --to ${toRaw}`, usage);
  if (toMs < fromMs) throw new CliError(`--to ${toRaw} is before --from ${fromRaw}`, usage);
  const window: TimeWindow = { from: Math.round(fromMs * 1000), to: Math.round(toMs * 1000) };
  return { window, windowArgs: ` --from ${fromRaw} --to ${toRaw}` };
}

function printError(io: Io, json: boolean, message: string, doLine: string, suggestions: string[] = []): number {
  const commands = [...new Set([doLine, ...suggestions])];
  if (json) {
    const extra = commands.length > 1 ? { suggestions: commands } : {};
    io.stdout(`${JSON.stringify({ error: message, do: doLine, ...extra })}\n`);
  } else {
    io.stdout(`error: ${message}\n${commands.map((command) => `do: ${command}`).join("\n")}\n`);
  }
  return 1;
}

// Every placeholder is single-quoted: an unquoted `<name>` is a real shell redirection operator
// followed by a bare word with no matching closing target, a genuine syntax error under `sh -c`
// or `sh -n -c` - not just a cosmetic choice, since this whole string is a `do:` line too.
/**
 * The "no profile written" warning + do:, for `run`. Exported so a test can check both branches
 * directly against a known `signal` value, rather than relying on a real child process actually
 * ending via a signal with no profile - confirmed by hand not to be reliable to reproduce: a
 * child self-signaled with SIGKILL right after starting still had its --cpu-prof profile written,
 * because Node had already flushed something to disk in the time before the signal was delivered.
 * V8 only writes a --cpu-prof/--heap-prof file on a NORMAL exit - an uncatchably killed or crashed
 * child may never get the chance, which is a different, expected
 * reason to see no profile than the "did this even run node" question a normal exit with no
 * profile raises.
 */
export function noProfileWarning(signal: NodeJS.Signals | null): { message: string; do: string } {
  if (signal !== null) {
    return {
      message: `no profile was written - the command ended via ${signal}, and V8 only writes a --cpu-prof/--heap-prof file on a normal exit`,
      do: "rerun without sending the command a signal, so it can exit normally and write its profile",
    };
  }
  return {
    message: "no profile was written - the command may not have run a Node process at all, or a child process spawned with a cleared environment never saw NODE_OPTIONS",
    do: "confirm the command runs node (echo $NODE_OPTIONS inside it), or pass --heap too if you expected a heap profile instead of a cpu one",
  };
}

const USAGE =
  "usage: finderscope '<profile>' [--from ms --to ms] | top '<profile>' | retainers '<snapshot>' '<constructor-or-#id>' | callers '<profile>' '<fn>' | callees '<profile>' '<fn>' | lines '<profile>' '<fn>' | diff '<before>' '<after>' | run [--heap] [--heap-peak] [--heap-snapshot] [--exit-on-signal] -- '<command...>' | timeline '<profile>' | help";

/** Every token before the first literal "--" (run's own child-command separator) - a "-h"/"--help"
 *  AFTER that boundary belongs to the profiled command, not to finderscope itself, and must never
 *  trigger finderscope's own help instead of actually running it. */
function wantsHelp(rest: string[]): boolean {
  const dashDashIdx = rest.indexOf("--");
  const scanned = dashDashIdx === -1 ? rest : rest.slice(0, dashDashIdx);
  return scanned.includes("-h") || scanned.includes("--help");
}

// A real, concrete, always-runnable example - never a "finderscope ..." command with a
// <placeholder> in it (the sh -n test's own rule: a "finderscope " command may never carry an
// unresolved placeholder), since there is no profile in hand yet at the moment --help is read.
const HELP_DO = "finderscope run -- node your-script.js";

const COMMAND_HELP: Record<string, string> = {
  summary: "finderscope '<profile>' [--root dir] [--from ms --to ms] [--json]\nfinderscope '<snapshot>' [-n N] [--json]\n  Own functions ranked by caused cost, work without an own frame, and do:.",
  top: "finderscope top '<profile>' [--by caused|self|total|root] [--leaf function] [--area area] [--from ms --to ms] [-n N] [--json]\nfinderscope top '<snapshot>' [--by retained|self|count] [-n N] [--json]\n  Own functions ranked by caused cost by default.",
  retainers: "finderscope retainers '<snapshot>' '<constructor-or-#id>' [-n N] [--json]\n  The retaining paths into one constructor group or object.",
  callers: "finderscope callers '<profile>' '<function>' [--direct|--paths] [--expand] [--from ms --to ms] [-n N] [--json]\n  Non-own targets group paths by the nearest own caller. --direct shows the prior caller tree.",
  callees: "finderscope callees '<profile>' '<function>' [--expand] [--paths] [--from ms --to ms] [-n N] [--json]\n  Where the function's own total time goes.",
  lines: "finderscope lines '<profile>' '<function>' [--from ms --to ms] [-n N] [--json]\n  The hot lines inside the function's own body.",
  diff: "finderscope diff '<before>' '<after>' [-n N] [--json]\n  The functions and areas whose share changed most.",
  run: "finderscope run [--child-output capture|inherit] [--heap] [--heap-peak] [--heap-snapshot] [--heap-snapshot-threshold percent] [--heap-snapshot-min MB] [--exit-on-signal] [--root dir] [--json] -- '<command...>'\n  Captures child output, then prints bounded tails and the report.",
  timeline: "finderscope timeline '<profile>' [--json]\n  20 equal time buckets, each with the top own function by self time - pick a --from/--to window from this.",
};

// Stated once, in full words, alongside every "ms" in a usage line above it - "ms" alone in a
// usage string reads as a value the caller types, not a unit; this line makes the unit explicit.
const FROM_TO_UNIT_NOTE = "--from/--to are milliseconds, offset from the profile's own start. summary, top, callers, callees and lines accept them.";
// Only these commands take a window; diff, run and timeline reject --from/--to.
const WINDOW_COMMANDS = new Set(["summary", "top", "callers", "callees", "lines"]);

function defaultRoot(cwd: string): string {
  const ancestors: string[] = [];
  let current = cwd;
  for (;;) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current || current === parsePath(current).root) break;
    current = parent;
  }
  const git = ancestors.find((dir) => existsSync(`${dir}/.git`));
  if (git !== undefined) return git;
  return ancestors.find((dir) => existsSync(`${dir}/package.json`)) ?? cwd;
}

function globalHelpText(): string {
  const lines = ["finderscope: turn a V8 profile into a short, ranked report and name the next command", ""];
  for (const text of Object.values(COMMAND_HELP)) lines.push(text, "");
  lines.push(FROM_TO_UNIT_NOTE, "");
  lines.push(`do: ${HELP_DO}`);
  return lines.join("\n");
}

function subcommandHelpText(subcommand: string): string {
  const text = COMMAND_HELP[subcommand] ?? COMMAND_HELP["summary"]!;
  const note = WINDOW_COMMANDS.has(subcommand) ? `\n\n${FROM_TO_UNIT_NOTE}` : "";
  return `${text}${note}\n\ndo: ${HELP_DO}`;
}

async function dispatch(argv: string[], io: Io): Promise<number> {
  if (argv.length === 0) {
    throw new CliError("no command or profile given", USAGE);
  }

  const KNOWN_SUBCOMMANDS = new Set(["top", "retainers", "callers", "callees", "lines", "diff", "run", "timeline", "help"]);
  const first = argv[0]!;
  const subcommand = KNOWN_SUBCOMMANDS.has(first) ? first : "summary";
  const rest = subcommand === "summary" ? argv : argv.slice(1);

  if (subcommand === "help") {
    io.stdout(`${globalHelpText()}\n`);
    return 0;
  }
  if (wantsHelp(rest)) {
    io.stdout(`${subcommand === "summary" ? globalHelpText() : subcommandHelpText(subcommand)}\n`);
    return 0;
  }

  const { positionals, options } = parseArgs(rest);
  const json = options.get("json") === true;
  const root = optionString(options, "root") ?? defaultRoot(process.cwd());

  switch (subcommand) {
    case "summary": {
      const profilePath = positionals[0];
      if (profilePath === undefined) throw new CliError("no profile given", USAGE);
      if (snapshotFile(profilePath)) {
        checkKnownOptions(options, new Set(["json", "from", "to", "n"]), USAGE);
        if (options.has("from") || options.has("to")) {
          throw new CliError(`${profilePath} is a heap snapshot - --from/--to only works on a .cpuprofile`, `finderscope ${shQuote(profilePath)}`);
        }
        return attributeUnexpectedErrorsTo([profilePath], () => {
          const n = parsePositiveInt(optionString(options, "n"), `finderscope ${shQuote(profilePath)} -n '<positive integer>'`);
          const data = buildHeapSnapshotSummary(loadHeapSnapshot(profilePath), profilePath, snapshotCount(n, `finderscope ${shQuote(profilePath)}`));
          io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatHeapSnapshotSummaryText(data, profilePath)}\n`);
          return 0;
        });
      }
      checkKnownOptions(options, new Set(["json", "root", "from", "to"]), USAGE);
      const { window, windowArgs } = parseWindow(options, `finderscope ${shQuote(profilePath)} --from ms --to ms`);
      return attributeUnexpectedErrorsTo([profilePath], () => {
        const analysis = loadAnalysis(profilePath, root, window);
        const data = buildSummary(analysis, profilePath, window, windowArgs);
        io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatSummaryText(data, profilePath, windowArgs)}\n`);
        return 0;
      });
    }

    case "top": {
      const profilePath = positionals[0];
      if (profilePath === undefined) throw new CliError("no profile given", `finderscope top '<profile>'`);
      checkKnownOptions(options, new Set(["json", "root", "by", "leaf", "area", "n", "from", "to"]), `finderscope top ${shQuote(profilePath)}`);
      const n = parsePositiveInt(optionString(options, "n"), `finderscope top ${shQuote(profilePath)} -n '<positive integer>'`);
      const by = optionString(options, "by");
      if (snapshotFile(profilePath)) {
        if (options.has("root")) {
          throw new CliError(`${profilePath} is a heap snapshot - --root does not apply`, `finderscope top ${shQuote(profilePath)} --by self`);
        }
        if (options.has("leaf") || options.has("area") || options.has("from") || options.has("to")) {
          throw new CliError(`${profilePath} is a heap snapshot - --leaf, --area and --from/--to do not apply`, `finderscope top ${shQuote(profilePath)} --by retained`);
        }
        if (by !== undefined && by !== "retained" && by !== "self" && by !== "count") {
          throw new CliError(`invalid --by ${by}; use retained, self or count for a heap snapshot`, `finderscope top ${shQuote(profilePath)} --by retained`);
        }
        return attributeUnexpectedErrorsTo([profilePath], () => {
          const data = buildHeapSnapshotTop(loadHeapSnapshot(profilePath), profilePath, (by ?? "self") as SnapshotTopBy, snapshotCount(n, `finderscope top ${shQuote(profilePath)} --by ${by ?? "self"}`));
          io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatHeapSnapshotTopText(data, profilePath)}\n`);
          return 0;
        });
      }
      if (by !== undefined && by !== "caused" && by !== "self" && by !== "total" && by !== "root") {
        throw new CliError(`invalid --by ${by}; use caused, self, total or root`,`finderscope top ${shQuote(profilePath)}`);
      }
      if (options.has("leaf") && by !== undefined && by !== "caused") {
        throw new CliError("--leaf filters caused cost and requires --by caused", `finderscope top ${shQuote(profilePath)} --by caused --leaf '<function>'`);
      }
      const { window, windowArgs } = parseWindow(options, `finderscope top ${shQuote(profilePath)} --from ms --to ms`);
      return attributeUnexpectedErrorsTo([profilePath], () => {
        const analysis = loadAnalysis(profilePath, root, window);
        const topOptions: TopOptions = { area: optionString(options, "area"), n };
        if (by !== undefined) topOptions.by = by;
        const leafQuery = optionString(options, "leaf");
        if (leafQuery !== undefined) {
          topOptions.leaf = resolveFunction(
            analysis,
            leafQuery,
            `finderscope top ${shQuote(profilePath)}`,
            root,
            (key) => `finderscope top ${shQuote(profilePath)} --leaf ${shQuote(key)}${windowArgs}`,
          ).key;
        }
        const data = buildTop(analysis, profilePath, topOptions, windowArgs);
        io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatTopText(data, profilePath, windowArgs)}\n`);
        return 0;
      });
    }

    case "retainers": {
      const profilePath = positionals[0];
      const query = positionals[1];
      if (profilePath === undefined || query === undefined) throw new CliError("need a heap snapshot and a constructor or node id", `finderscope retainers '<snapshot>' '<constructor-or-#id>'`);
      checkKnownOptions(options, new Set(["json", "n"]), `finderscope retainers ${shQuote(profilePath)} ${shQuote(query)}`);
      const n = parsePositiveInt(optionString(options, "n"), `finderscope retainers ${shQuote(profilePath)} ${shQuote(query)} -n '<positive integer>'`);
      if (!snapshotFile(profilePath)) throw new CliError(`${profilePath} is not a heap snapshot`, `finderscope ${shQuote(profilePath)}`);
      return attributeUnexpectedErrorsTo([profilePath], () => {
        const data = buildHeapSnapshotRetainers(loadHeapSnapshot(profilePath), profilePath, query, snapshotCount(n, `finderscope retainers ${shQuote(profilePath)} ${shQuote(query)}`));
        io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatHeapSnapshotRetainersText(data, profilePath)}\n`);
        return 0;
      });
    }

    case "callers":
    case "callees": {
      const profilePath = positionals[0];
      const query = positionals[1];
      if (profilePath === undefined || query === undefined) {
        throw new CliError("need a profile and a function", `finderscope ${subcommand} '<profile>' '<function>'`);
      }
      checkKnownOptions(options, new Set(["json", "root", "expand", "paths", "direct", "n", "from", "to"]), `finderscope ${subcommand} ${shQuote(profilePath)} ${shQuote(query)}`);
      if (snapshotFile(profilePath)) {
        throw new CliError(`${subcommand} does not apply to a heap snapshot; use retainers`, `finderscope retainers ${shQuote(profilePath)} ${shQuote(query)}`);
      }
      const n = parsePositiveInt(
        optionString(options, "n"),
        `finderscope ${subcommand} ${shQuote(profilePath)} '<function>' -n '<positive integer>'`,
      );
      const paths = options.get("paths") === true;
      const direct = options.get("direct") === true;
      const expand = options.get("expand") === true;
      const { window, windowArgs } = parseWindow(options, `finderscope ${subcommand} ${shQuote(profilePath)} ${shQuote(query)} --from ms --to ms`);
      return attributeUnexpectedErrorsTo([profilePath], () => {
        const analysis = loadAnalysis(profilePath, root, window);
        const fn = resolveFunction(
          analysis,
          query,
          `finderscope top ${shQuote(profilePath)}`,
          root,
          (key) => `finderscope ${subcommand} ${shQuote(profilePath)} ${shQuote(key)}${windowArgs}`,
        );
        if (subcommand === "callers") {
          if (paths) {
            const data = buildCallersPaths(analysis, fn, profilePath, n, windowArgs);
            io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatCallersPathsText(data, profilePath, windowArgs)}\n`);
          } else if (fn.area !== "own" && !direct) {
            const data = buildOwnCallers(analysis, fn, profilePath, n, windowArgs);
            io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatOwnCallersText(data, profilePath, windowArgs)}\n`);
          } else {
            const data = buildCallersTree(analysis, fn, profilePath, { expand, n }, windowArgs);
            io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatCallersTreeText(data, profilePath, windowArgs)}\n`);
          }
        } else {
          if (paths) {
            const data = buildCalleesPaths(analysis, fn, profilePath, n, windowArgs);
            io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatCalleesPathsText(data, profilePath, windowArgs)}\n`);
          } else {
            const data = buildCalleesTree(analysis, fn, profilePath, { expand, n }, windowArgs);
            io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatCalleesTreeText(data, profilePath, windowArgs)}\n`);
          }
        }
        return 0;
      });
    }

    case "lines": {
      const profilePath = positionals[0];
      const query = positionals[1];
      if (profilePath === undefined || query === undefined) {
        throw new CliError("need a profile and a function", `finderscope lines '<profile>' '<function>'`);
      }
      checkKnownOptions(options, new Set(["json", "root", "n", "from", "to"]), `finderscope lines ${shQuote(profilePath)} ${shQuote(query)}`);
      if (snapshotFile(profilePath)) throw new CliError(`lines does not apply to a heap snapshot`, `finderscope retainers ${shQuote(profilePath)} ${shQuote(query)}`);
      const n = parsePositiveInt(
        optionString(options, "n"),
        `finderscope lines ${shQuote(profilePath)} ${shQuote(query)} -n '<positive integer>'`,
      );
      const { window, windowArgs } = parseWindow(options, `finderscope lines ${shQuote(profilePath)} ${shQuote(query)} --from ms --to ms`);
      return attributeUnexpectedErrorsTo([profilePath], () => {
        const analysis = loadAnalysis(profilePath, root, window);
        const fn = resolveFunction(
          analysis,
          query,
          `finderscope top ${shQuote(profilePath)}`,
          root,
          (key) => `finderscope lines ${shQuote(profilePath)} ${shQuote(key)}${windowArgs}`,
        );
        const data = buildLines(analysis, fn, profilePath, n, windowArgs);
        io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatLinesText(data, profilePath, windowArgs)}\n`);
        return 0;
      });
    }

    case "timeline": {
      checkKnownOptions(options, new Set(["json", "root"]), `finderscope timeline '<profile>'`);
      const profilePath = positionals[0];
      if (profilePath === undefined) throw new CliError("no profile given", `finderscope timeline '<profile>'`);
      if (snapshotFile(profilePath)) throw new CliError(`timeline does not apply to a heap snapshot`, `finderscope ${shQuote(profilePath)}`);
      return attributeUnexpectedErrorsTo([profilePath], () => {
        const profile = loadCpuProfileForTimeline(profilePath);
        const buckets = buildTimeline(profile, root);
        const data = buildTimelineData(buckets, profile.totalDuration, profilePath);
        io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatTimelineText(data, profilePath)}\n`);
        return 0;
      });
    }

    case "diff": {
      const beforePath = positionals[0];
      const afterPath = positionals[1];
      if (beforePath === undefined || afterPath === undefined) {
        throw new CliError("need two profiles", `finderscope diff '<before>' '<after>'`);
      }
      checkKnownOptions(options, new Set(["json", "root", "n"]), `finderscope diff ${shQuote(beforePath)} ${shQuote(afterPath)}`);
      const n = parsePositiveInt(
        optionString(options, "n"),
        `finderscope diff ${shQuote(beforePath)} ${shQuote(afterPath)} -n '<positive integer>'`,
      );
      if (snapshotFile(beforePath) || snapshotFile(afterPath)) {
        throw new CliError("snapshot diff is not available; constructor retained-size and count deltas need a distinct output shape", `finderscope ${shQuote(afterPath)}`);
      }
      return attributeUnexpectedErrorsTo([beforePath, afterPath], () => {
        const before = loadAnalysis(beforePath, root);
        const after = loadAnalysis(afterPath, root);
        const data = buildDiff(before, after, beforePath, afterPath, n);
        io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatDiffText(data, beforePath, afterPath)}\n`);
        return 0;
      });
    }

    case "run": {
      checkKnownOptions(options, new Set(["json", "root", "child-output", "heap", "heap-peak", "heap-snapshot", "heap-snapshot-threshold", "heap-snapshot-min", "exit-on-signal"]), "finderscope run [--child-output capture|inherit] [--heap] [--heap-peak] [--heap-snapshot] [--exit-on-signal] -- '<command...>'");
      const heap = options.get("heap") === true;
      const heapPeak = options.get("heap-peak") === true;
      const heapSnapshot = options.get("heap-snapshot") === true;
      const exitOnSignal = options.get("exit-on-signal") === true;
      const childOutputValue = optionString(options, "child-output") ?? "capture";
      if (childOutputValue !== "capture" && childOutputValue !== "inherit") {
        throw new CliError(`invalid --child-output ${childOutputValue}; use capture or inherit`, "finderscope run --child-output inherit -- '<command...>'");
      }
      const childOutput = childOutputValue as "capture" | "inherit";
      const heapSnapshotThreshold = parsePositiveNumber(
        optionString(options, "heap-snapshot-threshold"),
        "finderscope run --heap-snapshot --heap-snapshot-threshold '<percent>' -- '<command...>'",
      );
      const heapSnapshotMinMb = parsePositiveNumber(
        optionString(options, "heap-snapshot-min"),
        "finderscope run --heap-snapshot --heap-snapshot-min '<MB>' -- '<command...>'",
        "MB value",
      );
      if (heapSnapshotThreshold !== undefined && !heapSnapshot) {
        throw new CliError("--heap-snapshot-threshold requires --heap-snapshot", "finderscope run --heap-snapshot --heap-snapshot-threshold 25 -- '<command...>'");
      }
      if (heapSnapshotMinMb !== undefined && !heapSnapshot) {
        throw new CliError("--heap-snapshot-min requires --heap-snapshot", "finderscope run --heap-snapshot --heap-snapshot-min 64 -- '<command...>'");
      }
      const buildRunRerun = (snapshotMinimum: number | undefined, withExitOnSignal: boolean): string => {
        const args = ["finderscope run"];
        if (heap) args.push("--heap");
        if (heapPeak) args.push("--heap-peak");
        if (heapSnapshot) args.push("--heap-snapshot");
        if (heapSnapshotThreshold !== undefined) args.push(`--heap-snapshot-threshold ${heapSnapshotThreshold}`);
        if (snapshotMinimum !== undefined) args.push(`--heap-snapshot-min ${snapshotMinimum}`);
        if (withExitOnSignal || exitOnSignal) args.push("--exit-on-signal");
        if (childOutput === "inherit") args.push("--child-output inherit");
        const requestedRoot = optionString(options, "root");
        if (requestedRoot !== undefined) args.push(`--root ${shQuote(requestedRoot)}`);
        if (json) args.push("--json");
        args.push("--", ...positionals.map(shQuote));
        return args.join(" ");
      };
      const result = await runCommand({ heap, heapPeak, heapSnapshot, heapSnapshotThreshold, heapSnapshotMinMb, exitOnSignal, childOutput, command: positionals });

      // Never deleted, on purpose - stated here, not just in the README/design.md, since this is
      // the one moment an agent actually needs to know it can come back to this exact path.
      const scratchNote = `scratch dir: ${result.scratchDir} (kept on purpose - re-query it with finderscope callers/callees/top/retainers)`;
      const heapSnapshotNote =
        result.heapSnapshots.length > 0
          ? `heap snapshot: ${result.heapSnapshots.map((path) => {
              const capture = result.heapSnapshotCaptures.find((item) => item.path === path);
              return capture === undefined ? path : `${path} (thread ${capture.threadId})`;
            }).join(", ")}`
          : undefined;
      const snapshotStats = result.heapSnapshotStats;
      const captureNote = snapshotStats === undefined ? undefined : snapshotStats.snapshotsWritten > 0
        ? `${snapshotStats.snapshotsWritten} heap ${snapshotStats.snapshotsWritten === 1 ? "snapshot" : "snapshots"} written; snapshot writing used ${formatValue("time", snapshotStats.cpuTimeUs)} CPU time and can need about the heap size in extra memory`
        : `0 heap snapshots written; snapshot writing used ${formatValue("time", snapshotStats.cpuTimeUs)} CPU time; no snapshot qualified; peak heapUsed ${formatValue("bytes", snapshotStats.peakHeapUsed)}; minimum growth was ${heapSnapshotMinMb ?? 64}MB`;
      const heapSnapshotGapNote = snapshotStats !== undefined && snapshotStats.maxSamplerGapMs > 1000
        ? `the heap sampler could not run for ${formatValue("time", snapshotStats.maxSamplerGapMs * 1000)} at a time because synchronous work blocked it; a peak inside that stretch may be missed; find the peak time with finderscope run --heap-peak, then call v8.writeHeapSnapshot() at that point in the program`
        : undefined;
      // A snapshot taken after the program dropped its data (typically at exit) holds only what is
      // still live. Presenting it as the peak without saying so would send an agent after the wrong
      // retainers.
      const garbageCapture = result.heapSnapshotCaptures.find((capture) =>
        capture.liveAfter !== undefined && capture.liveAfter < capture.heapUsed / 2);
      const heapSnapshotGarbageNote = garbageCapture === undefined
        ? undefined
        : `the snapshot holds about ${formatValue("bytes", garbageCapture.liveAfter!)} of live objects, but heapUsed was ${formatValue("bytes", garbageCapture.heapUsed)} at capture; the rest was already garbage, so the peak's retainers may be gone; find the peak time with finderscope run --heap-peak, then call v8.writeHeapSnapshot() at that point in the program`;
      const heapSnapshotErrorNote = snapshotStats?.errors[0] === undefined
        ? undefined
        : `heap snapshot sampling stopped after an error: ${snapshotStats.errors[0]}`;
      const heapSnapshotExitNote = (snapshotStats?.exitSkipped.length ?? 0) === 0
        ? undefined
        : `the exit-time heap snapshot was skipped near the heap limit`;
      const configuredFloor = heapSnapshotMinMb ?? 64;
      const observedGrowthMb = snapshotStats === undefined ? 0 : snapshotStats.maxGrowth / (1024 * 1024);
      const lowerFloor = snapshotStats === undefined ? undefined : Math.min(configuredFloor / 2, observedGrowthMb || configuredFloor / 2);
      const snapshotRetryDo = snapshotStats?.snapshotsWritten === 0
        ? buildRunRerun(lowerFloor, false)
        : undefined;

      if (result.profiles.length === 0 && result.heapSnapshots.length === 0) {
        // A heap snapshot near the limit is real, useful output even when the command crashed
        // before it could write a normal --cpu-prof/--heap-prof profile (an OOM kill routinely
        // ends the process via a signal right after the snapshot itself was flushed to disk) -
        // "rerun without sending it a signal" is the wrong advice here: nothing finderscope did
        // sent that signal, and rerunning changes nothing about the crash. Point at the file that
        // already exists instead.
        const warning =
          result.heapSnapshots.length > 0
            ? {
                message: "no cpu/heap profile was written - the command likely crashed while writing its heap snapshot near the limit, but that snapshot was written",
                do: `ls -la ${shQuote(result.heapSnapshots[0]!)}`,
              }
            : noProfileWarning(result.signal);
        if (json) {
          const reportPath = `${result.scratchDir}/report.json`;
          const payload = { scratchDir: result.scratchDir, child: { exitCode: result.exitCode, stdout: { path: result.childStdoutPath, tail: result.childStdoutTail }, stderr: { path: result.childStderrPath, tail: result.childStderrTail } }, profiles: [], errors: [], heapSnapshots: result.heapSnapshots, heapSnapshotCaptures: result.heapSnapshotCaptures, heapSnapshotStats: result.heapSnapshotStats, heapSnapshotNote: captureNote, heapSnapshotGapNote, heapSnapshotGarbageNote, heapSnapshotErrorNote, heapSnapshotExitNote, heapPeakNote: result.heapPeakNote, warning: warning.message, report: reportPath, do: snapshotRetryDo ?? warning.do };
          writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`);
          io.stdout(`${JSON.stringify(payload)}\n`);
        } else {
          const extra = [heapSnapshotNote, captureNote, heapSnapshotGapNote, heapSnapshotGarbageNote, heapSnapshotErrorNote, heapSnapshotExitNote, result.heapPeakNote].filter((s): s is string => s !== undefined).map((s) => `note: ${s}\n`).join("");
          const reportPath = `${result.scratchDir}/report.txt`;
          writeFileSync(reportPath, `warning: ${warning.message}\ndo: ${snapshotRetryDo ?? warning.do}\n`);
          io.stdout(`${scratchNote}\nchild exit: ${result.exitCode}\nchild stdout: ${result.childStdoutPath}\n${result.childStdoutTail.map((line) => `  ${line}\n`).join("")}child stderr: ${result.childStderrPath}\n${result.childStderrTail.map((line) => `  ${line}\n`).join("")}${extra}warning: ${warning.message}\nreport: ${reportPath}\ndo: ${snapshotRetryDo ?? warning.do}\n`);
        }
        return result.exitCode;
      }

      const summaries: unknown[] = [];
      const errors: { profile: string; error: string; do: string }[] = [];
      const textBlocks: string[] = [];
      let firstDo: string | undefined;
      let cpuProfiles = 0;
      let allCpuProfilesIdle = true;

      for (const profilePath of [...result.profiles, ...result.heapSnapshots]) {
        try {
          const data = attributeUnexpectedErrorsTo([profilePath], () => {
            if (snapshotFile(profilePath)) return buildHeapSnapshotSummary(loadHeapSnapshot(profilePath), profilePath);
            const analysis = loadAnalysis(profilePath, root);
            if (analysis.metric === "time") {
              cpuProfiles++;
              const idleShare = analysis.total > 0 ? (analysis.areaTotals.get("idle") ?? 0) / analysis.total : 0;
              allCpuProfilesIdle &&= idleShare >= 0.8;
            }
            return buildSummary(analysis, profilePath);
          });
          summaries.push(data);
          if (snapshotFile(profilePath)) {
            textBlocks.push(formatHeapSnapshotSummaryText(data as ReturnType<typeof buildHeapSnapshotSummary>, profilePath));
            firstDo ??= data.do;
          } else {
            const summary = data as ReturnType<typeof buildSummary>;
            const idleValue = summary.notCaused.find((row) => row.area === "idle")?.value ?? 0;
            const idleShare = summary.total > 0 ? idleValue / summary.total : 0;
            if (summary.metric === "time" && idleShare >= 0.8) {
              const open = `finderscope ${shQuote(profilePath)}`;
              textBlocks.push(`${profilePath}: idle ${formatPercent(idleShare)}, total ${formatValue(summary.metric, summary.total)}\n\ndo: ${open}`);
              firstDo ??= open;
            } else {
              textBlocks.push(formatSummaryText(summary, profilePath, "", `command: ${positionals.map(shQuote).join(" ")}`));
              firstDo ??= data.do;
            }
          }
        } catch (e) {
          // One bad profile must not hide the others `run` already wrote - report it inline and
          // keep going, rather than aborting the whole summarization loop.
          if (hasDoLine(e)) {
            errors.push({ profile: profilePath, error: e.message, do: e.do });
            textBlocks.push(`error: ${e.message}\ndo: ${e.do}`);
            firstDo ??= e.do;
          }
        }
      }

      const idleNote = cpuProfiles > 0 && allCpuProfilesIdle
        ? "every CPU profile was at least 80% idle; a child may have ended by a signal, run native code, or done work in a process that was not Node. --exit-on-signal keeps the profile of a child ended by SIGTERM, SIGINT, or SIGHUP, but a child busy in synchronous code then exits only when it yields"
        : undefined;
      const idleDo = idleNote === undefined
        ? undefined
        : buildRunRerun(heapSnapshotMinMb, true);
      const overallDo = snapshotRetryDo ?? idleDo ?? firstDo ?? "finderscope run -- '<command...>'";
      const childData = {
        exitCode: result.exitCode,
        stdout: { path: result.childStdoutPath, tail: result.childStdoutTail },
        stderr: { path: result.childStderrPath, tail: result.childStderrTail },
      };
      if (json) {
        const reportPath = `${result.scratchDir}/report.json`;
        const payload = { scratchDir: result.scratchDir, child: childData, profiles: summaries, errors, heapSnapshots: result.heapSnapshots, heapSnapshotCaptures: result.heapSnapshotCaptures, heapSnapshotStats: result.heapSnapshotStats, heapSnapshotNote: captureNote, heapSnapshotGapNote, heapSnapshotGarbageNote, heapSnapshotErrorNote, heapSnapshotExitNote, heapPeakNote: result.heapPeakNote, idleNote, report: reportPath, do: overallDo };
        writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`);
        io.stdout(`${JSON.stringify(payload)}\n`);
      } else {
        const extra = [heapSnapshotNote, captureNote, heapSnapshotGapNote, heapSnapshotGarbageNote, heapSnapshotErrorNote, heapSnapshotExitNote, result.heapPeakNote, idleNote].filter((s): s is string => s !== undefined).map((s) => `note: ${s}\n`).join("");
        const reportPath = `${result.scratchDir}/report.txt`;
        const reportBody = `${textBlocks.join("\n\n")}\n`;
        writeFileSync(reportPath, reportBody);
        const visibleBlocks = textBlocks.map((block) => block.replace(/\n\ndo: [^\n]+$/, ""));
        const childLines = [
          `child exit: ${result.exitCode}`,
          `child stdout: ${result.childStdoutPath}`,
          ...result.childStdoutTail.map((line) => `  ${line}`),
          `child stderr: ${result.childStderrPath}`,
          ...result.childStderrTail.map((line) => `  ${line}`),
        ].join("\n");
        io.stdout(`${scratchNote}\n${childLines}\n${extra}\n${visibleBlocks.join("\n\n")}\nreport: ${reportPath}\ndo: ${overallDo}\n`);
      }
      return result.exitCode;
    }

    default:
      throw new CliError(`unknown command ${subcommand}`, USAGE);
  }
}

export async function main(argv: string[], io: Io): Promise<number> {
  // --json is read again here, independent of dispatch, so a parse failure that happens before
  // dispatch can pick its own args (a missing profile path, for instance) still honors --json.
  const json = argv.includes("--json");
  try {
    return await dispatch(argv, io);
  } catch (e) {
    if (hasDoLine(e)) {
      const rawSuggestions = (e as Error & { do: string; suggestions?: unknown }).suggestions;
      const suggestions = Array.isArray(rawSuggestions)
        ? rawSuggestions.filter((value): value is string => typeof value === "string")
        : [];
      return printError(io, json, e.message, e.do, suggestions);
    }
    // Reached only by a bug outside attributeUnexpectedErrorsTo's reach (argument parsing itself,
    // before dispatch picks a profile path) - still a finderscope bug, not the caller's problem.
    const message = e instanceof Error ? e.message : String(e);
    return printError(io, json, `finderscope bug: ${message}`, "this is a bug in finderscope, not in your profile or command");
  }
}

/**
 * True only when this file is itself the script node was told to run - not merely imported (by a
 * test, or by src/bin.ts). Compares argv[1] against this module's own path, both realpathed and
 * turned into a comparable file:// URL: a plain string comparison of import.meta.url against
 * `file://${process.argv[1]}` (the previous check) failed whenever either side reached this file
 * through a symlink, since a symlink's path and its target's real path are different strings that
 * name the same file - silently leaving main() never called, a bare `exit 0` with no output at
 * all, the worst possible failure for an agent that just ran the command.
 */
function isInvokedDirectly(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    const invokedUrl = pathToFileURL(realpathSync(invoked)).href;
    const selfUrl = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return invokedUrl === selfUrl;
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  const io: Io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  main(process.argv.slice(2), io).then((code) => {
    process.exitCode = code;
  });
}
