// Responsibility: `lines` - the hot lines inside one function, from V8's own `positionTicks`
// (model.ts's computeLineSelfTimes turns those into ProfileAnalysis.lineSelfTimes/lineReadPaths):
// ranked by self time, with safe source previews and source-text matches for direct callee names.
// Exists because a hot caller can have little self time while its direct callees hold the cost.
// Boundary: reshapes one already-resolved function and reads guarded source files. It does not
// compute tick apportionment or infer measured call sites from source text.

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { buildCallTree, type AnalyzedFunction, type Metric, type ProfileAnalysis } from "../model.js";
import { formatPercent, formatValue, metricUnit, roundShare, shQuote } from "./summary.js";

const DEFAULT_COUNT = 10;
const DEFAULT_CALLEE_COUNT = 10;
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
  calleesBySourceLine: CalleeSourceEntry[];
  calleesCut: number;
  /** Set, with `lines`/`cut` left empty/0, when this profile or this function has no positionTicks
   *  data at all - a fact about the profile, never an error. */
  note: string | undefined;
  /** The next command to run, without the leading "do: ". */
  do: string;
}

export interface CalleeSourceEntry {
  key: string;
  value: number;
  /** Share of the selected function's inclusive total. */
  share: number;
  /** Source lines where the callee's name appears as a call expression. These are text matches,
   *  not measured call sites; an empty list means no safe source match was available. */
  nameAppearsOn: number[];
}

const NO_POSITION_TICKS_AT_ALL =
  "this profile has no positionTicks at all - an older Node build, or a .heapprofile, never carries per-line tick data";
const NO_POSITION_TICKS_FOR_FUNCTION = "this function has no positionTicks in this profile";
// Verified against a real recursive-call profile: V8's callFrame never carries a call site (only
// a callee's own definition position), and positionTicks is a self-time count with no inclusive
// counterpart - so a line's inclusive time is never derivable from a .cpuprofile at all, not
// merely unimplemented here. Every successful `lines` row carries only self time; this note says
// so and points at the one command that does show inclusive time.
const SELF_TIME_ONLY_NOTE =
  "each row is self time only - V8's positionTicks never carries a call site, so a line that calls a hot function looks cold here; see where a line's time goes with the callees command";
// positionTicks is one fixed array per node for the WHOLE profile - a window can only scale it by
// this function's windowed self time, using the whole profile's own per-line ratios, since there
// is no way to know which window a V8 tick actually fell in. The per-line split below is an
// ESTIMATE under a window, not a fact the way the unwindowed numbers are - stated here instead of
// silently presented as equally exact.
const WINDOWED_ESTIMATE_NOTE =
  "windowed: positionTicks has no timestamps, so each line's share is estimated from the whole profile's own per-line ratios, not counted specifically inside this window";

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

function readSafeSource(path: string): string[] | undefined {
  if (!isReadableSourceFile(path)) return undefined;
  try {
    return readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    return undefined;
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
      cache.set(info.path, readSafeSource(info.path));
    }
    const raw = cache.get(info.path)?.[info.line - 1];
    return raw !== undefined ? trimSource(raw) : undefined;
  };
}

