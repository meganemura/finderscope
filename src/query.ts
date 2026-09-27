// Responsibility: resolve a `<function>` CLI argument against an analysis's function map: an
// exact function key first, then a substring of the function's name if it picks out exactly one
// function.
// Boundary: does not know about self/total/area or reports - only the lookup and its error shape.

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

/**
 * Exact key match wins outright (this is what a report itself prints, so pasting it back always
 * works). Otherwise a substring of the *name* portion of the key must match exactly one function -
 * matching against the whole key would make a path fragment shadow a name a caller actually typed.
 */
export function resolveFunction(analysis: ProfileAnalysis, query: string, topCommand: string): AnalyzedFunction {
  const exact = analysis.functions.get(query);
  if (exact !== undefined) return exact;

  const bySubstring = [...analysis.functions.values()].filter((fn) => fn.name.includes(query));
  if (bySubstring.length === 1) return bySubstring[0]!;

  throw new AmbiguousFunctionError(query, bySubstring, topCommand);
}
