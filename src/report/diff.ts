// Responsibility: `diff` - the functions and areas whose share of the profile total changed most
// between two profiles, sorted by the size of the change (not by either profile's own ranking).
// Boundary: reshapes two ProfileAnalysis objects (model.ts); does not parse or analyze anything
// itself.

import type { Metric, ProfileAnalysis } from "../model.js";
import { formatPercent, isSpecialFrame, metricUnit, roundShare, shQuote } from "./summary.js";

const DEFAULT_COUNT = 10;

export interface DiffEntry {
  key: string;
  beforeShare: number;
  afterShare: number;
  delta: number;
}

export interface AreaDiffEntry {
  area: string;
  beforeShare: number;
  afterShare: number;
  delta: number;
}

export interface DiffData {
  metric: Metric;
  /** "us" or "bytes" - see metricUnit(). `delta` below is a share difference, not a value in this
   *  unit (there is no single before/after value to report in a diff) - see design.md. */
  unit: "us" | "bytes";
  functions: DiffEntry[];
  functionsCut: number;
  areas: AreaDiffEntry[];
  areasCut: number;
  /** The next command to run, without the leading "do: ". */
  do: string;
}

/**
 * A deliberate, expected complaint about the two profiles buildDiff was given (mixing a
 * .cpuprofile with a .heapprofile) - a real caller mistake, not a finderscope bug. Its own class
 * with a separate `do` field, not a plain Error with "\ndo:" folded into the message text, so
 * src/cli.ts's attributeUnexpectedErrorsTo can recognize it by `instanceof` and pass it through
 * unchanged instead of wrapping it (and its own embedded "do:" line) inside a second,
 * misattributed "finderscope bug" `do` line.
 */
export class DiffInputError extends Error {
  readonly do: string;
  constructor(message: string, doLine: string) {
    super(message);
    this.name = "DiffInputError";
    this.do = doLine;
  }
}

function shareIn(analysis: ProfileAnalysis, total: number): (key: string) => number {
  return (key: string) => {
    if (total <= 0) return 0;
    return (analysis.functions.get(key)?.total ?? 0) / total;
  };
}

function areaShareIn(analysis: ProfileAnalysis, total: number): (area: string) => number {
  return (area: string) => {
    if (total <= 0) return 0;
    return (analysis.areaTotals.get(area) ?? 0) / total;
  };
}

/**
 * The biggest function change -> point at where its time goes now - except a function that was
 * REMOVED (it no longer exists in `after.functions` at all) has nothing to look at in the after
 * profile; `callees afterPath thatKey` would fail to resolve it. Point at `before` instead for
 * exactly that case - the one profile that actually still has the function. Never a special frame
 * (root/program/idle/gc) as the function target - there is no code there. No qualifying function
 * change but an area changed -> that area's own top list, in `after`. No change at all -> nothing
 * to drill into.
 */
function chooseDo(functions: DiffEntry[], areas: AreaDiffEntry[], after: ProfileAnalysis, beforePath: string, afterPath: string): string {
  const topFunction = functions.find((f) => !isSpecialFrame(f.key));
  if (topFunction !== undefined) {
    const targetPath = after.functions.has(topFunction.key) ? afterPath : beforePath;
    return `finderscope callees ${shQuote(targetPath)} ${shQuote(topFunction.key)}`;
  }
  const topArea = areas[0];
  if (topArea !== undefined) {
    return `finderscope top ${shQuote(afterPath)} --area ${shQuote(topArea.area)}`;
  }
  return `finderscope top ${shQuote(afterPath)}`;
}

