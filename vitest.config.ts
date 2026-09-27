import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Property tests spawn real subprocesses (a real `node --cpu-prof` run) and shell out to the
    // local tsc; running test files one at a time avoids CPU contention between them and vitest's
    // own worker pool timing out a slow-but-passing case - measured: the whole suite passes
    // serially in well under a minute, and the marginal cause of a timeout under parallel workers
    // is cross-file CPU contention, not any single file's own cost.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
