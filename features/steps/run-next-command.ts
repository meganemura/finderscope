import { defineStep, runCommand, z } from "nukadoko";
import { pathWithFinderscope } from "./finderscope-bin.js";
import profileScript from "./profile-script.js";
import writeHotScript from "./write-hot-script.js";

const ROW = /^\s+[\d.]+m?s\s+[\d.]+%\s+[\d.]+%\s+(\S+):(\d+)\s+(.*)$/;

// The do: line is a shell command meant to be pasted, so the step hands it to
// sh unchanged, with the built bin on PATH as `finderscope`, rather than
// splitting it. The rows are parsed from the text an agent would read.
export default defineStep({
  description: "Runs the report's do: command through sh, exactly as printed, and reads the per-line rows it prints.",
  pattern: "the agent runs the next command the report named",
  args: z.object({ next: z.string(), dir: z.string() }),
  returns: z.object({
    exitCode: z.number().describe("the command's exit code"),
    rows: z
      .array(z.object({ file: z.string(), line: z.number(), source: z.string() }))
      .describe("each printed source-line row, in printed order"),
  }),
  from: { next: [profileScript, "next"], dir: [writeHotScript, "dir"] },
  mutates: false,
  async run({ scratch }, { next, dir }) {
    const result = await runCommand("sh", ["-c", next], {
      cwd: dir,
      env: { ...process.env, PATH: pathWithFinderscope(scratch.dir("finderscope-bin")) },
    });
    const rows = result.stdout.split("\n").flatMap((line) => {
      const match = ROW.exec(line);
      return match ? [{ file: match[1]!, line: Number(match[2]), source: match[3]!.trim() }] : [];
    });
    return { exitCode: result.exitCode ?? 1, rows };
  },
});
