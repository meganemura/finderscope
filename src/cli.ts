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

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeCpuProfile, analyzeHeapProfile, buildTimeline, type ProfileAnalysis, type TimeWindow } from "./model.js";
import { detectProfileKind, ProfileShapeError } from "./profile/detect.js";
import { parseCpuProfile } from "./profile/cpu.js";
import { parseHeapProfile } from "./profile/heap.js";
import { resolveFunction } from "./query.js";
import { buildSummary, formatSummaryText } from "./report/summary.js";
import { buildTop, formatTopText, type TopOptions } from "./report/top.js";
import { buildCallersPaths, buildCallersTree, formatCallersPathsText, formatCallersTreeText } from "./report/callers.js";
import { buildCalleesPaths, buildCalleesTree, formatCalleesPathsText, formatCalleesTreeText } from "./report/callees.js";
import { buildDiff, formatDiffText } from "./report/diff.js";
import { buildLines, formatLinesText } from "./report/lines.js";
import { buildTimelineData, formatTimelineText } from "./report/timeline.js";
import { shQuote } from "./report/summary.js";
import { runCommand } from "./run.js";

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

const BOOLEAN_FLAGS = new Set(["json", "heap", "heap-peak", "expand", "paths"]);

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

  let kind: "cpu" | "heap";
  try {
    kind = detectProfileKind(json);
  } catch (e) {
    throw new CliError((e as Error).message, `pass a .cpuprofile or .heapprofile written by node --cpu-prof / --heap-prof`);
  }
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

