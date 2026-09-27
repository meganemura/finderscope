// Responsibility: the default report - profile total, area breakdown, top functions by self, the
// caller's own code ranked by total, where that code hands off into other areas, the hottest call
// paths, and the `do:` line. Returns one plain data object (safe to JSON.stringify) and a text
// formatter over that same object, so `--json` and the default text output can never drift apart.
// Boundary: does not compute anything from the raw profile - only reshapes a ProfileAnalysis
// (model.ts) into the summary's own bounded shape.

import type { Metric, ProfileAnalysis } from "../model.js";

/**
 * Wraps `value` in single quotes, POSIX-style (`'` becomes `'\''`), so every argument a `do:` or
 * `… more` line embeds - a profile path, a function key - survives `sh -c` unchanged no matter
 * what it contains: a space, a `$`, a backtick, a double quote. Single quotes suppress every kind
 * of shell expansion except a literal single quote itself, which is why that is the one character
 * that needs escaping here. Exported so every report module and cli.ts quote the same way.
 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const SELF_COUNT = 10;
const OWN_TOTAL_COUNT = 10;
const PATH_COUNT = 3;
const HANDOFF_AREA_MIN_SHARE = 0.05;
const HANDOFF_FRAMES_PER_AREA = 3;
const HANDOFF_DO_MIN_SHARE = 0.2;

/**
 * A special V8 frame's own key - "(root)", "(program)", "(idle)", "(garbage collector)" - is
 * never a valid `do:` target: none of them is a real function a `callers`/`callees` command can
 * usefully drill into (there is no code there to read), so a `do:` chooser must skip over one
 * even when it happens to be the heaviest candidate by value. They still appear normally in every
 * ranked list an agent reads (top by self, hottest paths, ...) - this only narrows what `do:`
 * itself may point at. Exported so every report module's own chooser filters the same way.
 */
export const SPECIAL_FRAME_KEYS = new Set(["(root)", "(program)", "(idle)", "(garbage collector)"]);
export function isSpecialFrame(key: string): boolean {
  return SPECIAL_FRAME_KEYS.has(key);
}

// Every area that is not a real dependency: own code, V8/node bookkeeping, and the three areas a
// frame with no real file on disk can land in (model.ts's classify()) - none of these should ever
// trigger the "a package dominates" do: rule below.
const NON_PACKAGE_AREAS = new Set(["own", "node", "gc", "idle", "program", "wasm", "eval", "native"]);

export interface RankedEntry {
  key: string;
  value: number;
  share: number;
}

export interface AreaEntry {
  area: string;
  value: number;
  share: number;
}

export interface HandoffFrame {
  /** The full key, with its column, printed in full: this line is meant to round-trip as a
   *  <function> argument the same as every other printed key, not a shortened pointer. */
  key: string;
  share: number;
}

export interface HandoffEntry {
  area: string;
  areaShare: number;
  frames: HandoffFrame[];
}

export interface SummaryData {
  metric: Metric;
  total: number;
  areas: AreaEntry[];
  topSelf: RankedEntry[];
  topSelfCut: number;
  /** "your code by total": area "own" only, ranked by total - the plain "top by total" (every
   *  area) moved to `finderscope top --by total`; see buildSummary's own comment on why. */
  yourCodeByTotal: RankedEntry[];
  yourCodeByTotalCut: number;
  handoffs: HandoffEntry[];
  paths: { segments: string[]; value: number; share: number }[];
  /** A caveat with no command in it - unlike `do`, never meant to be run. Only set for a heap
   *  profile: what "total" measures here (still-live-at-exit) is not what "peak memory" means,
   *  and that caveat is prose, not a runnable command, so it does not belong inside `do` (a
   *  `do:` line must always be one pure, sh -c-able command). */
  note: string | undefined;
  /** The next command to run, without the leading "do: ". Always a single runnable command. */
  do: string;
}

/**
 * Own-frame -> area totals, grouped by target area and sorted by value within each - the shape
 * both the "hands off" section and the `do:` rule need, computed once so they always agree with
 * each other about which frame is the top hand-off for a given area.
 */
