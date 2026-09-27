// Responsibility: `callees` - where a function's own total time (or bytes) goes: by default, a
// tree of its direct callees merged by function key, depth 2, with a non-own subtree collapsed
// into one line (`--expand` lifts that). The older per-sample-path list lives behind `--paths` -
// a flat list of distinct paths told an agent nothing once a hot function's time scattered across
// hundreds of paths that differed only in how deep they happened to go inside one package (the
// same function's callers.ts had the same problem, fixed the same way).
// Boundary: reshapes ProfileAnalysis (model.ts's buildCallTree and, for --paths, groupKeyPaths)
// around one already-resolved function; does not resolve the `<function>` argument itself -
// query.ts does that before this module runs.

import type { AnalyzedFunction, CallTreeNode, Metric, ProfileAnalysis } from "../model.js";
import { buildCallTree, groupKeyPaths } from "../model.js";
import { formatFrameCount, formatPercent, formatValue, isSpecialFrame, metricUnit, roundShare, roundTreeShares, shQuote } from "./summary.js";

const DEFAULT_COUNT = 10;

export interface CalleesTreeOptions {
  depth?: number;
  expand?: boolean;
  n?: number;
}

export interface CalleesTreeData {
  metric: Metric;
  /** "us" or "bytes" - see metricUnit(). */
  unit: "us" | "bytes";
  function: string;
  total: number;
  children: CallTreeNode[];
  childrenCut: number;
  /** True only when `function` itself calls itself directly - its own self time and its own
   *  further callees are already folded into `children` (model.ts's buildCallTree), so this is a
   *  fact about the merge, not a hint to look anywhere else. Omitted when false. */
  recursive?: true;
  /** The next command to run, without the leading "do: ". */
  do: string;
}

/**
 * The heaviest direct own child - drilling into it is the most concrete next step, since it is
 * real project code the agent can open. Only when there is no own child at all (every direct
 * callee is a collapsed non-own area) does it fall back to the heaviest child overall, which by
 * elimination is that collapsed area's own entry frame - still worth drilling into, since
 * `callees` on it expands one level further into that package. Neither ever picks a special
 * frame (root/program/idle/gc) - there is no code there to drill into. A leaf function (no
 * qualifying children at all) falls back to its own callers instead, unless `fn` itself is a
 * special frame, in which case even that would go nowhere useful - the final fallback is the
 * plain top list.
 */
function chooseDo(children: CallTreeNode[], fn: AnalyzedFunction, profilePath: string, windowArgs: string): string {
  const real = children.filter((c) => !c.isSelf && !isSpecialFrame(c.key));
  const heaviest = real.find((c) => c.area === "own") ?? real[0];
  if (heaviest !== undefined) {
    return `finderscope callees ${shQuote(profilePath)} ${shQuote(heaviest.key)}${windowArgs}`;
  }
  if (!isSpecialFrame(fn.key)) {
    return `finderscope callers ${shQuote(profilePath)} ${shQuote(fn.key)}${windowArgs}`;
  }
  return `finderscope top ${shQuote(profilePath)}${windowArgs}`;
}

export function buildCalleesTree(
  analysis: ProfileAnalysis,
  fn: AnalyzedFunction,
  profilePath: string,
  options: CalleesTreeOptions = {},
  windowArgs = "",
): CalleesTreeData {
  const tree = buildCallTree(analysis, fn, "down", { depth: options.depth, expand: options.expand, childrenPerLevel: options.n });
  const data: CalleesTreeData = {
    metric: analysis.metric,
    unit: metricUnit(analysis.metric),
    function: fn.key,
    total: fn.total,
    children: roundTreeShares(tree.children),
    childrenCut: tree.childrenCut,
    do: chooseDo(tree.children, fn, profilePath, windowArgs),
  };
  if (tree.recursive) data.recursive = true;
  return data;
}

function label(node: CallTreeNode): string {
  const base = node.isSelf ? "(self)" : node.area === "own" ? node.key : `${node.area}: ${node.key}`;
  return node.recursive === true ? `${base} (recursive)` : base;
}

