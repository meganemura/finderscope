import { defineStep, z } from "nukadoko";
import profileScript from "./profile-script.js";

export default defineStep({
  description: "Asserts the report's do: command asks finderscope about the first fix candidate.",
  pattern: "the report names a next command for that function",
  args: z.object({ next: z.string(), fixCandidates: z.array(z.string()) }),
  returns: z.object({}),
  from: { next: [profileScript, "next"], fixCandidates: [profileScript, "fixCandidates"] },
  mutates: false,
  rationale: "Every argument in a do: line is single-quoted, so the candidate's key appears quoted exactly as the report printed it.",
  run({}, { next, fixCandidates }) {
    if (!next.startsWith("finderscope ")) throw new Error(`expected a finderscope command, got: ${next}`);
    if (!next.includes(`'${fixCandidates[0]}'`)) throw new Error(`expected the command to name '${fixCandidates[0]}', got: ${next}`);
    return {};
  },
});
