// Responsibility: turn a normalized profile (profile/cpu.ts or profile/heap.ts) into the ranked
// facts a report needs: a function identity, self/total per function, area totals, and folded hot
// call paths. Function identity, area classification, and the recursion-safe total-time rule all
// live here so every report command reads them the same way.
// Boundary: does not format anything for a human or JSON - report/*.ts turns this into text or a
// JSON shape. Does not resolve a <function> argument typed by a user - query.ts does that against
// the `functions` map this module produces.

import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedCpuProfile } from "./profile/cpu.js";
import type { NormalizedHeapProfile } from "./profile/heap.js";
import { createSourceMapper, type SourceMapper } from "./sourcemap.js";

export type Metric = "time" | "bytes";

export interface AnalyzedFunction {
  key: string;
  name: string;
  area: string;
  self: number;
  total: number;
}

export interface CallPath {
  /** Already folded for display; see fold() below. */
  segments: string[];
  value: number;
  share: number;
}

export interface Handoff {
  /** The last "own" function's key on a contribution's path before its leaf - the caller-side of
   *  the hand-off that ends in `toArea`. See computeHandoffs() for why "last before the leaf",
   *  not "first non-own frame after an own one". */
  fromKey: string;
  /** The leaf's own area - the same area its self time already counts toward in areaTotals. */
  toArea: string;
  value: number;
}

export interface ProfileAnalysis {
  metric: Metric;
  /** Microseconds for a cpu profile, bytes for a heap profile. */
  total: number;
  functions: Map<string, AnalyzedFunction>;
  areaTotals: Map<string, number>;
  hottest: CallPath[];
  /** Every contribution's full root-to-leaf key chain, unfolded - callers.ts and callees.ts
   *  truncate and fold these themselves around one function. */
  paths: { keys: string[]; value: number }[];
  /** Every contribution's (fromKey, toArea) attribution - the last own frame before its leaf, and
   *  the leaf's own area - aggregated by that pair, unsorted and uncapped. report/summary.ts
   *  groups these by area and applies its own display and `do:` thresholds. See
   *  computeHandoffs() below for why each contribution attributes to at most one pair. */
  handoffs: Handoff[];
}

export interface AnalyzeOptions {
  /** Shortens an "own" frame's printed path when the frame is under it. Does not decide whether a
   *  frame is "own" - see classifyPath()'s own comment. */
  root: string;
  hottestPathCount?: number;
}

// Special V8 frames are areas in their own right, not code - "(root)" is V8's synthetic tree
// root and, in the rare profile where a sample lands directly on it, is treated the same as
// "(program)" bookkeeping rather than left unclassified.
//
// A Map, not a plain object: `functionName` is real, untrusted code text, and a plain
// `Record<string, string>` lookup like `SPECIAL_AREAS[functionName]` inherits Object.prototype -
// a function literally named "constructor" (or "toString", "valueOf", ...) made
// `SPECIAL_AREAS["constructor"]` return `Object.prototype.constructor` (a function, not
// undefined), which classify() then took as a real match and stored as an AREA VALUE. Every area
// consumer downstream expects a string; this crashed at "a.area.padEnd is not a function" the
// first time real code profiled had a class with a constructor. A Map has no prototype chain to
// leak through, so a lookup miss is always exactly `undefined`.
const SPECIAL_AREAS: Map<string, string> = new Map([
  ["(root)", "program"],
  ["(program)", "program"],
  ["(idle)", "idle"],
  ["(garbage collector)", "gc"],
]);

export interface GenericFrame {
  functionName: string;
  url: string;
  line: number;
  column: number;
}

export interface GenericNode {
  id: number;
  parentId: number | undefined;
  frame: GenericFrame;
}

export interface ClassifyResult {
  key: string;
  name: string;
  area: string;
}

