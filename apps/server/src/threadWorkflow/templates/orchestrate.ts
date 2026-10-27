import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

export const orchestrate = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "orchestrate",
  version: 2,
  title: "Orchestrate",
  description:
    "A standing program run by one coordinator: many units, many stacked PRs, a fleet of workers.",
  source: {
    playbook: "poteto-mode/playbooks/orchestrate.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "1dd1e53c8a9a81c75235a78bfba0f8d2f13e5dbb08507d70fcebf9ade66060a0",
  },
  steps: [
    findVerifySkill,
    {
      title: "Program framed and runtime installed",
      slug: "frame-program",
      instructions:
        "State the done predicate as a count, the scope, the wall-clock budget and the tracks. If you would do the work yourself in this session, it is not a program: close this workflow and start autonomous-run. Otherwise run `orch init`, open the decision trail, write the standing orders before any spawn, and seed frontier.json from existing PRs.",
      proofLevel: "required",
      proofHint: "the framing and the store path",
      waitsForUser: false,
    },
    {
      title: "One unit piloted end to end",
      slug: "pilot-one-unit",
      instructions:
        "Push one unit through brief, worker, verification through the project's verify skill, stack entry, ledger row and merge. Fix the brief, the verify recipe and the unit size from its evidence before fan-out. On near-identical cheap units, the first unit is the pilot.",
      proofLevel: "required",
      proofHint: "the pilot's PR and its ledger row",
      waitsForUser: false,
    },
    {
      title: "Units drained and landed",
      slug: "scale-and-land",
      instructions:
        "Keep a rolling window of workers up to the in-flight cap, refill as children finish, and run the queue discipline at every drain. Land verified units continuously through the merge gate, keeping the frontier green before upper-stack work. Park each escalation in gates.md and ask it with `thread_workflow_ask`, batched, and route work around it.",
      proofLevel: "required",
      proofHint: "the orch status lines and the ledger summary",
      waitsForUser: false,
    },
    {
      title: "Program closed against its predicate",
      slug: "close-program",
      instructions:
        "Drain the final inbox, reconcile every agent to a terminal row, confirm the predicate on the real artifact and a verdict for every landed head, audit the trail, and encode recurring corrections. Leave the store intact.",
      proofLevel: "required",
      proofHint: "the closing counts",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
