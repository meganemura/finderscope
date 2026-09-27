// Responsibility: `lines` - the hot lines inside one function, from V8's own `positionTicks`
// (model.ts's computeLineSelfTimes turns those into ProfileAnalysis.lineSelfTimes/lineReadPaths):
// ranked by self time, with the source text when the named file is readable. Exists because the
// summary and callees/callers can point at a function that holds a lot of self time and go no
// further - once one function IS the hot spot, "which of its lines" is a question only
// positionTicks can answer at all.
// Boundary: reshapes ProfileAnalysis's own lineSelfTimes/lineReadPaths for one already-resolved
// function; does not compute the tick-to-time apportionment itself (model.ts does, once, at
// analyze time - see model.ts's own comment on why that is not done lazily here instead).

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { AnalyzedFunction, Metric, ProfileAnalysis } from "../model.js";
import { formatPercent, formatValue, metricUnit, roundShare, shQuote } from "./summary.js";

const DEFAULT_COUNT = 10;
// "small compared with total" (design.md's own wording for this threshold): matches
// summary.ts's own topSelf >= 0.2 "worth understanding on its own" bar, so an agent reading both
// commands sees the same 20% line drawn twice, not two different unexplained numbers.
const SELF_DOMINANT_MIN_SHARE = 0.2;
// The next own function must still be a real contributor - a function with, say, 0.01% of the
// profile's self time is not worth a whole extra `lines` round trip; `callees` on `fn` itself is
// the more useful fallback there.
const NEXT_OWN_MIN_SHARE = 0.01;
// design.md's own "trimmed to about 100 chars" rule for a printed source line.
const MAX_SOURCE_CHARS = 100;
// A file bigger than this is never read for a one-line preview - a minified bundle can be
// megabytes long, and reading the whole thing just to show one line is wasted work every time.
const MAX_SOURCE_FILE_BYTES = 5 * 1024 * 1024;
// A mapped source's own text can name anything on disk - a source map is untrusted input, not a
// guarantee the named file is even source code. Restricting reads to a real, ordinary file (never
// a FIFO, a character device such as /dev/zero, or a socket - see isReadableSourceFile's own
// statSync check) under a code extension keeps `lines` from ever printing, say, ~/.ssh/id_rsa's
// first line just because some sources array happened to name it, and keeps a FIFO with no writer
// from hanging this command's own read.
const READABLE_SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".vue", ".svelte", ".astro"]);

export interface LineEntry {
  /** `path:line`, model.ts's own mapGeneratedLine key - already mapped through a source map when
   *  one applies. */
  key: string;
  value: number;
  /** Share of the function's OWN self time - the denominator `lines` exists to break down. */
  selfShare: number;
  /** Share of the whole profile's total - lets a reader compare a line directly against every
   *  other report's own ranked lists, which all share this same denominator. */
  totalShare: number;
  /** The line's own source text, trimmed - present only when the named file was readable
   *  (design.md's "when the file is readable" rule); absent, not empty, otherwise. */
  source: string | undefined;
}

export interface LinesData {
  metric: Metric;
  /** "us" or "bytes" - see metricUnit(). A heap profile never reaches the non-`note` shape below
   *  (heap nodes never carry positionTicks), but the field is stated on every shape regardless
   *  (design.md), the same rule every other report's JSON follows. */
  unit: "us" | "bytes";
  function: string;
  self: number;
  total: number;
  lines: LineEntry[];
  cut: number;
  /** Set, with `lines`/`cut` left empty/0, when this profile or this function has no positionTicks
   *  data at all - design.md decision 2: this is a fact about the profile, never an error. */
  note: string | undefined;
  /** The next command to run, without the leading "do: ". */
  do: string;
}

const NO_POSITION_TICKS_AT_ALL =
  "this profile has no positionTicks at all - an older Node build, or a .heapprofile, never carries per-line tick data";
const NO_POSITION_TICKS_FOR_FUNCTION = "this function has no positionTicks in this profile";

/**
 * design.md decision 1's own `do:` rule: when this function's self time is a small share of the
 * profile, its OWN lines are not the interesting question yet - point at `callees`, where its time
 * actually goes. Otherwise this function's own code is a real hot spot, so the natural next step
 * is the SAME question about the next heaviest own function, not a different verb - `lines` again.
 * Falls back to `callees` on `fn` itself when there is no other own function left to ask about,
 * the same "nothing else qualifies" fallback every other report's chooseDo uses.
 */
function chooseDo(analysis: ProfileAnalysis, fn: AnalyzedFunction, profilePath: string): string {
  const total = analysis.total;
  const fallback = `finderscope callees ${shQuote(profilePath)} ${shQuote(fn.key)}`;
  const selfShare = total > 0 ? fn.self / total : 0;
  if (selfShare < SELF_DOMINANT_MIN_SHARE) {
    return fallback;
  }
  const nextOwn = [...analysis.functions.values()]
    .filter((f) => f.area === "own" && f.key !== fn.key && f.self > 0)
    .sort((a, b) => b.self - a.self)[0];
  if (nextOwn !== undefined && total > 0 && nextOwn.self / total >= NEXT_OWN_MIN_SHARE) {
    return `finderscope lines ${shQuote(profilePath)} ${shQuote(nextOwn.key)}`;
  }
  return fallback;
}