function arrowBodyStart(lines: string[], startLine: number, startColumn: number): { lineIndex: number; column: number; block: boolean } | undefined {
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  for (let lineIndex = Math.max(0, startLine - 1); lineIndex < lines.length; lineIndex++) {
    const sourceLine = lines[lineIndex]!;
    for (let column = lineIndex === startLine - 1 ? Math.max(0, startColumn - 1) : 0; column < sourceLine.length; column++) {
      const ch = sourceLine[column]!;
      if (ch === "(") parenthesisDepth++;
      else if (ch === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      // A brace outside parameters opens a normal function or method. An arrow after that brace
      // belongs to the outer body and must not redefine its source range.
      else if (ch === "{" && parenthesisDepth === 0 && bracketDepth === 0) return undefined;
      else if (ch === "=" && sourceLine[column + 1] === ">") {
        let bodyLine = lineIndex;
        let bodyColumn = column + 2;
        while (bodyLine < lines.length) {
          const line = lines[bodyLine]!;
          while (bodyColumn < line.length && /\s/.test(line[bodyColumn]!)) bodyColumn++;
          if (bodyColumn < line.length) return { lineIndex: bodyLine, column: bodyColumn, block: line[bodyColumn] === "{" };
          bodyLine++;
          bodyColumn = 0;
        }
        return { lineIndex, column: column + 2, block: false };
      }
    }
  }
  return undefined;
}

function conventionalBodyStart(lines: string[], startLine: number, startColumn: number): { lineIndex: number; column: number } | undefined {
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  for (let lineIndex = Math.max(0, startLine - 1); lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    for (let column = lineIndex === startLine - 1 ? Math.max(0, startColumn - 1) : 0; column < line.length; column++) {
      const ch = line[column]!;
      if (ch === "(") parenthesisDepth++;
      else if (ch === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (ch === "{" && parenthesisDepth === 0 && bracketDepth === 0) return { lineIndex, column };
    }
  }
  return undefined;
}

function expressionEndLine(lines: string[], start: { lineIndex: number; column: number }): number {
  let depth = 0;
  let sawToken = false;
  for (let lineIndex = start.lineIndex; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    for (let i = lineIndex === start.lineIndex ? start.column : 0; i < line.length; i++) {
      const ch = line[i]!;
      if (!/\s/.test(ch)) sawToken = true;
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
      else if (ch === ";" && depth === 0) return lineIndex + 1;
    }
    if (sawToken && depth === 0) {
      const current = line.trimEnd();
      const next = lines.slice(lineIndex + 1).find((candidate) => candidate.trim() !== "")?.trimStart() ?? "";
      const continuesAfter = /(?:[?:.,+\-*/%&|^=!<>]|\b(?:in|instanceof))$/.test(current);
      const continuesBefore = /^(?:[?:.,+\-*/%&|^=<>]|\?\?|&&|\|\||\(|\[)/.test(next);
      if (!continuesAfter && !continuesBefore) return lineIndex + 1;
    }
  }
  return start.lineIndex + 1;
}

/** Finds the closing brace for a conventional function body. The small scanner ignores braces
 * in strings and comments. An expression-body arrow ends at its own semicolon instead of taking
 * the next block in the file as its body. */
function functionEndLine(lines: string[], startLine: number, startColumn: number): number {
  const arrow = arrowBodyStart(lines, startLine, startColumn);
  if (arrow !== undefined && !arrow.block) return expressionEndLine(lines, arrow);
  const body = arrow ?? conventionalBodyStart(lines, startLine, startColumn);
  if (body === undefined) return startLine;
  let depth = 0;
  let opened = false;
  const firstLine = body.lineIndex;
  for (let lineIndex = firstLine; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    for (let i = lineIndex === firstLine ? body.column : 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === "{") {
        opened = true;
        depth++;
      } else if (ch === "}" && opened) {
        depth--;
        if (depth === 0) return lineIndex + 1;
      }
    }
  }
  return startLine;
}

function codeOnlyLines(lines: string[]): string[] {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let blockComment = false;
  let template = false;
  let templateExpressionDepth = 0;
  let regex = false;
  let regexClass = false;
  const result: string[] = [];
  for (const line of lines) {
    let code = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      const next = line[i + 1];
      if (blockComment) {
        code += " ";
        if (ch === "*" && next === "/") { code += " "; blockComment = false; i++; }
        continue;
      }
      if (quote !== undefined) {
        code += " ";
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = undefined;
        continue;
      }
      if (template) {
        code += " ";
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "`") template = false;
        else if (ch === "$" && next === "{") {
          code += " ";
          template = false;
          templateExpressionDepth = 1;
          i++;
        }
        continue;
      }
      if (regex) {
        code += " ";
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "[" && !regexClass) regexClass = true;
        else if (ch === "]" && regexClass) regexClass = false;
        else if (ch === "/" && !regexClass) regex = false;
        continue;
      }
      if (ch === "/" && next === "/") {
        code += " ".repeat(line.length - i);
        break;
      }
      if (ch === "/" && next === "*") { code += "  "; blockComment = true; i++; continue; }
      if (ch === "/" && regexCanStart(code)) { code += " "; regex = true; regexClass = false; continue; }
      if (ch === "'" || ch === '"') { code += " "; quote = ch; continue; }
      if (ch === "`") { code += " "; template = true; continue; }
      if (templateExpressionDepth > 0 && ch === "{") templateExpressionDepth++;
      else if (templateExpressionDepth > 0 && ch === "}") {
        templateExpressionDepth--;
        if (templateExpressionDepth === 0) {
          code += " ";
          template = true;
          continue;
        }
      }
      code += ch;
    }
    result.push(code);
  }
  return result;
}