interface PathClassification {
  area: string;
  /**
   * The path as it should be PRINTED - shorter than the raw absolute path an agent already knows
   * how to shorten mentally, but still enough to open the file and resolve as a <function>
   * argument (see classify()'s key construction): a project-relative path for "own" when it is
   * inside --root (the raw absolute path otherwise - --root only ever shortens a path, never
   * changes what area a real file belongs to), or a package-relative one
   * (`typescript/lib/typescript.js`, including the package name - a real bare specifier an agent
   * could `require()`) for a package, since the area column already names the package and
   * repeating an absolute node_modules path added nothing.
   */
  displayPath: string;
}

/**
 * Classifies a resolved absolute (or file://) path into its area and its short display form.
 * "own" means source the agent can edit - every real file not under any node_modules, whether or
 * not it happens to sit under --root. A profiled process routinely loads code from a sibling
 * checkout, a global install, or anywhere else on disk; none of that is a dependency, and none of
 * it deserves a separate "not under my root" area - that used to be "external", and it hid a
 * profiled program's own code the instant the tool ran from a different checkout than the one
 * being profiled (an agent had to discover and hand-set --root before "your code by total" showed
 * anything at all). --root's only remaining job is to shorten a path that happens to sit under it;
 * it no longer decides whether a real file is "own". Every package under any node_modules gets the
 * *last* node_modules segment (`.../.pnpm/.../node_modules/x` resolves to `x`), because pnpm's own
 * store path would otherwise leak package areas named after pnpm's internal directory layout
 * instead of the real package; the display path is rebuilt from the same split segments (joined
 * with `/`), not the original OS-separator substring, so it reads as a real specifier on Windows
 * too.
 */
function classifyPath(path: string, projectRoot: string): PathClassification {
  const nmSegment = `node_modules${sep}`;
  const nmIdx = path.lastIndexOf(nmSegment);
  if (nmIdx !== -1) {
    const rest = path.slice(nmIdx + nmSegment.length);
    const segments = rest.split(/[\\/]/).filter((s) => s.length > 0);
    const first = segments[0];
    if (first === undefined) return { area: "own", displayPath: path };
    const isScoped = first.startsWith("@") && segments[1] !== undefined;
    const area = isScoped ? `${first}/${segments[1]}` : first;
    return { area, displayPath: segments.join("/") };
  }
  const rel = relative(projectRoot, path);
  const displayPath = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
  return { area: "own", displayPath };
}

/** True for a string with a URL scheme (`webpack://...`), not a plain path. sourcemap.ts already
 *  converts a `file://` mapped source to a local path, so by the time classify() sees a source
 *  with a scheme at all, it is guaranteed not to be file:. */
function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

/**
 * A mapped source that is itself a URL with a scheme other than file: (`webpack://./src/x.ts`,
 * ...) - shown exactly as the map wrote it, never through relative(): relative() resolves a
 * non-absolute argument against the running process's own cwd, which is exactly the mistake the
 * native-frame bug (classify()'s own comment) made with a different placeholder string. "own"
 * only when the URL's own text has no node_modules segment; otherwise the same node_modules
 * detection classifyPath() uses, since that is plain string search and works on a URL's path part
 * too, without treating it as a real filesystem path.
 */
function classifyMappedSourceUrl(source: string): PathClassification {
  const nmSegment = "node_modules/";
  const nmIdx = source.lastIndexOf(nmSegment);
  if (nmIdx === -1) return { area: "own", displayPath: source };
  const rest = source.slice(nmIdx + nmSegment.length);
  const segments = rest.split("/").filter((s) => s.length > 0);
  const first = segments[0];
  if (first === undefined) return { area: "own", displayPath: source };
  const isScoped = first.startsWith("@") && segments[1] !== undefined;
  const area = isScoped ? `${first}/${segments[1]}` : first;
  return { area, displayPath: source };
}

function localize(url: string): string {
  if (url.startsWith("file://")) {
    try {
      return fileURLToPath(url);
    } catch {
      return url;
    }
  }
  return url;
}

