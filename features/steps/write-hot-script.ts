import { defineStep, z } from "nukadoko";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = `function settle(n) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += Math.sqrt(i) * Math.sin(i);
  }
  return total;
}

const start = Date.now();
while (Date.now() - start < 300) {
  settle(50000);
}
`;

export default defineStep({
  description: "Writes a script whose function settle() keeps the CPU busy for about 300 ms, in a scratch directory.",
  pattern: "a script whose own function spends most of the run on the CPU",
  args: z.object({}),
  returns: z.object({
    dir: z.string().describe("the scratch directory that holds the script"),
    script: z.string().describe("the script's absolute path"),
    scriptName: z.string().describe("the script's path relative to dir, as finderscope prints it under --root"),
    hotFunction: z.string().describe("the name of the function that spends the time"),
    hotLine: z.number().describe("the 1-based line of the hot function's loop body"),
  }),
  mutates: true,
  rationale:
    "The script is written fresh rather than read from test/fixtures, so the scenario names its own hot line and does not move when a unit-test fixture changes. 300 ms of busy work keeps the function far above V8's 1 ms sampling interval on a slow CI runner.",
  run({ scratch }) {
    const dir = scratch.dir("finderscope-scenario");
    const script = join(dir, "settle.js");
    writeFileSync(script, SCRIPT);
    return { dir, script, scriptName: "settle.js", hotFunction: "settle", hotLine: 4 };
  },
});
