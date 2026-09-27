// Responsibility: the default report - profile total, area breakdown, top functions by self, the
// caller's own code ranked by total, where that code hands off into other areas, the hottest call
// paths, and the `do:` line. Returns one plain data object (safe to JSON.stringify) and a text
// formatter over that same object, so `--json` and the default text output can never drift apart.
// Boundary: does not compute anything from the raw profile - only reshapes a ProfileAnalysis
// (model.ts) into the summary's own bounded shape.

import type { CallTreeNode, Metric, ProfileAnalysis } from "../model.js";
import { buildTopDown } from "../model.js";

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

/** "us" for a cpu profile's microseconds, "bytes" for a heap profile's bytes - stated once per
 *  JSON report (design.md) so an agent never has to guess which unit a bare number is in. */
export function metricUnit(metric: Metric): "us" | "bytes" {
  return metric === "bytes" ? "bytes" : "us";
}

/**
 * Rounds a 0..1 share to 3 decimal places (0.973) for display - every OTHER number in a report
 * (a self/total/delta value) is already an integer in its own unit and needs no rounding at all.
 * Never applied before a `do:` threshold check (chooseDo's 0.2, HANDOFF_AREA_MIN_SHARE, ...): a
 * raw 0.1996 rounds to 0.2 and would silently change which command `do:` picks, so every such
 * check reads the unrounded share computed straight from analysis, and only the value handed back
 * for display is rounded.
 */
export function roundShare(share: number): number {
  return Math.round(share * 1000) / 1000;
}

/** Applies roundShare to every share in a call tree, recursively - callers.ts, callees.ts, and
 *  this module's own topDown section all render a CallTreeNode[] from model.ts, which computes
 *  shares from raw division and has no reason to round (model.ts's boundary excludes display). */
export function roundTreeShares(nodes: CallTreeNode[]): CallTreeNode[] {
  return nodes.map((n) => ({ ...n, share: roundShare(n.share), children: roundTreeShares(n.children) }));
}