/**
 * A real file this project (or anything else on disk) actually has: a file:// url, or a plain
 * absolute path - node --cpu-prof commonly reports a local script's url as a bare absolute path,
 * with no `file://` scheme at all. Anything else with a nonempty url ("[eval]",
 * "evalmachine.<anonymous>", a bundler's synthetic url, ...) is not a file on disk and must never
 * be classified as "own" no matter what classifyPath's relative() check would say about it -
 * see classify()'s own comment on the native-frame bug this same mistake caused.
 */
function isFileUrl(url: string): boolean {
  return url.startsWith("file://") || isAbsolute(url);
}

/**
 * Function key = `name path:line:col`, 1-based, after source mapping (design.md), with `path`
 * shortened by area (classifyPath's `displayPath`) so the key is what's actually printed - a
 * project-relative path for "own" (relative to --root when the file is under it, its full
 * absolute path otherwise), a package-relative one for a package, the untouched `node:` specifier
 * for node internals. A special frame's key is just its own name, with no path suffix - appending
 * a fabricated ":1:1" to "(program)" would imply a real source position that does not exist. Four
 * more frame shapes have no real file and so never classify as "own", each with its own area
 * rather than a fabricated position: an empty url (a V8 builtin) is "native", a `wasm:` url is
 * "wasm", and any other nonempty, non-node:, non-file url ("[eval]",
 * "evalmachine.<anonymous>", ...) is "eval" - the native-frame bug (a plain-object lookup letting
 * "(native)" quietly resolve as a one-segment path "inside" --root's default of process.cwd())
 * showed exactly why a placeholder must never be run through the ordinary path-classification
 * check that real files get.
 */
/** Exported for test/helpers/oracle.ts only: an independent oracle for model.ts's self/total/area
 *  aggregation needs a real per-frame key and area, but re-deriving own/package/node/wasm/eval/
 *  native classification itself is not what that oracle checks - only the aggregation is. */
export function classify(node: GenericNode, projectRoot: string, mapper: SourceMapper): ClassifyResult {
  const { functionName, url, line, column } = node.frame;
  const specialArea = SPECIAL_AREAS.get(functionName);
  if (specialArea !== undefined) {
    return { key: functionName, name: functionName, area: specialArea };
  }

  const name = functionName === "" ? "(anonymous)" : functionName;

  if (url === "") {
    return { key: `${name} (native)`, name, area: "native" };
  }
  if (url.startsWith("node:")) {
    return { key: `${name} ${url}:${line + 1}:${column + 1}`, name, area: "node" };
  }
  if (url.startsWith("wasm:")) {
    return { key: `${name} ${url}:${line + 1}:${column + 1}`, name, area: "wasm" };
  }
  if (!isFileUrl(url)) {
    return { key: `${name} ${url}:${line + 1}:${column + 1}`, name, area: "eval" };
  }

  // A real file from here on: file:// or a plain absolute path, so a source map may apply.
  const mapped = mapper.map(url, line, column);
  let rawPath: string;
  let outLine: number;
  let outColumn: number;
  let fromUrl = false;
  if (mapped !== undefined) {
    rawPath = mapped.source;
    outLine = mapped.line + 1;
    outColumn = mapped.column + 1;
    fromUrl = hasScheme(mapped.source);
  } else {
    rawPath = localize(url);
    outLine = line + 1;
    outColumn = column + 1;
  }

  const { area, displayPath } = fromUrl ? classifyMappedSourceUrl(rawPath) : classifyPath(rawPath, projectRoot);
  const key = `${name} ${displayPath}:${outLine}:${outColumn}`;
  return { key, name, area };
}

function buildNodeInfo(nodes: Map<number, GenericNode>, projectRoot: string, mapper: SourceMapper): Map<number, ClassifyResult> {
  const info = new Map<number, ClassifyResult>();
  for (const [id, node] of nodes) info.set(id, classify(node, projectRoot, mapper));
  return info;
}

