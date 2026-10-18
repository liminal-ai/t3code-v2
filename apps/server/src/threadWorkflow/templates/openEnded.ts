import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const openEnded = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "open-ended",
  version: 1,
  title: "Open-ended",
  description: "Work no playbook fits. You state the goal and insert the steps it needs.",
  source: null,
  steps: [
    {
      title: "State the goal",
      instructions:
        "Say what this work is for and how you will know it is done. The comment on your tick is the statement.",
      proofLevel: "none",
      waitsForUser: false,
    },
    {
      title: "Plan the steps",
      instructions:
        'Insert each step this work needs, one per outcome, the first after this step and each later one after the step before it: thread_workflow_change {"action":"insert","afterStepId":"<step id>","title":"<step title>","instructions":"<what to do>","reason":"<why>"}. Then tick this step.',
      proofLevel: "none",
      waitsForUser: false,
    },
    {
      title: "Confirm done with the user",
      instructions:
        "Ask the user once whether the goal is met. Tick with their answer, or insert the steps that are still missing.",
      proofLevel: "required",
      proofHint: "the user's answer",
      waitsForUser: true,
    },
  ],
});
