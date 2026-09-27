// Responsibility: `top` - a longer ranked list, optionally filtered to one area, sorted by self,
// by total, or (by root) by "your code, top down"'s own root value.
// Boundary: reshapes a ProfileAnalysis (model.ts) only; does not compute self/total/area/root
// itself - `--by root` reuses model.ts's buildTopDown, the same function the summary's own
// "your code, top down" section builds from.

import type { Metric, ProfileAnalysis } from "../model.js";
import { buildTopDown } from "../model.js";
import { formatPercent, formatValue, isSpecialFrame, metricUnit, roundShare, shQuote } from "./summary.js";

const DEFAULT_COUNT = 10;

export type TopBy = "self" | "total" | "root";

export interface TopOptions {
  by?: TopBy;
  area?: string;
  n?: number;
}

export interface TopEntry {
  key: string;
  area: string;
  value: number;
  share: number;
}

export interface TopData {
  metric: Metric;
  /** "us" or "bytes" - see metricUnit(). */
  unit: "us" | "bytes";
  by: TopBy;
  area: string | undefined;
  total: number;
  entries: TopEntry[];
  cut: number;
  /** The next command to run, without the leading "do: ". */
  do: string;
}

/** By self -> point at the heaviest entry's callers, since that is the function most worth
 *  understanding on its own. By total or by root -> point at its callees, since that is where its
 *  time actually goes. Never a special frame (root/program/idle/gc) - there is no code there to
 *  drill into. An empty list (an --area filter that matched nothing, or nothing left once special
 *  frames are skipped) falls back to the plain top list. */
function chooseDo(sortedEntries: TopEntry[], by: TopBy, profilePath: string): string {
  const heaviest = sortedEntries.find((e) => !isSpecialFrame(e.key));
  if (heaviest === undefined) return `finderscope top ${shQuote(profilePath)}`;
  const verb = by === "self" ? "callers" : "callees";
  return `finderscope ${verb} ${shQuote(profilePath)} ${shQuote(heaviest.key)}`;
}

/**
 * `--by root`: the same roots "your code, top down" ranks, as a flat list - every root is "own" by
 * construction (model.ts's buildTopDown only ever roots a path at its first own frame), so this is
 * NOT the same ranking as `--area own --by total`: that ranks by a function's own `.total`, which
 * can put a deeper own function (reached as a callee of more than one real root, or simply holding
 * more total time on its own) ahead of a root whose own value is smaller but whose own callee tree
 * is the actual phase split an agent is after. A root that "your code, top down" had to cut (more
 * than 3 roots) is exactly the case this exists for - a hidden root would otherwise never show up
 * in any ranked list at all.
 */
function rootEntries(analysis: ProfileAnalysis): TopEntry[] {
  const total = analysis.total;
  const share = (value: number): number => (total > 0 ? value / total : 0);
  // rootCount has no real upper bound in the data (a profile can have any number of own roots), so
  // this asks buildTopDown for effectively all of them; the caller's own -n still caps the list.
  const { roots } = buildTopDown(analysis, { rootCount: Number.MAX_SAFE_INTEGER });
  return roots.map((r) => ({ key: r.key, area: "own", value: r.value, share: share(r.value) }));
}

export function buildTop(analysis: ProfileAnalysis, profilePath: string, options: TopOptions): TopData {
  const by = options.by ?? "self";
  const n = options.n ?? DEFAULT_COUNT;
  const total = analysis.total;
  const share = (value: number): number => (total > 0 ? value / total : 0);

  let sortedEntries: TopEntry[];
  if (by === "root") {
    // Already sorted by value, descending (buildTopDown's own rootTotals sort) - re-sorted here
    // anyway so this function does not depend on that internal ordering staying stable.
    sortedEntries = rootEntries(analysis).sort((a, b) => b.value - a.value);
  } else {
    let functions = [...analysis.functions.values()];
    if (options.area !== undefined) {
      functions = functions.filter((f) => f.area === options.area);
    }
    const sorted = functions.sort((a, b) => (by === "self" ? b.self - a.self : b.total - a.total));
    sortedEntries = sorted.map((f) => ({
      key: f.key,
      area: f.area,
      value: by === "self" ? f.self : f.total,
      share: share(by === "self" ? f.self : f.total),
    }));
  }
  if (by === "root" && options.area !== undefined) {
    sortedEntries = sortedEntries.filter((e) => e.area === options.area);
  }

  // "by self" routinely has a value-0 row (a function only ever seen as an ancestor, never a
  // sample's own top frame - "(root)" is the common case); "by total" and "by root" cannot, since
  // every function reaching `functions` at all has a positive total (model.ts's analyzeCore), and
  // every root's value is a sum of positive-time paths (model.ts's buildTopDown). Filtered either
  // way, since a ranked list should never carry a row with nothing in it.
  const nonZeroEntries = sortedEntries.filter((e) => e.value > 0);
  const entries = nonZeroEntries.slice(0, n).map((e) => ({ ...e, share: roundShare(e.share) }));

  return {
    metric: analysis.metric,
    unit: metricUnit(analysis.metric),
    by,
    area: options.area,
    total,
    entries,
    cut: Math.max(0, nonZeroEntries.length - n),
    do: chooseDo(nonZeroEntries, by, profilePath),
  };
}

export function formatTopText(data: TopData, profilePath: string): string {
  const areaSuffix = data.area !== undefined ? ` --area ${data.area}` : "";
  const lines: string[] = [
    `profile: ${profilePath}`,
    "",
    `finderscope top${areaSuffix} (by ${data.by}, total ${formatValue(data.metric, data.total)})`,
    "",
  ];
  for (const e of data.entries) {
    lines.push(`  ${formatValue(data.metric, e.value).padStart(8)}  ${formatPercent(e.share).padStart(6)}  ${e.area.padEnd(12)} ${e.key}`);
  }
  if (data.cut > 0) {
    const shown = data.entries.length + data.cut;
    lines.push(`  … ${data.cut} more (finderscope top ${shQuote(profilePath)}${areaSuffix} --by ${data.by} -n ${shown})`);
  }
  lines.push("");
  lines.push(`do: ${data.do}`);
  return lines.join("\n");
}