/**
 * Root-to-`id` chain of node ids - iterative, not recursive: a naive recursive version (one JS
 * call frame per ancestor) overflowed the real call stack on a deep enough call tree. Not
 * memoized across different ids on purpose: an earlier version cached a full copy of the growing
 * array at every ancestor along the way, so that a SINGLE very deep, mostly-linear chain (many
 * distinct node ids, each queried at most once - exactly what a real deep recursive call tree
 * looks like) built and cached ~n copies of ~n-long arrays, an O(n^2) memory blow-up bad enough to
 * crash the process on a profile with tens of thousands of stack frames. Since analyzeCore now
 * aggregates contributions by node id first (aggregateSampleTimeByNode), this is called at most
 * once per distinct sampled node anyway - reusing a shared prefix across separate calls would be
 * a minor optimization, not the thing that made this expensive.
 */
function chainOf(nodes: Map<number, GenericNode>, id: number): number[] {
  const result: number[] = [];
  let current: number | undefined = id;
  while (current !== undefined) {
    result.push(current);
    current = nodes.get(current)!.parentId;
  }
  result.reverse();
  return result;
}

/**
 * The set of distinct function keys on a node's own path back to the root. Used to add a
 * sample's (or a heap node's) value to a function's `total` exactly once per function even when
 * that function recurses - the ancestor path is a Set, so a repeated key contributes only one
 * membership, not one per occurrence. Iterative and not memoized across ids, for the same reason
 * chainOf() is - see its own comment.
 */
function pathKeysOf(nodes: Map<number, GenericNode>, info: Map<number, ClassifyResult>, id: number): Set<string> {
  const result = new Set<string>();
  let current: number | undefined = id;
  while (current !== undefined) {
    result.add(info.get(current)!.key);
    current = nodes.get(current)!.parentId;
  }
  return result;
}

/**
 * Folds a root-to-leaf key chain into display segments: a run of consecutive frames sharing the
 * same non-"own" area collapses into one `[area xN]` marker. "own" frames never collapse, one at
 * a time, because those are exactly the frames an agent can act on; a run through one package or
 * through node's internals is usually one indivisible call an agent cannot edit anyway, so folding
 * it keeps a path short without hiding anything actionable. Exported so report/callers.ts and
 * report/callees.ts fold a truncated path (root..function, or function..leaf) the same way.
 */
export function foldKeyChain(keys: string[], areaOf: (key: string) => string): string[] {
  const items: string[] = [];
  let i = 0;
  while (i < keys.length) {
    const key = keys[i]!;
    const area = areaOf(key);
    if (area === "own") {
      items.push(key);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < keys.length && areaOf(keys[j]!) === area) j++;
    const count = j - i;
    items.push(count === 1 ? key : `[${area} x${count}]`);
    i = j;
  }
  return items;
}

/**
 * Folds a root-to-leaf key chain around its "own" frames, for the summary's "hottest paths"
 * section specifically (report/callers.ts and report/callees.ts keep using plain foldKeyChain,
 * since those are already anchored to one resolved function): a bare "(root)" is dropped first -
 * it is always the profile's own total and names no code to open. What's left is shown as the
 * chain of own frames from the first one reached to the last one (folded the ordinary way in
 * between, so a brief dip out to a package and back still collapses), then exactly one more frame
 * - the first frame of whatever non-own area it hands off to - shown bare even if a longer run of
 * the same area follows, and only the REST of that run collapses into `[area xN]`. A path with no
 * own frame at all (idle, a pure bootstrap chain) isn't "about my code"; it falls back to ordinary
 * foldKeyChain over the whole (root-stripped) chain.
 */
function foldAroundOwnFrames(keys: string[], areaOf: (key: string) => string): string[] {
  const chain = keys[0] === "(root)" ? keys.slice(1) : keys;

  const firstOwn = chain.findIndex((k) => areaOf(k) === "own");
  if (firstOwn === -1) return foldKeyChain(chain, areaOf);

  let lastOwn = firstOwn;
  for (let i = chain.length - 1; i > lastOwn; i--) {
    if (areaOf(chain[i]!) === "own") {
      lastOwn = i;
      break;
    }
  }

  const ownPart = foldKeyChain(chain.slice(firstOwn, lastOwn + 1), areaOf);
  const rest = chain.slice(lastOwn + 1);
  if (rest.length === 0) return ownPart;

  const handoffFrame = rest[0]!;
  const tail = foldKeyChain(rest.slice(1), areaOf);
  return [...ownPart, handoffFrame, ...tail];
}

