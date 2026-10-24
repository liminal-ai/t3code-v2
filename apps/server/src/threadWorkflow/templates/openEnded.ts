import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Version 1 carried "State the goal" and "Plan the steps", which told the agent to insert steps
 * one call at a time. The plan now arrives in the start call, so the template keeps only the
 * sign-off; a running v1 instance keeps its copied steps.
 */
export const openEnded = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "open-ended",
  version: 2,
  title: "Open-ended",
  description:
    "Work no playbook fits. Start it with steps: 4 to 7 stages at one level, titled for the user. They go before the sign-off step.",
  source: null,
  steps: [
    {
      title: "Confirm done with the user",
      instructions:
        'Ask the user once whether the goal is met, and tick with their answer. If this is the only step, the plan is missing: add 4 to 7 stages above it, each an outcome at the same level as the others and titled for the user, the first with thread_workflow_change {"action":"insert","afterStepId":null,...} and each next one after the one before.',
      proofLevel: "required",
      proofHint: "the user's answer",
      waitsForUser: true,
    },
  ],
});