export function buildDiff(before: ProfileAnalysis, after: ProfileAnalysis, beforePath: string, afterPath: string, n = DEFAULT_COUNT): DiffData {
  if (before.metric !== after.metric) {
    throw new DiffInputError(
      `cannot diff a ${before.metric} profile against a ${after.metric} profile`,
      "pass two .cpuprofile files or two .heapprofile files",
    );
  }

  const beforeShareOf = shareIn(before, before.total);
  const afterShareOf = shareIn(after, after.total);
  const keys = new Set([...before.functions.keys(), ...after.functions.keys()]);
  // Equal before/after shares subtract to exactly 0 (IEEE 754 x - x === 0), so diffing a profile
  // against itself drops every function here - `functions` is empty, matching "no change" exactly
  // rather than a list of same-sized deltas.
  const functionEntries = [...keys]
    .map((key) => ({ key, beforeShare: beforeShareOf(key), afterShare: afterShareOf(key), delta: afterShareOf(key) - beforeShareOf(key) }))
    .filter((e) => e.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const beforeAreaShareOf = areaShareIn(before, before.total);
  const afterAreaShareOf = areaShareIn(after, after.total);
  const areaKeys = new Set([...before.areaTotals.keys(), ...after.areaTotals.keys()]);
  const areaEntries = [...areaKeys]
    .map((area) => ({
      area,
      beforeShare: beforeAreaShareOf(area),
      afterShare: afterAreaShareOf(area),
      delta: afterAreaShareOf(area) - beforeAreaShareOf(area),
    }))
    .filter((e) => e.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Rounded from the raw (unrounded) entries above: functionEntries and areaEntries stay raw for
  // chooseDo and for the delta!==0 filter above, matching every other report's rule of never
  // rounding a value a threshold or an equality check still needs to read exactly. A row whose
  // delta rounds to 0.000 - a real, nonzero raw delta too small for 3 decimals to show at all - is
  // then dropped here, same as every other ranked list never carrying a value-0 row: shown here as
  // "0.000" it would look like a change with no size, the one thing this list exists to rank. Its
  // sort position was already exactly where the raw filter above put it (rounding to zero only
  // happens for the smallest surviving |delta|s, so this can only shrink the tail, never reorder
  // what remains).
  const functionsRounded = functionEntries
    .map((f) => ({ ...f, beforeShare: roundShare(f.beforeShare), afterShare: roundShare(f.afterShare), delta: roundShare(f.delta) }))
    .filter((f) => f.delta !== 0);
  const areasRounded = areaEntries
    .map((a) => ({ ...a, beforeShare: roundShare(a.beforeShare), afterShare: roundShare(a.afterShare), delta: roundShare(a.delta) }))
    .filter((a) => a.delta !== 0);
  const functions = functionsRounded.slice(0, n);
  const areas = areasRounded.slice(0, n);

  return {
    metric: before.metric,
    unit: metricUnit(before.metric),
    functions,
    functionsCut: Math.max(0, functionsRounded.length - n),
    areas,
    areasCut: Math.max(0, areasRounded.length - n),
    do: chooseDo(functionEntries, areaEntries, after, beforePath, afterPath),
  };
}

function formatDelta(delta: number): string {
  const sign = delta > 0 ? "+" : "";
  return `${sign}${formatPercent(delta)}`;
}

export function formatDiffText(data: DiffData, beforePath: string, afterPath: string): string {
  const lines: string[] = [`finderscope diff ${beforePath} ${afterPath} (${data.metric})`, ""];

  // A row whose delta rounds to 0.000 is left out of `functions`/`areas` (buildDiff) and is not
  // counted in functionsCut/areasCut: at the 3-decimal precision the report uses, it is no
  // change. So "no change" means no delta of 0.001 or more, and no row cut for length.
  if (data.functions.length === 0 && data.areas.length === 0 && data.functionsCut === 0 && data.areasCut === 0) {
    lines.push("no change");
    lines.push("");
    lines.push(`do: ${data.do}`);
    return lines.join("\n");
  }

  lines.push("areas:");
  if (data.areas.length === 0) lines.push("  no change");
  for (const a of data.areas) {
    lines.push(`  ${formatDelta(a.delta).padStart(7)}  ${formatPercent(a.beforeShare)} -> ${formatPercent(a.afterShare)}  ${a.area}`);
  }
  if (data.areasCut > 0) lines.push(`  … ${data.areasCut} more`);

  lines.push("");
  lines.push("functions:");
  if (data.functions.length === 0) lines.push("  no change");
  for (const f of data.functions) {
    lines.push(`  ${formatDelta(f.delta).padStart(7)}  ${formatPercent(f.beforeShare)} -> ${formatPercent(f.afterShare)}  ${f.key}`);
  }
  if (data.functionsCut > 0) {
    const shown = data.functions.length + data.functionsCut;
    lines.push(`  … ${data.functionsCut} more (finderscope diff ${shQuote(beforePath)} ${shQuote(afterPath)} -n ${shown})`);
  }

  lines.push("");
  lines.push(`do: ${data.do}`);
  return lines.join("\n");
}