function renderNodes(
  nodes: CallTreeNode[],
  childrenCut: number,
  metric: Metric,
  depth: number,
  profilePath: string,
  fn: string,
  windowArgs: string,
  lines: string[],
): void {
  const indent = "  ".repeat(depth);
  for (const node of nodes) {
    lines.push(`  ${formatValue(metric, node.value).padStart(8)}  ${formatPercent(node.share).padStart(6)}  ${indent}${label(node)}`);
    renderNodes(node.children, node.childrenCut, metric, depth + 1, profilePath, fn, windowArgs, lines);
    if (node.depthCut === true) {
      lines.push(
        `  ${indent}  … deeper: ${formatValue(metric, node.depthCutValue ?? 0)} in ${formatFrameCount(node.depthCutFrames ?? 0)} (finderscope callees ${shQuote(profilePath)} ${shQuote(node.key)}${windowArgs})`,
      );
    }
  }
  if (childrenCut > 0) {
    const shown = nodes.filter((n) => !n.isSelf).length + childrenCut;
    lines.push(`  ${indent}… ${childrenCut} more (finderscope callees ${shQuote(profilePath)} ${shQuote(fn)} -n ${shown}${windowArgs})`);
  }
}

export function formatCalleesTreeText(data: CalleesTreeData, profilePath: string, windowArgs = ""): string {
  const lines: string[] = [
    `profile: ${profilePath}`,
    "",
    `finderscope callees "${data.function}" (total ${formatValue(data.metric, data.total)})${data.recursive === true ? " (recursive)" : ""}`,
    "",
  ];
  renderNodes(data.children, data.childrenCut, data.metric, 0, profilePath, data.function, windowArgs, lines);
  lines.push("");
  lines.push(`do: ${data.do}`);
  return lines.join("\n");
}

// --paths: the older flat list of distinct folded paths, by request behind a flag now.
export interface CalleesPathsData {
  metric: Metric;
  /** "us" or "bytes" - see metricUnit(). */
  unit: "us" | "bytes";
  function: string;
  total: number;
  paths: { segments: string[]; value: number; share: number }[];
  cut: number;
  /** The next command to run, without the leading "do: ". */
  do: string;
}

export function buildCalleesPaths(analysis: ProfileAnalysis, fn: AnalyzedFunction, profilePath: string, n = DEFAULT_COUNT, windowArgs = ""): CalleesPathsData {
  const areaOf = (key: string): string => analysis.functions.get(key)?.area ?? "unknown";
  const suffixes: { keys: string[]; value: number }[] = [];
  for (const path of analysis.paths) {
    const idx = path.keys.indexOf(fn.key);
    if (idx === -1) continue;
    suffixes.push({ keys: path.keys.slice(idx), value: path.value });
  }
  const all = groupKeyPaths(suffixes, areaOf, fn.total);
  return {
    metric: analysis.metric,
    unit: metricUnit(analysis.metric),
    function: fn.key,
    total: fn.total,
    paths: all.slice(0, n).map((p) => ({ ...p, share: roundShare(p.share) })),
    cut: Math.max(0, all.length - n),
    do: `finderscope callees ${shQuote(profilePath)} ${shQuote(fn.key)}${windowArgs}`,
  };
}

export function formatCalleesPathsText(data: CalleesPathsData, profilePath: string, windowArgs = ""): string {
  const lines: string[] = [
    `profile: ${profilePath}`,
    "",
    `finderscope callees "${data.function}" --paths (total ${formatValue(data.metric, data.total)})`,
    "",
  ];
  for (const p of data.paths) {
    lines.push(`  ${formatValue(data.metric, p.value).padStart(8)}  ${formatPercent(p.share).padStart(6)}  ${p.segments.join(" -> ")}`);
  }
  if (data.cut > 0) {
    const shown = data.paths.length + data.cut;
    lines.push(`  … ${data.cut} more (finderscope callees ${shQuote(profilePath)} ${shQuote(data.function)} --paths -n ${shown}${windowArgs})`);
  }
  lines.push("");
  lines.push(`do: ${data.do}`);
  return lines.join("\n");
}