/**
 * Groups already-folded key-chain contributions by their exact folded signature, summing value.
 * Returns every group, sorted by value descending, uncapped - each caller (model.ts's own
 * `hottest`, or report/callers.ts and report/callees.ts) slices to its own default length so the
 * "cut" count each report prints is exact. `fold` defaults to the ordinary root-to-leaf
 * foldKeyChain; analyzeCore passes foldAroundOwnFrames for `hottest` specifically.
 */
export function groupKeyPaths(
  paths: { keys: string[]; value: number }[],
  areaOf: (key: string) => string,
  total: number,
  fold: (keys: string[], areaOf: (key: string) => string) => string[] = foldKeyChain,
): CallPath[] {
  const groups = new Map<string, { segments: string[]; value: number }>();
  for (const path of paths) {
    if (path.value <= 0) continue;
    const segments = fold(path.keys, areaOf);
    const signature = segments.join(" -> ");
    const existing = groups.get(signature);
    if (existing !== undefined) existing.value += path.value;
    else groups.set(signature, { segments, value: path.value });
  }
  return [...groups.values()]
    .sort((a, b) => b.value - a.value)
    .map((g) => ({ segments: g.segments, value: g.value, share: total > 0 ? g.value / total : 0 }));
}

/**
 * Attributes each contribution's value to at most one (fromKey, toArea) hand-off: `toArea` is the
 * contribution's own leaf area (the same area its self time already counts toward in areaTotals),
 * and `fromKey` is the LAST "own" frame anywhere before that leaf - not the first frame after
 * leaving "own", which double-counted a contribution once per own->non-own transition on a path
 * that dips back into own code and out again (e.g. recursion through a callback). A contribution
 * with no own ancestor at all contributes to no hand-off. Because every contribution is
 * attributed to at most one (fromKey, toArea) pair, and that pair's toArea always matches the
 * contribution's own leaf area, summing every hand-off's value for a given area can never exceed
 * that area's own total - equality when every one of that area's contributions has an own
 * ancestor, strictly less when some don't (a pure bootstrap chain with no own frame anywhere).
 */
function computeHandoffs(paths: { keys: string[]; value: number }[], areaOf: (key: string) => string): Handoff[] {
  const totals = new Map<string, { fromKey: string; toArea: string; value: number }>();
  for (const path of paths) {
    if (path.value <= 0 || path.keys.length === 0) continue;
    const toArea = areaOf(path.keys[path.keys.length - 1]!);
    if (toArea === "own") continue;

    let fromKey: string | undefined;
    for (let i = path.keys.length - 2; i >= 0; i--) {
      if (areaOf(path.keys[i]!) === "own") {
        fromKey = path.keys[i]!;
        break;
      }
    }
    if (fromKey === undefined) continue;

    const mapKey = `${fromKey}\u0000${toArea}`;
    const existing = totals.get(mapKey);
    if (existing !== undefined) existing.value += path.value;
    else totals.set(mapKey, { fromKey, toArea, value: path.value });
  }
  return [...totals.values()];
}

export interface CallTreeNode {
  key: string;
  area: string;
  value: number;
  /** Of the requested function's own total - the same denominator at every depth, so a reader can
   *  compare any two lines in the tree directly without doing the division themselves. */
  share: number;
  /** True only for the synthetic "(self)" row a node with children carries - not a real callee
   *  or caller. */
  isSelf: boolean;
  /** Non-empty only for an "own" node (or any node, under --expand) with depth budget left; a
   *  non-own node's whole subtree is collapsed into its own `value` instead - see buildCallTree's
   *  own comment. */
  children: CallTreeNode[];
  childrenCut: number;
}

