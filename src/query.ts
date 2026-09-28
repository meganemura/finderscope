// Responsibility: resolve a `<function>` CLI argument against an analysis's function map: an
// exact function key first, then the same key through realpath (a symlinked directory named
// differently in the query than in the profile still resolves, and so does a missing path that one
// side spells with a longer prefix),
// then a unique bare name or name substring. A miss ranks close keys for the caller to format as
// runnable commands.
// Boundary: does not know about self/total/area or report data - only lookup and error shape.

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AnalyzedFunction, ProfileAnalysis } from "./model.js";

export class AmbiguousFunctionError extends Error {
  readonly candidates: AnalyzedFunction[];
  /** The `do:` line for this error, kept separate from `message` so a --json error can carry it
   *  as its own "do" field instead of the CLI having to re-parse it out of prose. */
  readonly do: string;
  readonly suggestions: string[];

  // `topCommand` is the caller's ready-to-run `finderscope top <profile>` command: this module does
  // not know the profile path or the shell quoting rules, and the do: line must be runnable as is.
  constructor(query: string, candidates: AnalyzedFunction[], topCommand: string, suggestions: string[] = []) {
    const shown = candidates.slice(0, 10);
    const lines = shown.map((c) => `  ${c.key}`);
    const more = candidates.length > shown.length ? `\n  … ${candidates.length - shown.length} more` : "";
    const isEmpty = candidates.length === 0;
    super(isEmpty
      ? `no function matches "${query}"; the do: commands show the closest function keys`
      : `"${query}" matches more than one function:\n${lines.join("\n")}${more}`);
    this.name = "AmbiguousFunctionError";
    this.candidates = candidates;
    this.suggestions = suggestions;
    this.do = suggestions[0] ?? topCommand;
  }
}

// A key is `name path:line:col` (model.ts's classify()) - name first, since a name can hold
// almost anything a real identifier can, but never a colon-digit-colon-digit suffix, so anchoring
// from the END is the only split that can't be fooled by a name containing a space.
const LOCATION_PATTERN = /^(.*):(\d+):(\d+)$/;

interface ParsedKey {
  name: string;
  path: string;
  line: string;
  column: string;
}

function parseKeyForName(key: string, name: string): ParsedKey | undefined {
  const prefix = `${name} `;
  if (!key.startsWith(prefix)) return undefined;
  const m = LOCATION_PATTERN.exec(key.slice(prefix.length));
  if (m === undefined || m === null) return undefined;
  return { name, path: m[1]!, line: m[2]!, column: m[3]! };
}

/**
 * Resolves `path` to the real filesystem path realpathSync would report, or its plain resolved
 * (non-realpathed) absolute form when it doesn't exist on disk at all - a package-relative or
 * special-frame path (never a real absolute path on this machine) has nothing to realpath, and a
 * profile can outlive the files it named. Cached per absolute path, since a
 * 23k-file profile can carry many differently-spelled paths that all resolve to the same real one
 * and realpathSync is a syscall per distinct absolute path, not free to repeat.
 */
const realpathCache = new Map<string, string>();
function resolveReal(path: string, root: string): string {
  const abs = isAbsolute(path) ? path : join(root, path);
  const cached = realpathCache.get(abs);
  if (cached !== undefined) return cached;
  let real = abs;
  try {
    if (existsSync(abs)) real = realpathSync(abs);
  } catch {
    // Left as `abs` - a race (removed between existsSync and realpathSync) is not this module's
    // problem to report.
  }
  realpathCache.set(abs, real);
  return real;
}

/** True when `longer` ends with `shorter` at a path-segment boundary, and `shorter` keeps at least
 * a directory and a file name. A one-segment suffix such as "/main.js" is refused because it would
 * match every file of that name. */
function endsWithPath(longer: string, shorter: string): boolean {
  if (longer.length <= shorter.length || !longer.endsWith(shorter) || !shorter.startsWith("/")) return false;
  return shorter.split("/").filter((segment) => segment.length > 0).length >= 2;
}

/** Two paths name the same file when their realpaths are equal. A profile can outlive the files it
 * named, and then realpath cannot see through a symlinked prefix (macOS's temporary directory is
 * one). For a missing path, one path ending with the other also counts. A fixed table of platform
 * prefixes is refused: the suffix rule covers every symlinked prefix, and resolveFunction still
 * rejects a suffix that matches more than one function. */
