import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill, mergeThroughGate } from "./shared.ts";

/** Replaces single-task, which was derived from this playbook. */
export const feature = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "feature",
  version: 1,
  title: "Feature",
  description: "New or changed behavior built from a named data shape and delivered as one PR.",
  source: {
    playbook: "poteto-mode/playbooks/feature.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "470fdd15ca8a03cc4dd42501b1cd08cad9394d0cf462bbc6ee695898d6a58632",
  },
  steps: [
    findVerifySkill,
    {
      title: "Design grounded and data shape named",
      slug: "design-data-shape",
      instructions:
        "Run how over the affected subsystem, then architect for parallel design exploration, and name the data shape and its organizing structure. Write the throughput checkpoint: blocking first steps, independent workstreams, shared mutable state, smallest safe decomposition, keeping each with n/a and a reason when it does not apply. If the design decides what the data is or who can do what, put that question on the workflow's open questions, or in chat where it has none, and go on with work that does not depend on it.",
      proofLevel: "required",
      proofHint: "the named shape and the checkpoint",
      waitsForUser: false,
    },
    {
      title: "Built by a delegate",
      slug: "delegate-build",
      instructions:
        "Delegate the code to a subagent on the feature role with file paths, the named data shape and success criteria, or through arena when the code admits several valid shapes. This step has no skip. Review the diff yourself.",
      proofLevel: "required",
      proofHint: "the delegate's taskId and the commit SHA",
      waitsForUser: false,
    },
    {
      title: "Verified where its users meet it",
      slug: "verify-through-skill",
      instructions:
        "Drive the change through the project's verify skill on the surface its users meet. Inconclusive or wrong-surface is not a pass. A change a user can reach updates the project's verify skill in the same PR. Rebase into small ordered commits, and run interrogate first if the design is contested.",
      proofLevel: "required",
      proofHint: "the verify run's result or screenshot path",
      waitsForUser: false,
    },
    mergeThroughGate(),
    ...closingSteps,
  ],
});
