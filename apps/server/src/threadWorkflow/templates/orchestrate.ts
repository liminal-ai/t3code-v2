import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

/**
 * Version 4 re-pins the playbook after it said when to message a worker for its built state; the
 * steps are unchanged. A running instance keeps its copied steps.
 */
export const orchestrate = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "orchestrate",
  version: 4,
  title: "Orchestrate",
  description:
    "A standing program run by one coordinator: many units, many stacked PRs, a fleet of workers.",
  source: {
    playbook: "poteto-mode/playbooks/orchestrate.md",
    commit: "fcdfb47c257bf938330063ced672bc4ad969e713",
    sha256: "4a676566bb483933cf24437303f15eab59f432d01a3285de6b9a7e22bb3ac538",
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
      proofHint: "the pilot's PR and its verdict",
      waitsForUser: false,
    },
    {
      title: "Units landed",
      slug: "scale-and-land",
      instructions:
        "Keep about ten workers in flight, one owner per PR and a fresh worker per task, and start the next as each finishes. Each owner merges through the merge gate on a pass at its current head from a verifier on another model family. Read the diff, not the summary, and check each PR's live state before you report it. Ask the user with `thread_workflow_ask` only for a real decision or a blocker, and route work around it.",
      proofLevel: "required",
      proofHint: "each PR's live state and verdict",
      waitsForUser: false,
    },
    {
      title: "Program closed against its goal",
      slug: "close-program",
      instructions:
        "Account for every worker as done, replaced or absorbed, confirm what landed against the goal on the real artifact with a verdict for every landed head, and list what was dropped and why.",
      proofLevel: "required",
      proofHint: "what landed, what was dropped and why",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
