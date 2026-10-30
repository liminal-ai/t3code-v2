import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

/**
 * Version 1 carried "State the goal" and "Plan the steps", which told the agent to insert steps
 * one call at a time. Version 2 kept only the sign-off, so open-ended work skipped the steps every
 * playbook template opens and closes with. Version 3 carries them around the plan, with the
 * sign-off last. A running instance keeps its copied steps.
 */
export const openEnded = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "open-ended",
  version: 3,
  title: "Open-ended",
  description:
    "Work no playbook fits. Start it with steps: 2 to 3 stages at one level, titled for the user. They go after the first step and before close-out, reflect, cleanup and the sign-off.",
  source: null,
  steps: [
    {
      ...findVerifySkill,
      // The agent reads only the current step, so the repair for a start without a plan sits on
      // the step that is current then.
      instructions: `${findVerifySkill.instructions} With no stage of your own after this one, the plan is missing: insert 2 to 3 stages, each an outcome titled for the user, the first after this step.`,
    },
    ...closingSteps,
    {
      title: "Confirm done with the user",
      slug: "confirm-done",
      instructions: "Ask the user once whether the goal is met, and tick with their answer.",
      proofLevel: "required",
      proofHint: "the user's answer",
      waitsForUser: true,
    },
  ],
});