const SELF_COUNT = 10;
const OWN_TOTAL_COUNT = 10;
const PATH_COUNT = 3;
const HANDOFF_AREA_MIN_SHARE = 0.05;
const HANDOFF_FRAMES_PER_AREA = 3;
const HANDOFF_DO_MIN_SHARE = 0.2;
// Below the hand-off check (a real, concrete drill-down beats a general one) and above the plain
// topSelf check below it, on purpose: once an own function holds a real slice of the whole
// profile, "which of ITS lines" (design.md's `lines` verb, added for exactly this gap - a
// function's self time that `callers`/`callees` could not split any further) is a more concrete
// next step than "who calls it", even below the 20% bar chooseDo already uses elsewhere for "this
// one function is worth understanding on its own".
const OWN_SELF_LINES_MIN_SHARE = 0.1;

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
  /** "us" or "bytes" - see metricUnit(). Every value, total, and delta in this whole object is in
   *  this unit. */
  unit: "us" | "bytes";
  total: number;
  /** "your code, top down": the outermost own frames (merged by key), each with a callee tree
   *  beneath it built the same way `callees` builds one - see model.ts's buildTopDown. Placed
   *  first in the text output (before `areas`) so an agent reads the profile's own phase split
   *  before anything else. */
  topDown: CallTreeNode[];
  topDownCut: number;
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

  // The top OWN function by self time (not the top function overall - a package a hand-off
  // already pointed past, above, is not this) crosses the "worth a line-by-line look" bar before
  // the plain topSelf check below even gets a chance to fire for it - but only when `lines` would
  // actually have something to say about it: a profile with no positionTicks at all (an older
  // Node build, or a heap profile) or a function this profile happened to record none for would
  // otherwise get pointed at a command whose only answer is a `note:`, not a real next step.
  const topOwnSelf = [...analysis.functions.values()]
    .filter((f) => f.area === "own")
    .sort((a, b) => b.self - a.self)[0];
  if (
    topOwnSelf !== undefined &&
    total > 0 &&
    topOwnSelf.self / total >= OWN_SELF_LINES_MIN_SHARE &&
    analysis.lineSelfTimes.has(topOwnSelf.key)
  ) {
    return `finderscope lines ${shQuote(profilePath)} ${shQuote(topOwnSelf.key)}`;
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

  // Raw (unrounded), and NOT filtered to nonzero self: chooseDo below only asks "is there a
  // non-special function holding at least a fifth of the total", and rounding first could shift a
  // 0.1996 share across the 0.2 threshold, silently changing which do: it picks.
  const bySelfRankedRaw = bySelf.map((f) => ({ key: f.key, value: f.self, share: share(f.self) }));
  const bySelfNonZero = bySelfRankedRaw.filter((f) => f.value > 0);
  const topSelf = bySelfNonZero.slice(0, SELF_COUNT).map((f) => ({ ...f, share: roundShare(f.share) }));
  const topSelfCut = Math.max(0, bySelfNonZero.length - SELF_COUNT);

  // An "own" function's total can never actually be 0 here (model.ts's analyzeCore only adds a
  // function to `functions` at all via a positive self or a positive total contribution), so this
  // filter is defensive, not load-bearing - kept for the same reason topSelf's is: a ranked list
  // never carries a value-0 row, by construction, not by coincidence of today's data.
  const ownByTotalNonZero = ownByTotal.filter((f) => f.total > 0);
  const yourCodeByTotal = ownByTotalNonZero
    .slice(0, OWN_TOTAL_COUNT)
    .map((f) => ({ key: f.key, value: f.total, share: roundShare(share(f.total)) }));
  const yourCodeByTotalCut = Math.max(0, ownByTotalNonZero.length - OWN_TOTAL_COUNT);

  const areasRaw = [...analysis.areaTotals.entries()]
    .map(([area, value]) => ({ area, value, share: share(value) }))
    .sort((a, b) => b.value - a.value);
  const areas = areasRaw.map((a) => ({ ...a, share: roundShare(a.share) }));
  const paths = analysis.hottest.slice(0, PATH_COUNT).map((p) => ({ ...p, share: roundShare(p.share) }));

  const { roots, rootsCut } = buildTopDown(analysis);
  const topDown = roundTreeShares(roots);

  const handoffsByArea = groupHandoffsByArea(analysis);
  // Filtered on the RAW area share (areasRaw), same reasoning as bySelfRankedRaw above:
  // HANDOFF_AREA_MIN_SHARE is a threshold, not a display value.
  const handoffs: HandoffEntry[] = areasRaw
    .filter((a) => a.area !== "own" && a.share >= HANDOFF_AREA_MIN_SHARE)
    .map((a) => {
      const frames = (handoffsByArea.get(a.area) ?? []).slice(0, HANDOFF_FRAMES_PER_AREA).map((f) => ({
        key: f.key,
        share: roundShare(share(f.value)),
      }));
      return { area: a.area, areaShare: roundShare(a.share), frames };
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
    unit: metricUnit(analysis.metric),
    total,
    topDown,
    topDownCut: rootsCut,
    areas,
    topSelf,
    topSelfCut,
    yourCodeByTotal,
    yourCodeByTotalCut,
    handoffs,
    paths,
    note,
    do: chooseDo(analysis, bySelfRankedRaw, handoffsByArea, profilePath),
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

function labelTopDownNode(node: CallTreeNode): string {
  if (node.isSelf) return "(self)";
  return node.area === "own" ? node.key : `${node.area}: ${node.key}`;
}

/**
 * Renders one root's own callee tree, depth-first - a "… N more" hint under a cut node points at
 * THAT node's own key (`finderscope callees <profile> '<node>' -n <shown>`), not at the root, so
 * an agent drilling into a deep hand-off gets a command that actually shows what was cut there.
 * report/callees.ts's own renderNodes instead always names the one function `callees` was called
 * on, which is correct there (there is only one anchor for the whole tree) but would be wrong
 * here, where every node at every depth is its own possible drill-down target.
 */
function renderTopDownChildren(
  nodes: CallTreeNode[],
  childrenCut: number,
  metric: Metric,
  depth: number,
  profilePath: string,
  parentKey: string,
  lines: string[],
): void {
  const indent = "  ".repeat(depth);
  for (const node of nodes) {
    lines.push(`  ${formatValue(metric, node.value).padStart(8)}  ${formatPercent(node.share).padStart(6)}  ${indent}${labelTopDownNode(node)}`);
    renderTopDownChildren(node.children, node.childrenCut, metric, depth + 1, profilePath, node.key, lines);
  }
  if (childrenCut > 0) {
    const shown = nodes.filter((n) => !n.isSelf).length + childrenCut;
    lines.push(`  ${indent}… ${childrenCut} more (finderscope callees ${shQuote(profilePath)} ${shQuote(parentKey)} -n ${shown})`);
  }
}

/**
 * `finderscope top … --by root` (report/top.ts) ranks exactly these roots, flat - not
 * `--area own --by total`, which ranks by a function's own `.total` and can leave a real root
 * hidden behind a deeper own function that happens to hold more total time on its own (see
 * top.ts's own comment on rootEntries()).
 */
function renderTopDown(data: SummaryData, profilePath: string, lines: string[]): void {
  lines.push("");
  lines.push("your code, top down:");
  for (const root of data.topDown) {
    lines.push(`  ${formatValue(data.metric, root.value).padStart(8)}  ${formatPercent(root.share).padStart(6)}  ${root.key}`);
    renderTopDownChildren(root.children, root.childrenCut, data.metric, 1, profilePath, root.key, lines);
  }
  if (data.topDownCut > 0) {
    const shown = data.topDown.length + data.topDownCut;
    lines.push(`  … ${data.topDownCut} more (finderscope top ${shQuote(profilePath)} --by root -n ${shown})`);
  }
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

  if (data.topDown.length > 0) {
    renderTopDown(data, profilePath, lines);
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
