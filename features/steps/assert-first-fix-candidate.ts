import { defineStep, z } from "nukadoko";
import profileScript from "./profile-script.js";
import writeHotScript from "./write-hot-script.js";

export default defineStep({
  description: "Asserts finderscope exited 0 and ranked the hot function first among the fix candidates.",
  pattern: "the first fix candidate is that function",
  args: z.object({ exitCode: z.number(), fixCandidates: z.array(z.string()), hotFunction: z.string(), scriptName: z.string() }),
  returns: z.object({}),
  from: {
    exitCode: [profileScript, "exitCode"],
    fixCandidates: [profileScript, "fixCandidates"],
    hotFunction: [writeHotScript, "hotFunction"],
    scriptName: [writeHotScript, "scriptName"],
  },
  mutates: false,
  rationale: "A key is `name path:line:col`; checking the name with the script's path rules out a same-named function elsewhere.",
  run({}, { exitCode, fixCandidates, hotFunction, scriptName }) {
    if (exitCode !== 0) throw new Error(`finderscope run exited ${exitCode}`);
    const first = fixCandidates[0] ?? "";
    if (!first.startsWith(`${hotFunction} ${scriptName}:`)) {
      throw new Error(`expected ${hotFunction} in ${scriptName} first, the candidates were [${fixCandidates.join(", ")}]`);
    }
    return {};
  },
});