function printError(io: Io, json: boolean, message: string, doLine: string): number {
  if (json) {
    io.stdout(`${JSON.stringify({ error: message, do: doLine })}\n`);
  } else {
    io.stdout(`error: ${message}\ndo: ${doLine}\n`);
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
 * V8 only writes a --cpu-prof/--heap-prof file on a NORMAL exit - a signal-ended child (killed,
 * crashed, or a forwarded SIGINT/SIGTERM) may never get the chance, which is a different, expected
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
  "usage: finderscope '<profile>' [--from ms --to ms] | top '<profile>' | callers '<profile>' '<fn>' [--expand] [--paths] | callees '<profile>' '<fn>' [--expand] [--paths] | lines '<profile>' '<fn>' | diff '<before>' '<after>' | run [--heap] [--heap-peak] -- '<command...>' | timeline '<profile>' | help";

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
  summary: "finderscope '<profile>' [--root dir] [--from ms --to ms] [--json]\n  The summary: your code top down, areas, top functions, hottest paths, and do:.",
  top: "finderscope top '<profile>' [--by self|total|root] [--area area] [--from ms --to ms] [-n N] [--json]\n  A longer ranked list.",
  callers: "finderscope callers '<profile>' '<function>' [--expand] [--paths] [--from ms --to ms] [-n N] [--json]\n  Which call paths lead to the function.",
  callees: "finderscope callees '<profile>' '<function>' [--expand] [--paths] [--from ms --to ms] [-n N] [--json]\n  Where the function's own total time goes.",
  lines: "finderscope lines '<profile>' '<function>' [--from ms --to ms] [-n N] [--json]\n  The hot lines inside the function's own body.",
  diff: "finderscope diff '<before>' '<after>' [-n N] [--json]\n  The functions and areas whose share changed most.",
  run: "finderscope run [--heap] [--heap-peak] [--root dir] [--json] -- '<command...>'\n  Runs the command, then prints the summary for each profile it wrote.",
  timeline: "finderscope timeline '<profile>' [--json]\n  20 equal time buckets, each with the top own function by self time - pick a --from/--to window from this.",
};

// Stated once, in full words, alongside every "ms" in a usage line above it - "ms" alone in a
// usage string reads as a value the caller types, not a unit; this line makes the unit explicit.
const FROM_TO_UNIT_NOTE = "--from/--to are milliseconds, offset from the profile's own start. summary, top, callers, callees and lines accept them.";
// Only these commands take a window; diff, run and timeline reject --from/--to.
const WINDOW_COMMANDS = new Set(["summary", "top", "callers", "callees", "lines"]);

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

  const KNOWN_SUBCOMMANDS = new Set(["top", "callers", "callees", "lines", "diff", "run", "timeline", "help"]);
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
  const root = optionString(options, "root") ?? process.cwd();

  switch (subcommand) {
    case "summary": {
      checkKnownOptions(options, new Set(["json", "root", "from", "to"]), USAGE);
      const profilePath = positionals[0];
      if (profilePath === undefined) throw new CliError("no profile given", USAGE);
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
      checkKnownOptions(options, new Set(["json", "root", "by", "area", "n", "from", "to"]), `finderscope top ${shQuote(profilePath)}`);
      const n = parsePositiveInt(optionString(options, "n"), `finderscope top ${shQuote(profilePath)} -n '<positive integer>'`);
      const by = optionString(options, "by");
      if (by !== undefined && by !== "self" && by !== "total" && by !== "root") {
        throw new CliError(`invalid --by ${by}; use self, total or root`,`finderscope top ${shQuote(profilePath)} --by self`);
      }
      const { window, windowArgs } = parseWindow(options, `finderscope top ${shQuote(profilePath)} --from ms --to ms`);
      return attributeUnexpectedErrorsTo([profilePath], () => {
        const analysis = loadAnalysis(profilePath, root, window);
        const topOptions: TopOptions = { area: optionString(options, "area"), n };
        if (by !== undefined) topOptions.by = by;
        const data = buildTop(analysis, profilePath, topOptions, windowArgs);
        io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatTopText(data, profilePath, windowArgs)}\n`);
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
      checkKnownOptions(options, new Set(["json", "root", "expand", "paths", "n", "from", "to"]), `finderscope ${subcommand} ${shQuote(profilePath)} ${shQuote(query)}`);
      const n = parsePositiveInt(
        optionString(options, "n"),
        `finderscope ${subcommand} ${shQuote(profilePath)} '<function>' -n '<positive integer>'`,
      );
      const paths = options.get("paths") === true;
      const expand = options.get("expand") === true;
      const { window, windowArgs } = parseWindow(options, `finderscope ${subcommand} ${shQuote(profilePath)} ${shQuote(query)} --from ms --to ms`);
      return attributeUnexpectedErrorsTo([profilePath], () => {
        const analysis = loadAnalysis(profilePath, root, window);
        const fn = resolveFunction(analysis, query, `finderscope top ${shQuote(profilePath)}`, root);
        if (subcommand === "callers") {
          if (paths) {
            const data = buildCallersPaths(analysis, fn, profilePath, n, windowArgs);
            io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatCallersPathsText(data, profilePath, windowArgs)}\n`);
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
      const n = parsePositiveInt(
        optionString(options, "n"),
        `finderscope lines ${shQuote(profilePath)} ${shQuote(query)} -n '<positive integer>'`,
      );
      const { window, windowArgs } = parseWindow(options, `finderscope lines ${shQuote(profilePath)} ${shQuote(query)} --from ms --to ms`);
      return attributeUnexpectedErrorsTo([profilePath], () => {
        const analysis = loadAnalysis(profilePath, root, window);
        const fn = resolveFunction(analysis, query, `finderscope top ${shQuote(profilePath)}`, root);
        const data = buildLines(analysis, fn, profilePath, n, windowArgs);
        io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatLinesText(data, profilePath, windowArgs)}\n`);
        return 0;
      });
    }

    case "timeline": {
      checkKnownOptions(options, new Set(["json", "root"]), `finderscope timeline '<profile>'`);
      const profilePath = positionals[0];
      if (profilePath === undefined) throw new CliError("no profile given", `finderscope timeline '<profile>'`);
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
      return attributeUnexpectedErrorsTo([beforePath, afterPath], () => {
        const before = loadAnalysis(beforePath, root);
        const after = loadAnalysis(afterPath, root);
        const data = buildDiff(before, after, beforePath, afterPath, n);
        io.stdout(json ? `${JSON.stringify(data)}\n` : `${formatDiffText(data, beforePath, afterPath)}\n`);
        return 0;
      });
    }

    case "run": {
      checkKnownOptions(options, new Set(["json", "root", "heap", "heap-peak"]), "finderscope run [--heap] [--heap-peak] -- '<command...>'");
      const heap = options.get("heap") === true;
      const heapPeak = options.get("heap-peak") === true;
      const result = await runCommand({ heap, heapPeak, command: positionals });

      // Never deleted, on purpose - stated here, not just in the README/design.md, since this is
      // the one moment an agent actually needs to know it can come back to this exact path.
      const scratchNote = `scratch dir: ${result.scratchDir} (kept on purpose - re-query it with finderscope callers/callees/top)`;
      const heapSnapshotNote =
        result.heapSnapshots.length > 0
          ? `heap snapshot near the limit: ${result.heapSnapshots.join(", ")} (finderscope does not read this file - open it in Chrome DevTools' Memory panel)`
          : undefined;

      if (result.profiles.length === 0) {
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
          io.stdout(
            `${JSON.stringify({ scratchDir: result.scratchDir, profiles: [], errors: [], heapSnapshots: result.heapSnapshots, heapPeakNote: result.heapPeakNote, warning: warning.message, do: warning.do })}\n`,
          );
        } else {
          const extra = [heapSnapshotNote, result.heapPeakNote].filter((s): s is string => s !== undefined).map((s) => `note: ${s}\n`).join("");
          io.stdout(`${scratchNote}\n${extra}warning: ${warning.message}\ndo: ${warning.do}\n`);
        }
        return result.exitCode;
      }

      const summaries: unknown[] = [];
      const errors: { profile: string; error: string; do: string }[] = [];
      const textBlocks: string[] = [];
      let firstDo: string | undefined;

      for (const profilePath of result.profiles) {
        try {
          const data = attributeUnexpectedErrorsTo([profilePath], () => {
            const analysis = loadAnalysis(profilePath, root);
            return buildSummary(analysis, profilePath);
          });
          summaries.push(data);
          textBlocks.push(formatSummaryText(data, profilePath));
          firstDo ??= data.do;
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

      const overallDo = firstDo ?? "finderscope run -- '<command...>'";
      if (json) {
        io.stdout(
          `${JSON.stringify({ scratchDir: result.scratchDir, profiles: summaries, errors, heapSnapshots: result.heapSnapshots, heapPeakNote: result.heapPeakNote, do: overallDo })}\n`,
        );
      } else {
        const extra = [heapSnapshotNote, result.heapPeakNote].filter((s): s is string => s !== undefined).map((s) => `note: ${s}\n`).join("");
        io.stdout(`${scratchNote}\n${extra}\n${textBlocks.join("\n\n")}\n`);
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
      return printError(io, json, e.message, e.do);
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
