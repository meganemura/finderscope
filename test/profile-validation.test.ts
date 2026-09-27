// Regression tests for profile/cpu.ts's and profile/heap.ts's own input validation, against
// exactly the malformed-profile shapes that used to reach model.ts and crash with a raw "Cannot
// read properties of undefined" instead of a clear ProfileShapeError naming what was wrong and
// where: a sample id with no node; a parent or child naming a missing node; a cycle; a
// non-finite/non-number delta; a missing required field.
import { test } from "vitest";
import assert from "node:assert/strict";
import { parseCpuProfile } from "../src/profile/cpu.js";
import { parseHeapProfile } from "../src/profile/heap.js";
import { ProfileShapeError } from "../src/profile/detect.js";

function assertShapeError(fn: () => unknown, messagePattern: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof ProfileShapeError, `expected a ProfileShapeError, got ${(e as Error)?.constructor?.name}: ${e}`);
    assert.match((e as Error).message, messagePattern);
    return true;
  });
}

test("a sample id with no node is a ProfileShapeError", () => {
  const json = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [2] },
      { id: 2, callFrame: { functionName: "f", url: "/a/x.js", lineNumber: 0, columnNumber: 0 }, children: [] },
    ],
    samples: [2, 99],
    timeDeltas: [0, 5],
  };
  assertShapeError(() => parseCpuProfile(json), /samples\[1\] references node 99, which does not exist/);
});

test("a child that names a missing node is a ProfileShapeError", () => {
  const json = {
    nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [99] }],
    samples: [1],
    timeDeltas: [0],
  };
  assertShapeError(() => parseCpuProfile(json), /node 1's child 99 does not exist/);
});

test("a parent that names a missing node is a ProfileShapeError", () => {
  const json = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "" } },
      { id: 2, parent: 7, callFrame: { functionName: "f", url: "/a/x.js" } },
    ],
    samples: [2],
    timeDeltas: [0],
  };
  assertShapeError(() => parseCpuProfile(json), /node 2's parent 7 does not exist/);
});

test("a cycle in the call tree is a ProfileShapeError", () => {
  const json = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
      { id: 2, callFrame: { functionName: "f", url: "/a/x.js" }, children: [3] },
      { id: 3, callFrame: { functionName: "g", url: "/a/x.js" }, children: [2] },
    ],
    samples: [3],
    timeDeltas: [0],
  };
  assertShapeError(() => parseCpuProfile(json), /the call tree has a cycle involving node/);
});

test("a non-number timeDelta ('5', a string) is a ProfileShapeError, not silently coerced", () => {
  const json = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
      { id: 2, callFrame: { functionName: "f", url: "/a/x.js" }, children: [] },
    ],
    samples: [2, 2, 2],
    timeDeltas: [0, "5", 7],
  };
  assertShapeError(() => parseCpuProfile(json), /timeDeltas\[1\] is not a finite number \(got "5"\)/);
});

test("a non-finite timeDelta (NaN via a non-numeric string) is a ProfileShapeError", () => {
  const json = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
      { id: 2, callFrame: { functionName: "f", url: "/a/x.js" }, children: [] },
    ],
    samples: [2, 2, 2],
    timeDeltas: [0, "x", 7],
  };
  assertShapeError(() => parseCpuProfile(json), /timeDeltas\[1\] is not a finite number \(got "x"\)/);
});

test("a missing \"nodes\" array is a ProfileShapeError", () => {
  assertShapeError(() => parseCpuProfile({ samples: [], timeDeltas: [] }), /missing its "nodes" array/);
});

test("a missing \"samples\" array is a ProfileShapeError", () => {
  const json = { nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "" }, children: [] }], timeDeltas: [] };
  assertShapeError(() => parseCpuProfile(json), /missing its "samples" array/);
});

test("a missing \"timeDeltas\" array is a ProfileShapeError", () => {
  const json = { nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "" }, children: [] }], samples: [] };
  assertShapeError(() => parseCpuProfile(json), /missing its "timeDeltas" array/);
});

test("an empty (but well-shaped) profile parses without error", () => {
  const json = { nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "" }, children: [] }], samples: [], timeDeltas: [] };
  const profile = parseCpuProfile(json);
  assert.equal(profile.totalDuration, 0);
});

test("a negative positionTicks.ticks is a ProfileShapeError", () => {
  const json = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
      { id: 2, callFrame: { functionName: "f", url: "/a/x.js" }, children: [], positionTicks: [{ line: 3, ticks: -1 }] },
    ],
    samples: [2],
    timeDeltas: [0],
  };
  assertShapeError(() => parseCpuProfile(json), /node 2's positionTicks has a non-integer or negative ticks value \(got -1\)/);
});

test("a non-integer positionTicks.ticks is a ProfileShapeError", () => {
  const json = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
      { id: 2, callFrame: { functionName: "f", url: "/a/x.js" }, children: [], positionTicks: [{ line: 3, ticks: 1.5 }] },
    ],
    samples: [2],
    timeDeltas: [0],
  };
  assertShapeError(() => parseCpuProfile(json), /node 2's positionTicks has a non-integer or negative ticks value \(got 1\.5\)/);
});

test("a non-finite selfSize on a heap node is a ProfileShapeError", () => {
  const json = { head: { id: 1, callFrame: { functionName: "(root)", url: "" }, selfSize: "not a number", children: [] } };
  assertShapeError(() => parseHeapProfile(json), /node 1's selfSize is not a finite number/);
});
