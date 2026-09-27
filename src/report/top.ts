// Responsibility: `top` - a longer ranked function list, optionally filtered to one area, sorted
// by self or by total.
// Boundary: reshapes a ProfileAnalysis (model.ts) only; does not compute self/total/area itself.

import type { Metric, ProfileAnalysis } from "../model.js";
import { formatPercent, formatValue, isSpecialFrame, shQuote } from "./summary.js";

const DEFAULT_COUNT = 10;

export interface TopOptions {
  by?: "self" | "total";
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
  by: "self" | "total";
  area: string | undefined;
  total: number;
  entries: TopEntry[];
  cut: number;
  /** The next command to run, without the leading "do: ". */
  do: string;
}

/** By self -> point at the heaviest entry's callers, since that is the function most worth
 *  understanding on its own. By total -> point at its callees, since that is where its time
 *  actually goes. Never a special frame (root/program/idle/gc) - there is no code there to drill
 *  into. An empty list (an --area filter that matched nothing, or nothing left once special
 *  frames are skipped) falls back to the plain top list. */
function chooseDo(sortedEntries: TopEntry[], by: "self" | "total", profilePath: string): string {
  const heaviest = sortedEntries.find((e) => !isSpecialFrame(e.key));
  if (heaviest === undefined) return `finderscope top ${shQuote(profilePath)}`;
  const verb = by === "self" ? "callers" : "callees";
  return `finderscope ${verb} ${shQuote(profilePath)} ${shQuote(heaviest.key)}`;
}

export function buildTop(analysis: ProfileAnalysis, profilePath: string, options: TopOptions): TopData {
  const by = options.by ?? "self";
  const n = options.n ?? DEFAULT_COUNT;
  const total = analysis.total;
  const share = (value: number): number => (total > 0 ? value / total : 0);

  let functions = [...analysis.functions.values()];
  if (options.area !== undefined) {
    functions = functions.filter((f) => f.area === options.area);
  }
  const sorted = functions.sort((a, b) => (by === "self" ? b.self - a.self : b.total - a.total));
  const sortedEntries = sorted.map((f) => ({
    key: f.key,
    area: f.area,
    value: by === "self" ? f.self : f.total,
    share: share(by === "self" ? f.self : f.total),
  }));
  const entries = sortedEntries.slice(0, n);

  return {
    metric: analysis.metric,
    by,
    area: options.area,
    total,
    entries,
    cut: Math.max(0, sorted.length - n),
    do: chooseDo(sortedEntries, by, profilePath),
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
