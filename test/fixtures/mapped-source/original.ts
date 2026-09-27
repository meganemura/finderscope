// Fixture for test/real-profile.test.ts: compiled with `tsc --sourceMap` at test time into a
// scratch directory - never committed compiled output, since a source map's own absolute paths
// would be machine-specific if checked in - then profiled for real, to check source-map position
// mapping against actual V8 + tsc output. hotFunction's own body (lines 8-12) is indented, on
// purpose: tsc starts an indented line's first mapping segment at that line's own column, not
// column 0, which is exactly the shape that broke a naive "map at column 0" lookup.
export function hotFunction(): number {
  let total = 0;
  for (let i = 0; i < 500_000; i++) {
    total += Math.sqrt(i);
  }
  return total;
}

const start = Date.now();
while (Date.now() - start < 200) {
  hotFunction();
}
