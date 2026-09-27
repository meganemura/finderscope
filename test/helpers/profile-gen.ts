// Shared by every *.property.test.ts that needs a random .cpuprofile-shaped call tree: the frame
// pool and the tree/sample builder. Not itself a test file - Hegel's own generators (gs.record,
// gs.arrays, ...) build values from a fixed shape, so a shape this pool never includes (a
// function named "constructor", a query-string url, ...) can never come up no matter how many
// cases run. Widened in response to a real crash (`a.area.padEnd is not a function`, from a real
// class's `constructor` method) that no property test had ever produced, precisely because the
// old pool had no frame whose name collided with Object.prototype.
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";

export const FRAME_POOL = [
  { functionName: "own1", url: "file:///project/src/a.js" },
  { functionName: "own2", url: "file:///project/src/b.js" },
  { functionName: "libFn", url: "file:///project/node_modules/some-lib/index.js" },
  { functionName: "scopedFn", url: "file:///project/node_modules/@scope/pkg/index.js" },
  // A numeric-looking package name - npm allows an all-digit name (e.g. the real package "0"),
  // and `Number("123")` is not NaN, a shape a lookup keyed carelessly by number-vs-string could
  // get wrong the same way Object.prototype tripped up a plain-object string lookup.
  { functionName: "numericPkgFn", url: "file:///project/node_modules/123/index.js" },
  { functionName: "nodeFn", url: "node:fs" },
  { functionName: "nodeInternalFn", url: "node:internal/fs/utils" },
  // A bundler-added cache-busting query string (Vite HMR and friends do this) on an otherwise
  // ordinary project file.
  { functionName: "queryStringFn", url: "file:///project/src/c.js?t=1700000000000" },
  // Every one of these names is a real, inherited Object.prototype own property. A plain object
  // used as a `functionName -> area` lookup table resolves any of them through the prototype
  // chain instead of returning undefined for "not a special frame" - see model.ts's own comment
  // on SPECIAL_AREAS for the bug this caused.
  { functionName: "constructor", url: "file:///project/src/d.js" },
  { functionName: "toString", url: "file:///project/src/e.js" },
  { functionName: "hasOwnProperty", url: "file:///project/src/f.js" },
  { functionName: "__proto__", url: "file:///project/src/g.js" },
  { functionName: "(program)", url: "" },
  { functionName: "(idle)", url: "" },
  { functionName: "(garbage collector)", url: "" },
];

/**
 * V8's own per-line tick counts (see profile/cpu.ts's own comment on the 1-based-in-the-generated-
 * script convention) - drawn with a mix of a real tick total (>0, so a node contributes to
 * model.ts's lineSelfTimes) and an all-zero one (a node that has a positionTicks array but
 * nothing in it, which model.ts must still exclude the same as "no array at all") - the exclusion
 * test/lines.property.test.ts checks needs both shapes to actually occur.
 */
function drawPositionTicks(tc: TestCase): { line: number; ticks: number }[] {
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
  const ticks: { line: number; ticks: number }[] = [];
  for (let i = 0; i < count; i++) {
    ticks.push({ line: tc.draw(gs.integers({ minValue: 1, maxValue: 20 })), ticks: tc.draw(gs.integers({ minValue: 0, maxValue: 50 })) });
  }
  return ticks;
}

/**
 * Builds a random valid call tree (node i>0's parent is some earlier node) plus a random
 * samples/timeDeltas pair over it, as the raw JSON shape profile/cpu.ts parses. Node 0 is always
 * "(root)", matching every real profile's own shape (and letting a property test actually
 * exercise the "(root) is always dropped first" fold rule, not just a coincidence of the pool).
 * timeDeltas include negative integers - a real clock adjustment - deliberately, so a property
 * that held only because every generated delta happened to be nonnegative would fail here instead
 * of in a real profile. `withPositionTicks` attaches a random positionTicks array (drawPositionTicks)
 * to a random subset of non-root nodes - off by default, so every existing caller of this
 * function keeps generating exactly the profiles it always has.
 */
export function drawCpuProfileJson(tc: TestCase, maxNodes = 12, maxSamples = 20, options: { withPositionTicks?: boolean } = {}): unknown {
  const nodeCount = tc.draw(gs.integers({ minValue: 1, maxValue: maxNodes }));
  const nodes: unknown[] = [];
  for (let id = 0; id < nodeCount; id++) {
    const frame = id === 0 ? { functionName: "(root)", url: "" } : tc.draw(gs.sampledFrom(FRAME_POOL));
    const children: number[] = [];
    const positionTicks = options.withPositionTicks && id > 0 && tc.draw(gs.booleans()) ? drawPositionTicks(tc) : undefined;
    nodes.push({
      id,
      callFrame: { functionName: frame.functionName, url: frame.url, lineNumber: 0, columnNumber: 0 },
      children,
      ...(positionTicks !== undefined ? { positionTicks } : {}),
    });
    if (id > 0) {
      const parentId = tc.draw(gs.integers({ minValue: 0, maxValue: id - 1 }));
      (nodes[parentId] as { children: number[] }).children.push(id);
    }
  }

  const sampleCount = tc.draw(gs.integers({ minValue: 0, maxValue: maxSamples }));
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(tc.draw(gs.integers({ minValue: 0, maxValue: nodeCount - 1 })));
    timeDeltas.push(tc.draw(gs.integers({ minValue: -100, maxValue: 500 })));
  }

  return { nodes, samples, timeDeltas };
}