/** Collapses interior whitespace so a source line with leading indentation still prints on one
 *  report row, then trims to "about 100 chars" (design.md) with a `…` marker matching this
 *  codebase's own cut-hint character, not a 3-dot ellipsis. */
function trimSource(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_SOURCE_CHARS ? `${collapsed.slice(0, MAX_SOURCE_CHARS)}…` : collapsed;
}

/**
 * True only for a path this command will actually open: a code file (READABLE_SOURCE_EXTENSIONS)
 * that statSync reports as an ORDINARY file (never a FIFO, device, or socket - stat itself never
 * blocks on any of those, only a read would) of at most MAX_SOURCE_FILE_BYTES. Checked before any
 * read, in that order (the extension check is the cheap one, so a wrong extension never even
 * pays for a stat call).
 */
function isReadableSourceFile(path: string): boolean {
  if (!READABLE_SOURCE_EXTENSIONS.has(extname(path))) return false;
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size <= MAX_SOURCE_FILE_BYTES;
  } catch {
    return false;
  }
}

/**
 * Reads one line's source text, caching a file's lines across the several rows `lines` prints
 * from the same file - a real function's hot lines routinely cluster in one script. Never throws:
 * an unreadable file (deleted since the profile was written, a mapped source with no real file at
 * all, or one isReadableSourceFile rejected outright) just means this row has no `source`,
 * matching design.md's "when the file is readable" rule - not an error for the whole command.
 */
function makeSourceReader(): (info: { path: string; line: number } | undefined) => string | undefined {
  const cache = new Map<string, string[] | undefined>();
  return (info) => {
    if (info === undefined) return undefined;
    if (!cache.has(info.path)) {
      let fileLines: string[] | undefined;
      if (isReadableSourceFile(info.path)) {
        try {
          fileLines = readFileSync(info.path, "utf8").split(/\r?\n/);
        } catch {
          fileLines = undefined;
        }
      }
      cache.set(info.path, fileLines);
    }
    const raw = cache.get(info.path)?.[info.line - 1];
    return raw !== undefined ? trimSource(raw) : undefined;
  };
}

export function buildLines(analysis: ProfileAnalysis, fn: AnalyzedFunction, profilePath: string, n = DEFAULT_COUNT): LinesData {
  const base = {
    metric: analysis.metric,
    unit: metricUnit(analysis.metric),
    function: fn.key,
    self: fn.self,
    total: analysis.total,
    lines: [],
    cut: 0,
  };
  const fallbackDo = `finderscope callees ${shQuote(profilePath)} ${shQuote(fn.key)}`;

  if (analysis.lineSelfTimes.size === 0) {
    return { ...base, note: NO_POSITION_TICKS_AT_ALL, do: fallbackDo };
  }
  const functionLines = analysis.lineSelfTimes.get(fn.key);
  if (functionLines === undefined || functionLines.size === 0) {
    return { ...base, note: NO_POSITION_TICKS_FOR_FUNCTION, do: fallbackDo };
  }

  const total = analysis.total;
  const share = (value: number): number => (total > 0 ? value / total : 0);
  const readSource = makeSourceReader();

  const entries = [...functionLines.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({
      key,
      value,
      selfShare: fn.self > 0 ? value / fn.self : 0,
      totalShare: share(value),
    }));

  const shown: LineEntry[] = entries.slice(0, n).map((e) => ({
    key: e.key,
    value: e.value,
    selfShare: roundShare(e.selfShare),
    totalShare: roundShare(e.totalShare),
    source: readSource(analysis.lineReadPaths.get(e.key)),
  }));

  return {
    ...base,
    lines: shown,
    cut: Math.max(0, entries.length - n),
    note: undefined,
    do: chooseDo(analysis, fn, profilePath),
  };
}

export function formatLinesText(data: LinesData, profilePath: string): string {
  const lines: string[] = [
    `profile: ${profilePath}`,
    "",
    `finderscope lines "${data.function}" (self ${formatValue(data.metric, data.self)})`,
    "",
  ];
  if (data.note !== undefined) {
    lines.push(`note: ${data.note}`);
  } else {
    for (const l of data.lines) {
      const sourceSuffix = l.source !== undefined ? `  ${l.source}` : "";
      lines.push(
        `  ${formatValue(data.metric, l.value).padStart(8)}  ${formatPercent(l.selfShare).padStart(6)}  ${formatPercent(l.totalShare).padStart(6)}  ${l.key}${sourceSuffix}`,
      );
    }
    if (data.cut > 0) {
      const shown = data.lines.length + data.cut;
      lines.push(`  … ${data.cut} more (finderscope lines ${shQuote(profilePath)} ${shQuote(data.function)} -n ${shown})`);
    }
  }
  lines.push("");
  lines.push(`do: ${data.do}`);
  return lines.join("\n");
}