function groupHandoffsByArea(analysis: ProfileAnalysis): Map<string, { key: string; value: number }[]> {
  const byArea = new Map<string, { key: string; value: number }[]>();
  for (const h of analysis.handoffs) {
    const list = byArea.get(h.toArea) ?? [];
    list.push({ key: h.fromKey, value: h.value });
    byArea.set(h.toArea, list);
  }
  for (const list of byArea.values()) list.sort((a, b) => b.value - a.value);
  return byArea;
}

/**
 * Prefers the hand-off: if the top non-own area has an own frame that hands off at least a fifth
 * of the profile's total directly into it, that single line (own code -> where its time actually
 * goes) is the most concrete next step there is - point at its callees. Otherwise, the top self
 * function holding a fifth or more of the profile -> point at its callers, since that single
 * function is worth understanding on its own. Otherwise, if the top area is a package (not in
 * NON_PACKAGE_AREAS) -> point at that package's own top list, since no single
 * function or hand-off dominates but one dependency does. Otherwise there is no single strong
 * signal, so the safe next step is the plain top list.
 */
function chooseDo(
  analysis: ProfileAnalysis,
  bySelf: RankedEntry[],
  handoffsByArea: Map<string, { key: string; value: number }[]>,
  profilePath: string,
): string {
  const total = analysis.total;
  const share = (value: number): number => (total > 0 ? value / total : 0);

  // A hand-off's fromKey is always an "own" frame by construction (model.ts's computeHandoffs),
  // so it can never be a special frame - no filter needed here.
  const topNonOwnArea = [...analysis.areaTotals.entries()]
    .filter(([area]) => area !== "own")
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topNonOwnArea !== undefined) {
    const topHandoff = handoffsByArea.get(topNonOwnArea)?.[0];
    if (topHandoff !== undefined && share(topHandoff.value) >= HANDOFF_DO_MIN_SHARE) {
      return `finderscope callees ${shQuote(profilePath)} ${shQuote(topHandoff.key)}`;
    }
  }

  const topSelf = bySelf.find((f) => !isSpecialFrame(f.key));
  if (topSelf !== undefined && total > 0 && topSelf.share >= 0.2) {
    return `finderscope callers ${shQuote(profilePath)} ${shQuote(topSelf.key)}`;
  }
  const topArea = [...analysis.areaTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topArea !== undefined && !NON_PACKAGE_AREAS.has(topArea)) {
    return `finderscope top ${shQuote(profilePath)} --area ${shQuote(topArea)}`;
  }
  return `finderscope top ${shQuote(profilePath)}`;
}

export function buildSummary(analysis: ProfileAnalysis, profilePath: string): SummaryData {
  const total = analysis.total;
  const share = (value: number): number => (total > 0 ? value / total : 0);

  const functions = [...analysis.functions.values()];
  const bySelf = [...functions].sort((a, b) => b.self - a.self);
  const own = functions.filter((f) => f.area === "own");
  const ownByTotal = [...own].sort((a, b) => b.total - a.total);

  const bySelfRanked = bySelf.map((f) => ({ key: f.key, value: f.self, share: share(f.self) }));
  const topSelf = bySelfRanked.slice(0, SELF_COUNT);
  const yourCodeByTotal = ownByTotal
    .slice(0, OWN_TOTAL_COUNT)
    .map((f) => ({ key: f.key, value: f.total, share: share(f.total) }));
  const areas = [...analysis.areaTotals.entries()]
    .map(([area, value]) => ({ area, value, share: share(value) }))
    .sort((a, b) => b.value - a.value);
  const paths = analysis.hottest.slice(0, PATH_COUNT);

  const handoffsByArea = groupHandoffsByArea(analysis);
  const handoffs: HandoffEntry[] = areas
    .filter((a) => a.area !== "own" && a.share >= HANDOFF_AREA_MIN_SHARE)
    .map((a) => {
      const frames = (handoffsByArea.get(a.area) ?? []).slice(0, HANDOFF_FRAMES_PER_AREA).map((f) => ({
        key: f.key,
        share: share(f.value),
      }));
      return { area: a.area, areaShare: a.share, frames };
    })
    .filter((h) => h.frames.length > 0);

  // Kept separate from `do`, not appended to it: the drill-down suggestion (which function or
  // package holds the most live bytes right now) is still real and still useful, but the peak-
  // memory caveat is prose with no command in it - folding it into `do` made that line fail to
  // run as a single command under `sh -c`.
  const note =
    analysis.metric === "bytes"
      ? "for peak memory instead of what was still live at exit, use /usr/bin/time -l <command> (macOS) or --heapsnapshot-near-heap-limit"
      : undefined;

  return {
    metric: analysis.metric,
    total,
    areas,
    topSelf,
    topSelfCut: Math.max(0, bySelf.length - SELF_COUNT),
    yourCodeByTotal,
    yourCodeByTotalCut: Math.max(0, ownByTotal.length - OWN_TOTAL_COUNT),
    handoffs,
    paths,
    note,
    do: chooseDo(analysis, bySelfRanked, handoffsByArea, profilePath),
  };
}

