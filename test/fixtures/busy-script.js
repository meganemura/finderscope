// Fixture for test/real-profile.test.ts: profiled for real with `node --cpu-prof` so the test
// checks profile/cpu.ts against actual V8 output, not just hand-written JSON.
function busy(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += Math.sqrt(i);
  }
  return s;
}

const start = Date.now();
while (Date.now() - start < 200) {
  busy(50000);
}