function samePath(a: string, b: string, root: string): boolean {
  const realA = resolveReal(a, root);
  const realB = resolveReal(b, root);
  if (realA === realB) return true;
  const absA = isAbsolute(a) ? a : join(root, a);
  const absB = isAbsolute(b) ? b : join(root, b);
  if (existsSync(absA) && existsSync(absB)) return false;
  return endsWithPath(realA, realB) || endsWithPath(realB, realA);
}

/**
 * True when `query` and `candidateKey` name the same function (same name, line, column) whose
 * paths resolve to the same real file - even when the query spelled a symlinked directory
 * differently from the profile (a symlinked prefix). Both sides must parse as a real
 * `name path:line:col` key. Missing paths use the suffix rule in samePath; a query with no such
 * shape (a special frame or name fragment) does not compare paths.
 */
function sameFunctionByRealpath(candidate: AnalyzedFunction, query: string, root: string): boolean {
  const q = parseKeyForName(query, candidate.name);
  if (q === undefined) return false;
  const c = parseKeyForName(candidate.key, candidate.name);
  if (c === undefined) return false;
  if (c.name !== q.name || c.line !== q.line || c.column !== q.column) return false;
  return samePath(c.path, q.path, root);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

function possibleQueryPaths(query: string): string[] {
  const location = LOCATION_PATTERN.exec(query);
  if (location === null) return [];
  const beforeLine = location[1]!;
  const paths: string[] = [];
  for (let i = 0; i < beforeLine.length; i++) {
    if (beforeLine[i] === " ") paths.push(beforeLine.slice(i + 1));
  }
  return paths;
}

function closestFunctions(analysis: ProfileAnalysis, query: string, root: string): AnalyzedFunction[] {
  const queryPaths = possibleQueryPaths(query);
  const sameFile = (fn: AnalyzedFunction): boolean => {
    const candidate = parseKeyForName(fn.key, fn.name);
    if (candidate === undefined) return false;
    return queryPaths.some((queryPath) => samePath(candidate.path, queryPath, root));
  };
  return [...analysis.functions.values()]
    .map((fn) => ({
      fn,
      group: parseKeyForName(query, fn.name) !== undefined ? 0 : sameFile(fn) ? 1 : 2,
      distance: editDistance(query, query.includes(" ") ? fn.key : fn.name),
    }))
    .sort((a, b) => a.group - b.group || a.distance - b.distance || a.fn.key.localeCompare(b.fn.key))
    .slice(0, 3)
    .map((item) => item.fn);
}

/**
 * Exact key match wins outright (this is what a report itself prints, so pasting it back always
 * works). Next, the same key through realpath - see sameFunctionByRealpath(). An exact bare name
 * wins before a substring of the *name* portion. Matching against the whole key would let a path
 * fragment shadow a name the caller typed.
 */
export function resolveFunction(
  analysis: ProfileAnalysis,
  query: string,
  topCommand: string,
  root: string,
  commandForKey?: (key: string) => string,
): AnalyzedFunction {
  const ambiguous = (candidates: AnalyzedFunction[]): AmbiguousFunctionError =>
    new AmbiguousFunctionError(query, candidates, topCommand, commandForKey === undefined ? [] : candidates.slice(0, 3).map((fn) => commandForKey(fn.key)));
  const exact = analysis.functions.get(query);
  if (exact !== undefined) return exact;

  const byRealpath = [...analysis.functions.values()].filter((fn) => sameFunctionByRealpath(fn, query, root));
  if (byRealpath.length === 1) return byRealpath[0]!;
  if (byRealpath.length > 1) throw ambiguous(byRealpath);

  const byName = [...analysis.functions.values()].filter((fn) => fn.name === query);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw ambiguous(byName);

  const bySubstring = [...analysis.functions.values()].filter((fn) => fn.name.includes(query));
  if (bySubstring.length === 1) return bySubstring[0]!;
  if (bySubstring.length > 1) throw ambiguous(bySubstring);

  const closest = closestFunctions(analysis, query, root);
  const suggestions = commandForKey === undefined ? [] : closest.map((fn) => commandForKey(fn.key));
  throw new AmbiguousFunctionError(query, [], topCommand, suggestions);
}
