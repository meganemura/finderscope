// Fixture for test/real-profile.test.ts: compiled with `tsc --sourceMap` at test time into a
// scratch directory (never committed compiled output - see note 10 in the task that added this),
// then profiled for real, to check source-map position mapping against actual V8 + tsc output.
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