export function formatValue(metric: Metric, value: number): string {
  if (metric === "bytes") {
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
    return `${value}B`;
  }
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}s`;
  return `${(value / 1000).toFixed(1)}ms`;
}

export function formatPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export function formatSummaryText(data: SummaryData, profilePath: string): string {
  const lines: string[] = [];
  lines.push(`profile: ${profilePath}`);
  lines.push("");
  if (data.metric === "bytes") {
    // A sampling heap profiler's own numbers are what was still live when it wrote the profile
    // (at process exit, for `run --heap`) - not the highest memory the process ever reached. An
    // agent that reads "total" here as "peak memory" will draw the wrong conclusion from a
    // process that allocated a lot, freed most of it, and exited: this total can be small even
    // though the peak was not.
    lines.push(`finderscope summary (bytes, total ${formatValue(data.metric, data.total)} still live when the process exited - not the peak)`);
  } else {
    lines.push(`finderscope summary (${data.metric}, total ${formatValue(data.metric, data.total)})`);
  }

  lines.push("");
  lines.push("areas:");
  for (const a of data.areas) {
    lines.push(`  ${a.area.padEnd(20)} ${formatValue(data.metric, a.value).padStart(8)}  ${formatPercent(a.share)}`);
  }

  lines.push("");
  lines.push("top by self:");
  for (const f of data.topSelf) {
    lines.push(`  ${formatValue(data.metric, f.value).padStart(8)}  ${formatPercent(f.share).padStart(6)}  ${f.key}`);
  }
  if (data.topSelfCut > 0) {
    const shown = data.topSelf.length + data.topSelfCut;
    lines.push(`  … ${data.topSelfCut} more (finderscope top ${shQuote(profilePath)} --by self -n ${shown})`);
  }

  lines.push("");
  lines.push("your code by total:");
  for (const f of data.yourCodeByTotal) {
    lines.push(`  ${formatValue(data.metric, f.value).padStart(8)}  ${formatPercent(f.share).padStart(6)}  ${f.key}`);
  }
  if (data.yourCodeByTotalCut > 0) {
    const shown = data.yourCodeByTotal.length + data.yourCodeByTotalCut;
    lines.push(`  … ${data.yourCodeByTotalCut} more (finderscope top ${shQuote(profilePath)} --area own --by total -n ${shown})`);
  }

  if (data.handoffs.length > 0) {
    lines.push("");
    lines.push("where your code hands off:");
    for (const h of data.handoffs) {
      const frames = h.frames.map((f) => `${f.key} (${formatPercent(f.share)})`).join(", ");
      lines.push(`  ${h.area} ${formatPercent(h.areaShare)} <- ${frames}`);
    }
  }

  lines.push("");
  lines.push("hottest paths:");
  for (const p of data.paths) {
    lines.push(`  ${formatValue(data.metric, p.value).padStart(8)}  ${formatPercent(p.share).padStart(6)}  ${p.segments.join(" -> ")}`);
  }

  lines.push("");
  if (data.note !== undefined) {
    lines.push(`note: ${data.note}`);
  }
  lines.push(`do: ${data.do}`);
  return lines.join("\n");
}
