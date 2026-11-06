import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

/**
 * Version 5 has each owner merge on your acceptance after the verifier's review. A running instance
 * keeps its copied steps.
 */
export const orchestrate = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "orchestrate",
  version: 5,
  title: "Orchestrate",
  description:
    "A standing program run by one coordinator: many units, many stacked PRs, a fleet of workers.",
  source: {
    playbook: "poteto-mode/playbooks/orchestrate.md",
    commit: "1d51f196d44be4f806b5d27700ad04c98e769aa1",
    sha256: "b3c4cf254a192dc2a6528ac823674f665e315d9ed993d4683f90b01feca11108",
  },
  steps: [
    findVerifySkill,
    {
      title: "Program framed",
      slug: "frame-program",
      instructions:
        "State the goal, the scope and the tracks. If you would do the work yourself in this session, it is not a program: close this workflow and start autonomous-run. Otherwise keep the program's state in this workflow and in `orchestrate/<project-slug>/` in the pstack store.",
      proofLevel: "required",
      proofHint: "the goal and the state folder",
      waitsForUser: false,
    },
    {
      title: "One unit piloted end to end",
      slug: "pilot-one-unit",
      instructions:
        "Take one unit through kickoff, owner, verifier and merge before fan-out, and fix the kickoff from what it shows. Each kickoff names the evidence that proves the unit done, such as a check through the project's verify skill. On near-identical cheap units, the first unit is the pilot.",
      proofLevel: "required",
      proofHint: "the pilot's PR, its review and your acceptance",
      waitsForUser: false,
    },
    {
      title: "Units landed",
      slug: "scale-and-land",
      instructions:
        "Keep about ten workers in flight, one owner per PR and a fresh worker per task, and start the next as each finishes. Each owner merges through the merge gate on your acceptance at its current head, after a review from a verifier on another model family. Read the diff, not the summary, and check each PR's live state before you report it. Ask the user with `thread_workflow_ask` only for a real decision or a blocker, and route work around it.",
      proofLevel: "required",
      proofHint: "each PR's live state, review and acceptance",
      waitsForUser: false,
    },
    {
      title: "Program closed against its goal",
      slug: "close-program",
      instructions:
        "Account for every worker as done, replaced or absorbed, confirm what landed against the goal on the real artifact with a review and your acceptance for every landed head, and list what was dropped and why.",
      proofLevel: "required",
      proofHint: "what landed, what was dropped and why",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
