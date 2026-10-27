import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill, mergeThroughGate } from "./shared.ts";

export const autonomousRun = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "autonomous-run",
  version: 1,
  title: "Autonomous run",
  description: "One long task driven to a checkable predicate without stopping.",
  source: {
    playbook: "poteto-mode/playbooks/autonomous-run.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "571fc630aad901b077af1236cb0381ab7ee4a800e3143622128ca11aadc1d63f",
  },
  steps: [
    findVerifySkill,
    {
      title: "Exit predicate and wake set",
      slug: "set-predicate",
      instructions:
        "State the exit condition as a checkable predicate before the first iteration. Wake on an event where one exists, with watch_pull_request or a watcher and a long schedule_task heartbeat as fallback, or on a fixed-interval schedule_task when there is none. Keep the scheduledTaskId and delete it on done, stop or handback. Open the show-me-your-work trail.",
      proofLevel: "required",
      proofHint: "the predicate and the scheduledTaskId",
      waitsForUser: false,
    },
    {
      title: "Predicate met",
      slug: "drive-to-predicate",
      instructions:
        "Each iteration makes the smallest change the evidence justifies, checks it against the predicate through the project's verify skill, commits if it advanced and reverts if not, and logs a row. Fix mid-run discoveries yourself in their own PR, and surface only irreversible actions, calls no experiment can settle, or a real dead end. A plateau is not a stop. Never relax the predicate.",
      proofLevel: "required",
      proofHint: "the final predicate state and the trail path",
      waitsForUser: false,
    },
    mergeThroughGate(),
    ...closingSteps,
  ],
});
