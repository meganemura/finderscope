// Responsibility: shape the default agent report around caused cost: each own function gets the
// work for which it is the deepest editable frame, plus the non-own work below it.
// Boundary: this module formats analyzed facts. model.ts alone assigns profile contributions.

import type { CallTreeNode, Metric, ProfileAnalysis } from "../model.js";

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function metricUnit(metric: Metric): "us" | "bytes" {
  return metric === "bytes" ? "bytes" : "us";
}

export function roundShare(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function roundTreeShares(nodes: CallTreeNode[]): CallTreeNode[] {
  return nodes.map((node) => ({ ...node, share: roundShare(node.share), children: roundTreeShares(node.children) }));
}

export const SPECIAL_FRAME_KEYS = new Set(["(root)", "(program)", "(idle)", "(garbage collector)"]);
export function isSpecialFrame(key: string): boolean {
  return SPECIAL_FRAME_KEYS.has(key);
}

export interface CausedEntryData {
  key: string;
  name: string;
  area: string;
  value: number;
}

export interface FixCandidateData {
  key: string;
  value: number;
  share: number;
  self: number;
  entries: CausedEntryData[];
  entriesCut: number;
  reachedFrom: string[];
}

export interface SummaryData {
  metric: Metric;
  unit: "us" | "bytes";
  total: number;
  window: { from: number; to: number } | undefined;
  causedTotal: number;
  causedShare: number;
  fixCandidates: FixCandidateData[];
  fixCandidatesCut: number;
  notCaused: { area: string; value: number; share: number }[];
  note: string | undefined;
  do: string;
}

function causedRows(analysis: ProfileAnalysis): FixCandidateData[] {
  const share = (value: number): number => analysis.total > 0 ? value / analysis.total : 0;
  return [...analysis.caused.values()]
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
    .map((entry) => ({
      key: entry.key,
      value: entry.value,
      share: roundShare(share(entry.value)),
      self: entry.self,
      entries: [...entry.entries.values()]
        .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
        .slice(0, 3),
      entriesCut: Math.max(0, entry.entries.size - 3),
      reachedFrom: [...entry.callerChains.values()]
        .sort((a, b) => b.value - a.value)[0]
        ?.hops.map((hop) => hop.recursive ? `${hop.key} (recursive)` : hop.key) ?? [],
    }));
}

export function buildSummary(
  analysis: ProfileAnalysis,
  profilePath: string,
  window?: { from: number; to: number },
  windowArgs = "",
): SummaryData {
  const rows = causedRows(analysis);
  const causedTotal = rows.reduce((sum, row) => sum + row.value, 0);
  const notCaused = [...analysis.notCaused.entries()]
    .filter(([, value]) => value > 0)
    .map(([area, value]) => ({ area, value, share: roundShare(analysis.total > 0 ? value / analysis.total : 0) }))
    .sort((a, b) => b.value - a.value);
  const first = rows[0];
  const do_ = first === undefined
    ? `finderscope top ${shQuote(profilePath)}${windowArgs}`
    : `finderscope lines ${shQuote(profilePath)} ${shQuote(first.key)}${windowArgs}`;
  return {
    metric: analysis.metric,
    unit: metricUnit(analysis.metric),
    total: analysis.total,
    window,
    causedTotal,
    causedShare: roundShare(analysis.total > 0 ? causedTotal / analysis.total : 0),
    fixCandidates: rows.slice(0, 8),
    fixCandidatesCut: Math.max(0, rows.length - 8),
    notCaused,
    note: analysis.metric === "bytes" ? "the total is memory still live when the process exited, not the peak" : undefined,
    do: do_,
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

export function formatFrameCount(count: number): string {
  return `${count} ${count === 1 ? "frame" : "frames"}`;
}

// A bare "(anonymous)" says nothing about what the code called, so the text adds the file name
// and line. The JSON keeps each entry's full key, so nothing here has to round trip.
function entryLabel(entry: CausedEntryData): string {
  if (entry.name !== "(anonymous)" && entry.name !== "") return entry.name;
  const location = /([^/\\ ]+):(\d+):\d+$/.exec(entry.key);
  return location === null ? "(anonymous)" : `(anonymous) ${location[1]}:${location[2]}`;
}

// Two distinct functions can share a name (overloads, or one name in two files of a package).
// Printing the name twice reads as a mistake, so the text merges entries that would print alike.
function mergedEntries(entries: readonly CausedEntryData[]): { area: string; label: string; value: number }[] {
  const merged = new Map<string, { area: string; label: string; value: number }>();
  for (const entry of entries) {
    const label = entryLabel(entry);
    const id = `${entry.area}\0${label}`;
    const existing = merged.get(id);
    if (existing === undefined) merged.set(id, { area: entry.area, label, value: entry.value });
    else existing.value += entry.value;
  }
  return [...merged.values()].sort((a, b) => b.value - a.value);
}

function formatBreakdown(row: FixCandidateData, metric: Metric): string {
  const shown = mergedEntries(row.entries);
  const names = shown.map((entry) => entry.label);
  const build = (): string => {
    const parts: string[] = [];
    if (row.self > 0) parts.push(`self ${formatValue(metric, row.self)}`);
    const entries = shown.map((entry, index) => `${entry.area} ${names[index]} ${formatValue(metric, entry.value)}`);
    if (row.entriesCut > 0) entries.push(`+${row.entriesCut} more`);
    if (entries.length > 0) parts.push(entries.join(", "));
    return parts.join("; ");
  };
  let text = build();
  while (text.length > 116) {
    let longest = 0;
    for (let i = 1; i < names.length; i++) {
      if (names[i]!.length > names[longest]!.length) longest = i;
    }
    const name = names[longest];
    if (name === undefined || name.length <= 5) break;
    const keep = Math.max(5, name.length - (text.length - 116));
    const left = Math.ceil((keep - 1) / 2);
    const right = Math.floor((keep - 1) / 2);
    names[longest] = `${name.slice(0, left)}…${name.slice(name.length - right)}`;
    text = build();
  }
  return text;
}

export function formatSummaryText(data: SummaryData, profilePath: string, windowArgs = "", subject = `profile: ${profilePath}`): string {
  const lines = [`${subject}; total ${formatValue(data.metric, data.total)}; your code caused ${formatValue(data.metric, data.causedTotal)} (${formatPercent(data.causedShare)})`];
  if (data.window !== undefined) lines.push(`window: ${formatValue(data.metric, data.window.from)} .. ${formatValue(data.metric, data.window.to)}`);
  lines.push("", "fix candidates:");
  for (const row of data.fixCandidates) {
    lines.push(`  ${formatValue(data.metric, row.value).padStart(8)}  ${formatPercent(row.share).padStart(6)}  ${row.key}`);
    lines.push(`    ${formatBreakdown(row, data.metric)}`);
    if (row.reachedFrom.length > 0) lines.push(`    reached from: ${row.reachedFrom.join(" ← ")}`);
  }
  if (data.fixCandidatesCut > 0) {
    const count = data.fixCandidates.length + data.fixCandidatesCut;
    lines.push(`  … ${data.fixCandidatesCut} more (finderscope top ${shQuote(profilePath)} -n ${count}${windowArgs})`);
  }
  if (data.notCaused.length > 0) {
    lines.push("", "not caused by your code:");
    for (const row of data.notCaused) lines.push(`  ${row.area.padEnd(16)} ${formatValue(data.metric, row.value).padStart(8)}  ${formatPercent(row.share)}`);
  }
  if (data.note !== undefined) lines.push("", `note: ${data.note}`);
  lines.push("", `do: ${data.do}`);
  return lines.join("\n");
}
