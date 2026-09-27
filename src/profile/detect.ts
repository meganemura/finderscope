// Responsibility: tell a .cpuprofile from a .heapprofile by shape, not by file extension -
// `run` writes files without trusting a caller-supplied name, and a renamed fixture must still work.
// Boundary: does not parse either format; profile/cpu.ts and profile/heap.ts do that.

export type ProfileKind = "cpu" | "heap";

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
 * A .cpuprofile has a flat `nodes` array plus `samples`/`timeDeltas`. A .heapprofile has a
 * nested `head` node instead. Neither format carries a "kind" field of its own, so the shape
 * is the only signal.
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
  throw new ProfileShapeError("unrecognized profile shape: expected .cpuprofile (nodes/samples) or .heapprofile (head)");
}
