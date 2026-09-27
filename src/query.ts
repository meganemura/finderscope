// Responsibility: resolve a `<function>` CLI argument against an analysis's function map: an
// exact function key first, then the same key through realpath (a symlinked directory named
// differently in the query than in the profile - /tmp vs /private/tmp on macOS - still resolves),
// then a substring of the function's name if it picks out exactly one function.
// Boundary: does not know about self/total/area or reports - only the lookup and its error shape.

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AnalyzedFunction, ProfileAnalysis } from "./model.js";

export class AmbiguousFunctionError extends Error {
  readonly candidates: AnalyzedFunction[];
  /** The `do:` line for this error, kept separate from `message` so a --json error can carry it
   *  as its own "do" field instead of the CLI having to re-parse it out of prose. */
  readonly do: string;

  // `topCommand` is the caller's ready-to-run `finderscope top <profile>` command: this module does
  // not know the profile path or the shell quoting rules, and the do: line must be runnable as is.
  constructor(query: string, candidates: AnalyzedFunction[], topCommand: string) {
    const shown = candidates.slice(0, 10);
    const lines = shown.map((c) => `  ${c.key}`);
    const more = candidates.length > shown.length ? `\n  … ${candidates.length - shown.length} more` : "";
    const isEmpty = candidates.length === 0;
    super(isEmpty
      ? `no function matches "${query}"; the do: command lists the function keys`
      : `"${query}" matches more than one function:\n${lines.join("\n")}${more}`);
    this.name = "AmbiguousFunctionError";
    this.candidates = candidates;
    this.do = isEmpty ? topCommand : "pass one of the keys above as '<function>'";
  }
}

// A key is `name path:line:col` (model.ts's classify()) - name first, since a name can hold
// almost anything a real identifier can, but never a colon-digit-colon-digit suffix, so anchoring
// from the END is the only split that can't be fooled by a name containing a space.
const KEY_PATTERN = /^(.*) ([^ ]+):(\d+):(\d+)$/;

interface ParsedKey {
  name: string;
  path: string;
  line: string;
  column: string;
}

function parseKey(key: string): ParsedKey | undefined {
  const m = KEY_PATTERN.exec(key);
  if (m === undefined || m === null) return undefined;
  return { name: m[1]!, path: m[2]!, line: m[3]!, column: m[4]! };
}

/**
 * Resolves `path` to the real filesystem path realpathSync would report, or its plain resolved
 * (non-realpathed) absolute form when it doesn't exist on disk at all - a package-relative or
 * special-frame path (never a real absolute path on this machine) has nothing to realpath, and a
 * profile can outlive the files it named. Cached per resolved path, not per raw input, since a
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

/**
 * True when `query` and `candidateKey` name the same function (same name, line, column) whose
 * paths resolve to the same real file - even when the query spelled a symlinked directory
 * differently from the profile (e.g. /tmp vs. macOS's real /private/tmp). Both sides must parse as
 * a real `name path:line:col` key and both paths must actually exist on disk; a query or candidate
 * with no such shape (a special frame, a substring fragment) never reaches realpathSync at all.
 */
function sameFunctionByRealpath(candidateKey: string, query: string, root: string): boolean {
  const q = parseKey(query);
  if (q === undefined) return false;
  const c = parseKey(candidateKey);
  if (c === undefined) return false;
  if (c.name !== q.name || c.line !== q.line || c.column !== q.column) return false;
  return resolveReal(c.path, root) === resolveReal(q.path, root);
}

/**
 * Exact key match wins outright (this is what a report itself prints, so pasting it back always
 * works). Next, the same key through realpath - see sameFunctionByRealpath(). Otherwise a
 * substring of the *name* portion of the key must match exactly one function - matching against
 * the whole key would make a path fragment shadow a name a caller actually typed.
 */
export function resolveFunction(analysis: ProfileAnalysis, query: string, topCommand: string, root: string): AnalyzedFunction {
  const exact = analysis.functions.get(query);
  if (exact !== undefined) return exact;

  const byRealpath = [...analysis.functions.values()].filter((fn) => sameFunctionByRealpath(fn.key, query, root));
  if (byRealpath.length === 1) return byRealpath[0]!;
  if (byRealpath.length > 1) throw new AmbiguousFunctionError(query, byRealpath, topCommand);

  const bySubstring = [...analysis.functions.values()].filter((fn) => fn.name.includes(query));
  if (bySubstring.length === 1) return bySubstring[0]!;

  throw new AmbiguousFunctionError(query, bySubstring, topCommand);
}
