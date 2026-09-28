// Responsibility: identify V8 profile kinds from a small prefix or an already-parsed JSON shape.
// `run` writes files without trusting a caller-supplied name, and a renamed fixture must still work.
// Boundary: does not parse any format; profile/cpu.ts, profile/heap.ts, and
// profile/heapsnapshot.ts own their format-specific validation.

import { closeSync, openSync, readSync } from "node:fs";

export type ProfileKind = "cpu" | "heap" | "heap-snapshot";

/**
 * A deliberate, expected complaint about a profile file's own shape (missing nodes, a node with
 * no id, a missing head, ...) - thrown by detectProfileKind here and by profile/cpu.ts's and
 * profile/heap.ts's own parsers. Its own class, not a plain Error, so src/cli.ts can tell "this
 * profile is malformed" (a caller-facing CliError) apart from an unexpected exception elsewhere
 * in parsing or analysis (a finderscope bug) by `instanceof`, not by matching error text - text
 * a future change to either parser's wording would silently break.
 */
export class ProfileShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileShapeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A .cpuprofile has flat nodes and samples, a .heapprofile has a nested head, and a heap snapshot
 * has snapshot metadata. These formats carry no common kind field, so their shapes identify them.
 */
export function detectProfileKind(json: unknown): ProfileKind {
  if (!isRecord(json)) {
    throw new ProfileShapeError("profile JSON is not an object");
  }
  if (Array.isArray(json["nodes"]) && Array.isArray(json["samples"])) {
    return "cpu";
  }
  if (isRecord(json["head"]) && "callFrame" in json["head"]) {
    return "heap";
  }
  if (isRecord(json["snapshot"]) && isRecord(json["snapshot"]["meta"])) return "heap-snapshot";
  throw new ProfileShapeError("unrecognized profile shape: expected .cpuprofile, .heapprofile, or .heapsnapshot");
}

export function detectProfileFileKind(path: string): ProfileKind | undefined {
  if (path.toLowerCase().endsWith(".heapsnapshot")) return "heap-snapshot";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const prefix = buffer.toString("utf8", 0, length).replace(/^\s+/, "");
    if (prefix.startsWith('{"snapshot":{"meta":')) return "heap-snapshot";
    return undefined;
  } finally {
    closeSync(fd);
  }
}