export interface CallTreeOptions {
  depth?: number;
  expand?: boolean;
  childrenPerLevel?: number;
}

interface Chain {
  keys: string[];
  value: number;
}

function groupChainsByFirstKey(chains: Chain[]): Map<string, { value: number; rest: Chain[] }> {
  const groups = new Map<string, { value: number; rest: Chain[] }>();
  for (const chain of chains) {
    if (chain.value <= 0 || chain.keys.length === 0) continue;
    const key = chain.keys[0]!;
    const group = groups.get(key) ?? { value: 0, rest: [] };
    group.value += chain.value;
    group.rest.push({ keys: chain.keys.slice(1), value: chain.value });
    groups.set(key, group);
  }
  return groups;
}

/**
 * One level of a call tree, grouped by the immediate next key in each chain - "direct" callee or
 * caller, merged by function key rather than kept as separate per-sample paths (paths from
 * different samples that agree on every key up to some depth are the same real call edge, whether
 * or not they keep agreeing further down). `includeSelf` adds a "(self)" row for chains that end
 * exactly here (no further key): the requested function's own self time when this is the root
 * level, or - because the same recursive call handles every level - a nested own node's own self
 * time too. That row plus every real child's value always sums to exactly this level's own value
 * (every chain that reached this level falls into exactly one of those two buckets), which is the
 * invariant `test/model.property.test.ts` checks. A non-own node stops here rather than
 * recursing: its `value` already sums everything beneath it (every chain reaching it, regardless
 * of what came after), so the number is correct even though the breakdown is not shown - `expand`
 * lifts that stop so package internals expand exactly like own code would.
 */
function buildCallTreeLevel(chains: Chain[], areaOf: (key: string) => string, total: number, depthRemaining: number, options: Required<CallTreeOptions> & { includeSelf: boolean }): { nodes: CallTreeNode[]; cut: number } {
  const share = (value: number): number => (total > 0 ? value / total : 0);
  const groups = groupChainsByFirstKey(chains);
  const entries = [...groups.entries()].sort((a, b) => b[1].value - a[1].value);
  const shown = entries.slice(0, options.childrenPerLevel);
  const cut = Math.max(0, entries.length - options.childrenPerLevel);

  const nodes: CallTreeNode[] = [];
  if (options.includeSelf) {
    const selfValue = chains.filter((c) => c.value > 0 && c.keys.length === 0).reduce((sum, c) => sum + c.value, 0);
    // Omitted when zero, not printed as a "0.0ms 0.0%" row: a node whose every chain kept going
    // past it has nothing of its own to show, and the invariant checked in
    // test/call-tree.property.test.ts (children incl. self sum to the parent's value) holds
    // exactly the same whether a zero addend is present or left out.
    if (selfValue > 0) {
      nodes.push({ key: "(self)", area: "own", value: selfValue, share: share(selfValue), isSelf: true, children: [], childrenCut: 0 });
    }
  }
  for (const [key, group] of shown) {
    const area = areaOf(key);
    const expandable = area === "own" || options.expand;
    const sub = expandable && depthRemaining > 1 ? buildCallTreeLevel(group.rest, areaOf, total, depthRemaining - 1, options) : { nodes: [], cut: 0 };
    nodes.push({ key, area, value: group.value, share: share(group.value), isSelf: false, children: sub.nodes, childrenCut: sub.cut });
  }
  return { nodes, cut };
}

/**
 * The direct callees ("down") or direct callers ("up") of `fn`, merged by function key into a
 * tree instead of kept as a flat list of distinct per-sample paths - see report/callers.ts's and
 * report/callees.ts's own comments on why a flat list told an agent nothing once a function's
 * time scattered across hundreds of slightly different package-internal paths. "up" walks each
 * matching path's prefix in reverse (fn's immediate caller first, then its caller's caller, ...);
 * "up" has no "(self)" row - self time is a property of `fn` alone, not of who called it.
 */
