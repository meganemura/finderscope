// Responsibility: `callers` - which code leads into a function: by default, a tree of its direct
// callers merged by function key, depth 2, walked upward (fn's immediate caller first, then its
// caller's caller, ...), with a non-own subtree collapsed into one line (`--expand` lifts that).
// No "(self)" row here - self time is a property of the function itself, not of who called it.
// The older per-sample-path list lives behind `--paths` - see report/callees.ts's own comment on
// why a flat list of distinct paths told an agent nothing once they scattered across hundreds of
// paths differing only in package-internal depth.
// Boundary: reshapes ProfileAnalysis (model.ts's buildCallTree and, for --paths, groupKeyPaths)
// around one already-resolved function; does not resolve the `<function>` argument itself -
// query.ts does that before this module runs.

import type { AnalyzedFunction, CallTreeNode, Metric, ProfileAnalysis } from "../model.js";
import { buildCallTree, groupKeyPaths } from "../model.js";
import { formatPercent, formatValue, isSpecialFrame, shQuote } from "./summary.js";

const DEFAULT_COUNT = 10;

export interface CallersTreeOptions {
  depth?: number;
  expand?: boolean;
  n?: number;
}

export interface CallersTreeData {
  metric: Metric;
  function: string;
  total: number;
  children: CallTreeNode[];
  childrenCut: number;
  /** The next command to run, without the leading "do: ". */
  do: string;
}

/** Same reasoning as report/callees.ts's chooseDo, mirrored upward: the heaviest own caller, or -
 *  with no own caller at all - the heaviest collapsed area's own entry frame. Never a special
 *  frame (root/program/idle/gc) - there is no code there to drill into. */
function chooseDo(children: CallTreeNode[], profilePath: string): string | undefined {
  const real = children.filter((c) => !isSpecialFrame(c.key));
  const heaviest = real.find((c) => c.area === "own") ?? real[0];
  return heaviest === undefined ? undefined : `finderscope callers ${shQuote(profilePath)} ${shQuote(heaviest.key)}`;
}

export function buildCallersTree(
  analysis: ProfileAnalysis,
  fn: AnalyzedFunction,
  profilePath: string,
  options: CallersTreeOptions = {},
): CallersTreeData {
  const tree = buildCallTree(analysis, fn, "up", { depth: options.depth, expand: options.expand, childrenPerLevel: options.n });
  const fallback = isSpecialFrame(fn.key)
    ? `finderscope top ${shQuote(profilePath)}`
    : `finderscope callees ${shQuote(profilePath)} ${shQuote(fn.key)}`;
  const do_ = chooseDo(tree.children, profilePath) ?? fallback;
  return {
    metric: analysis.metric,
    function: fn.key,
    total: fn.total,
    children: tree.children,
    childrenCut: tree.childrenCut,
    do: do_,
  };
}

function label(node: CallTreeNode): string {
  return node.area === "own" ? node.key : `${node.area}: ${node.key}`;
}

function renderNodes(nodes: CallTreeNode[], childrenCut: number, metric: Metric, depth: number, profilePath: string, fn: string, lines: string[]): void {
  const indent = "  ".repeat(depth);
  for (const node of nodes) {
    lines.push(`  ${formatValue(metric, node.value).padStart(8)}  ${formatPercent(node.share).padStart(6)}  ${indent}${label(node)}`);
    renderNodes(node.children, node.childrenCut, metric, depth + 1, profilePath, fn, lines);
  }
  if (childrenCut > 0) {
    const shown = nodes.length + childrenCut;
    lines.push(`  ${indent}… ${childrenCut} more (finderscope callers ${shQuote(profilePath)} ${shQuote(fn)} -n ${shown})`);
  }
}

export function formatCallersTreeText(data: CallersTreeData, profilePath: string): string {
  const lines: string[] = [
    `profile: ${profilePath}`,
    "",
    `finderscope callers "${data.function}" (total ${formatValue(data.metric, data.total)})`,
    "",
  ];
  renderNodes(data.children, data.childrenCut, data.metric, 0, profilePath, data.function, lines);
  lines.push("");
  lines.push(`do: ${data.do}`);
  return lines.join("\n");
}

// --paths: the older flat list of distinct folded paths, by request behind a flag now.
export interface CallersPathsData {
  metric: Metric;
  function: string;
  total: number;
  paths: { segments: string[]; value: number; share: number }[];
  cut: number;
  /** The next command to run, without the leading "do: ". */
  do: string;
}

export function buildCallersPaths(analysis: ProfileAnalysis, fn: AnalyzedFunction, profilePath: string, n = DEFAULT_COUNT): CallersPathsData {
  const areaOf = (key: string): string => analysis.functions.get(key)?.area ?? "unknown";
  const prefixes: { keys: string[]; value: number }[] = [];
  for (const path of analysis.paths) {
    const idx = path.keys.indexOf(fn.key);
    if (idx === -1) continue;
    prefixes.push({ keys: path.keys.slice(0, idx + 1), value: path.value });
  }
  const all = groupKeyPaths(prefixes, areaOf, fn.total);
  return {
    metric: analysis.metric,
    function: fn.key,
    total: fn.total,
    paths: all.slice(0, n),
    cut: Math.max(0, all.length - n),
    do: `finderscope callers ${shQuote(profilePath)} ${shQuote(fn.key)}`,
  };
}

export function formatCallersPathsText(data: CallersPathsData, profilePath: string): string {
  const lines: string[] = [
    `profile: ${profilePath}`,
    "",
    `finderscope callers "${data.function}" --paths (total ${formatValue(data.metric, data.total)})`,
    "",
  ];
  for (const p of data.paths) {
    lines.push(`  ${formatValue(data.metric, p.value).padStart(8)}  ${formatPercent(p.share).padStart(6)}  ${p.segments.join(" -> ")}`);
  }
  if (data.cut > 0) {
    const shown = data.paths.length + data.cut;
    lines.push(`  … ${data.cut} more (finderscope callers ${shQuote(profilePath)} ${shQuote(data.function)} --paths -n ${shown})`);
  }
  lines.push("");
  lines.push(`do: ${data.do}`);
  return lines.join("\n");
}