function regexCanStart(code: string): boolean {
  const before = code.trimEnd();
  return before === ""
    || /[([{,:;=!?&|+\-*%^~<>]$/.test(before)
    || /\b(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await)$/.test(before);
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function calleeNameLines(lines: string[] | undefined, startLine: number, startColumn: number, name: string): number[] {
  if (lines === undefined || !/^[$_\p{ID_Start}][$\u200C\u200D_\p{ID_Continue}]*$/u.test(name)) return [];
  const code = codeOnlyLines(lines);
  const endLine = functionEndLine(code, startLine, startColumn);
  const identifier = "[$\\u200C\\u200D_\\p{ID_Continue}]";
  const escaped = escapedRegex(name);
  const call = new RegExp(`(?:\\.${escaped}|(?<!${identifier})${escaped})\\s*\\(`, "gu");
  const rangeLines = code.slice(startLine - 1, endLine);
  if (rangeLines.length > 0) rangeLines[0] = " ".repeat(Math.max(0, startColumn - 1)) + rangeLines[0]!.slice(Math.max(0, startColumn - 1));
  const range = rangeLines.join("\n");
  const found = new Set<number>();
  for (const match of range.matchAll(call)) {
    const before = range.slice(0, match.index);
    found.add(startLine + (before.match(/\n/g)?.length ?? 0));
  }
  return [...found];
}

function buildCalleesBySourceLine(analysis: ProfileAnalysis, fn: AnalyzedFunction): { entries: CalleeSourceEntry[]; cut: number } {
  const direct = buildCallTree(analysis, fn, "down", { depth: 1, expand: true, childrenPerLevel: Number.MAX_SAFE_INTEGER })
    .children.filter((node) => !node.isSelf && node.value > 0);
  const location = analysis.functionReadPaths.get(fn.key);
  const source = location === undefined ? undefined : readSafeSource(location.path);
  const all = direct.map((node) => ({
    key: node.key,
    value: node.value,
    share: roundShare(node.share),
    nameAppearsOn: calleeNameLines(source, location?.line ?? 1, location?.column ?? 1, analysis.functions.get(node.key)?.name ?? ""),
  }));
  return { entries: all.slice(0, DEFAULT_CALLEE_COUNT), cut: Math.max(0, all.length - DEFAULT_CALLEE_COUNT) };
}

export function buildLines(analysis: ProfileAnalysis, fn: AnalyzedFunction, profilePath: string, n = DEFAULT_COUNT, windowArgs = ""): LinesData {
  const callees = buildCalleesBySourceLine(analysis, fn);
  const base = {
    metric: analysis.metric,
    unit: metricUnit(analysis.metric),
    function: fn.key,
    self: fn.self,
    total: analysis.total,
    lines: [],
    cut: 0,
    calleesBySourceLine: callees.entries,
    calleesCut: callees.cut,
  };
  const fallbackDo = `finderscope callees ${shQuote(profilePath)} ${shQuote(fn.key)}${windowArgs}`;

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
    note: windowArgs.length > 0 ? WINDOWED_ESTIMATE_NOTE : SELF_TIME_ONLY_NOTE,
    do: fallbackDo,
  };
}

export function formatLinesText(data: LinesData, profilePath: string, windowArgs = ""): string {
  const lines: string[] = [
    `profile: ${profilePath}`,
    "",
    `finderscope lines "${data.function}" (self ${formatValue(data.metric, data.self)})`,
    "",
  ];
  for (const l of data.lines) {
    const sourceSuffix = l.source !== undefined ? `  ${l.source}` : "";
    lines.push(
      `  ${formatValue(data.metric, l.value).padStart(8)}  ${formatPercent(l.selfShare).padStart(6)}  ${formatPercent(l.totalShare).padStart(6)}  ${l.key}${sourceSuffix}`,
    );
  }
  if (data.cut > 0) {
    const shown = data.lines.length + data.cut;
    lines.push(`  … ${data.cut} more (finderscope lines ${shQuote(profilePath)} ${shQuote(data.function)} -n ${shown}${windowArgs})`);
  }
  if (data.note !== undefined) {
    lines.push(`note: ${data.note}`);
  }
  lines.push("");
  lines.push("callees by source line (name matches, not measured):");
  // An unreadable source (a deleted build, a stripped bundle) fails every row the
  // same way. Repeating the same line under each callee is refused as noise.
  const anyCallSiteFound = data.calleesBySourceLine.some((callee) => callee.nameAppearsOn.length > 0);
  for (const callee of data.calleesBySourceLine) {
    lines.push(`  ${formatValue(data.metric, callee.value).padStart(8)}  ${formatPercent(callee.share).padStart(6)}  ${callee.key}`);
    if (!anyCallSiteFound) continue;
    lines.push(callee.nameAppearsOn.length > 0
      ? `    name appears on: ${callee.nameAppearsOn.join(", ")}`
      : "    call site not found in source");
  }
  if (data.calleesBySourceLine.length > 0 && !anyCallSiteFound) {
    lines.push("  call sites not found in source for any callee");
  }
  if (data.calleesBySourceLine.length === 0) lines.push("  no direct callees");
  if (data.calleesCut > 0) lines.push(`  … ${data.calleesCut} more`);
  lines.push("");
  lines.push(`do: ${data.do}`);
  return lines.join("\n");
}