export function buildCallTree(analysis: ProfileAnalysis, fn: AnalyzedFunction, direction: "down" | "up", options: CallTreeOptions = {}): { children: CallTreeNode[]; childrenCut: number } {
  const resolved = { depth: options.depth ?? 2, expand: options.expand ?? false, childrenPerLevel: options.childrenPerLevel ?? 10 };
  const areaOf = (key: string): string => analysis.functions.get(key)?.area ?? "unknown";

  const chains: Chain[] = [];
  for (const path of analysis.paths) {
    // The *first* occurrence of fn on this path is where it was first reached - a recursive
    // re-entry lower on the same path is still the same arrival, not a second distinct one.
    const idx = path.keys.indexOf(fn.key);
    if (idx === -1) continue;
    const keys = direction === "down" ? path.keys.slice(idx + 1) : path.keys.slice(0, idx).reverse();
    chains.push({ keys, value: path.value });
  }

  const level = buildCallTreeLevel(chains, areaOf, fn.total, resolved.depth, { ...resolved, includeSelf: direction === "down" });
  return { children: level.nodes, childrenCut: level.cut };
}

export interface TopDownOptions {
  rootCount?: number;
  depth?: number;
  childrenPerLevel?: number;
  expand?: boolean;
}

export interface TopDownResult {
  roots: CallTreeNode[];
  rootsCut: number;
}

/**
 * "Your code, top down": every contribution's own path has a *first* own frame - the outermost
 * point at which it reaches code the agent can edit at all - and this merges those by key into a
 * root, then builds a callee tree beneath each root the same way buildCallTree does for one
 * already-resolved function (merged by key, an own frame expanded, a non-own subtree collapsed).
 * A root's value is the sum of every path that reaches "own" code through it as the FIRST own
 * frame on that path - not that function's own `.total` (AnalyzedFunction.total), which also
 * counts a path that reaches the same function through a deeper own ancestor (recursion, or the
 * same handler called from two different top-level own call sites); using `.total` here would
 * double-count that second path under both its real root and this one. A path with no own frame
 * at all (idle, a pure bootstrap chain) has no root and is not counted here - it never reaches
 * code the agent can edit.
 */
export function buildTopDown(analysis: ProfileAnalysis, options: TopDownOptions = {}): TopDownResult {
  const rootCount = options.rootCount ?? 3;
  const depth = options.depth ?? 3;
  const childrenPerLevel = options.childrenPerLevel ?? 5;
  const expand = options.expand ?? false;
  const total = analysis.total;
  const share = (value: number): number => (total > 0 ? value / total : 0);
  const areaOf = (key: string): string => analysis.functions.get(key)?.area ?? "unknown";

  const chainsByRoot = new Map<string, Chain[]>();
  for (const path of analysis.paths) {
    if (path.value <= 0) continue;
    const firstOwnIdx = path.keys.findIndex((k) => areaOf(k) === "own");
    if (firstOwnIdx === -1) continue;
    const rootKey = path.keys[firstOwnIdx]!;
    const list = chainsByRoot.get(rootKey) ?? [];
    list.push({ keys: path.keys.slice(firstOwnIdx + 1), value: path.value });
    chainsByRoot.set(rootKey, list);
  }

  const rootTotals = [...chainsByRoot.entries()]
    .map(([key, chains]) => ({ key, value: chains.reduce((s, c) => s + c.value, 0), chains }))
    .sort((a, b) => b.value - a.value);

  const shown = rootTotals.slice(0, rootCount);
  const rootsCut = Math.max(0, rootTotals.length - rootCount);

  const roots: CallTreeNode[] = shown.map(({ key, value, chains }) => {
    const level = buildCallTreeLevel(chains, areaOf, total, depth, { depth, expand, childrenPerLevel, includeSelf: true });
    return { key, area: "own", value, share: share(value), isSelf: false, children: level.nodes, childrenCut: level.cut };
  });

  return { roots, rootsCut };
}

interface AnalyzeCoreInput {
  nodes: Map<number, GenericNode>;
  metric: Metric;
  total: number;
  /** One entry per unit of attribution: a sample (cpu) or a node's own bytes (heap). */
  contributions: { nodeId: number; value: number }[];
  root: string;
  hottestPathCount: number;
}

