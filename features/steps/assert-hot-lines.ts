import { defineStep, z } from "nukadoko";
import runNextCommand from "./run-next-command.js";
import writeHotScript from "./write-hot-script.js";

// The loop body is where the samples land; a first row anywhere else would
// send the agent to the wrong line.
export default defineStep({
  description: "Asserts the command exited 0 and its first row is the hot function's loop body in the script.",
  pattern: "it prints the source lines of that function, the hottest first",
  args: z.object({
    exitCode: z.number(),
    rows: z.array(z.object({ file: z.string(), line: z.number(), source: z.string() })),
    scriptName: z.string(),
    hotLine: z.number(),
  }),
  from: {
    exitCode: [runNextCommand, "exitCode"],
    rows: [runNextCommand, "rows"],
    scriptName: [writeHotScript, "scriptName"],
    hotLine: [writeHotScript, "hotLine"],
  },
  mutates: false,
  run({}, { exitCode, rows, scriptName, hotLine }) {
    if (exitCode !== 0) throw new Error(`the next command exited ${exitCode}`);
    const first = rows[0];
    if (first === undefined) throw new Error("the next command printed no source-line rows");
    if (first.file !== scriptName || first.line !== hotLine) {
      throw new Error(`expected ${scriptName}:${hotLine} first, got ${first.file}:${first.line} (${first.source})`);
    }
  },
});
