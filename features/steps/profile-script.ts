import { defineStep, z } from "nukadoko";
import { spawnSync } from "node:child_process";
import { BIN } from "./finderscope-bin.js";
import writeHotScript from "./write-hot-script.js";

export default defineStep({
  description: "Runs `finderscope run --json -- node <script>` from the script's directory and reads the cpu profile's report.",
  pattern: "the agent runs the script under finderscope",
  args: z.object({ dir: z.string(), script: z.string() }),
  returns: z.object({
    exitCode: z.number().describe("finderscope's own exit code"),
    fixCandidates: z.array(z.string()).describe("the fix candidates' function keys, highest caused time first"),
    next: z.string().describe("the report's do: command"),
  }),
  from: { dir: [writeHotScript, "dir"], script: [writeHotScript, "script"] },
  mutates: true,
  rationale:
    "--json is the shape an agent parses; the text report prints the same candidates and do: line. The step runs from the script's directory so --root resolves there, and the scratch directory finderscope keeps lands under the system temp directory.",
  run({}, { dir, script }) {
    const result = spawnSync(process.execPath, [BIN, "run", "--json", "--", process.execPath, script], {
      cwd: dir,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    const report = JSON.parse(result.stdout);
    const profile = report.profiles[0];
    return {
      exitCode: result.status ?? 1,
      fixCandidates: (profile?.fixCandidates ?? []).map((candidate: { key: string }) => candidate.key),
      next: report.do ?? "",
    };
  },
});