function analyzeCore(input: AnalyzeCoreInput): ProfileAnalysis {
  const mapper = createSourceMapper();
  const info = buildNodeInfo(input.nodes, input.root, mapper);

  const keyMeta = new Map<string, { area: string; name: string }>();
  for (const c of info.values()) {
    if (!keyMeta.has(c.key)) keyMeta.set(c.key, { area: c.area, name: c.name });
  }

  const functions = new Map<string, AnalyzedFunction>();
  const areaTotals = new Map<string, number>();
  function ensure(key: string): AnalyzedFunction {
    let fn = functions.get(key);
    if (fn === undefined) {
      const meta = keyMeta.get(key)!;
      fn = { key, name: meta.name, area: meta.area, self: 0, total: 0 };
      functions.set(key, fn);
    }
    return fn;
  }

  const paths: { keys: string[]; value: number }[] = [];
  for (const contribution of input.contributions) {
    if (contribution.value <= 0) continue;
    const own = info.get(contribution.nodeId)!;
    const selfFn = ensure(own.key);
    selfFn.self += contribution.value;
    areaTotals.set(own.area, (areaTotals.get(own.area) ?? 0) + contribution.value);

    for (const key of pathKeysOf(input.nodes, info, contribution.nodeId)) {
      ensure(key).total += contribution.value;
    }

    const keys = chainOf(input.nodes, contribution.nodeId).map((id) => info.get(id)!.key);
    paths.push({ keys, value: contribution.value });
  }

  // Every key reaching this point was produced by classify() during buildNodeInfo above, so
  // keyMeta always has it; "unknown" is an unreachable defensive fallback, not a real area.
  const areaOf = (key: string): string => keyMeta.get(key)?.area ?? "unknown";
  const hottest = groupKeyPaths(paths, areaOf, input.total, foldAroundOwnFrames).slice(0, input.hottestPathCount);
  const handoffs = computeHandoffs(paths, areaOf);

  return { metric: input.metric, total: input.total, functions, areaTotals, hottest, paths, handoffs };
}

/**
 * Aggregates by node id BEFORE building anything chain-shaped: a real profile's `samples` array
 * (its length is the sample count, potentially millions) routinely samples the same handful of
 * hot leaf nodes over and over, so summing time per node here first means every later step -
 * self/total accounting, chain and key-set building, hand-offs, the call tree - does its work at
 * most once per distinct node, never once per sample. Holding one number per sample (rather than
 * one running total per node) was the actual memory problem on a multi-million-sample profile.
 */
function aggregateSampleTimeByNode(profile: NormalizedCpuProfile): { nodeId: number; value: number }[] {
  const totals = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    const time = profile.sampleTimes[i]!;
    if (time <= 0) continue;
    const nodeId = profile.samples[i]!;
    totals.set(nodeId, (totals.get(nodeId) ?? 0) + time);
  }
  return [...totals.entries()].map(([nodeId, value]) => ({ nodeId, value }));
}

export function analyzeCpuProfile(profile: NormalizedCpuProfile, options: AnalyzeOptions): ProfileAnalysis {
  const contributions = aggregateSampleTimeByNode(profile);
  return analyzeCore({
    nodes: profile.nodes,
    metric: "time",
    total: profile.totalDuration,
    contributions,
    root: options.root,
    hottestPathCount: options.hottestPathCount ?? 3,
  });
}

export function analyzeHeapProfile(profile: NormalizedHeapProfile, options: AnalyzeOptions): ProfileAnalysis {
  const contributions = [...profile.nodes.values()]
    .filter((n) => n.selfSize > 0)
    .map((n) => ({ nodeId: n.id, value: n.selfSize }));
  return analyzeCore({
    nodes: profile.nodes,
    metric: "bytes",
    total: profile.totalBytes,
    contributions,
    root: options.root,
    hottestPathCount: options.hottestPathCount ?? 3,
  });
}
