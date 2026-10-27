import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill, mergeThroughGate } from "./shared.ts";

export const hillclimb = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "hillclimb",
  version: 1,
  title: "Hillclimb",
  description:
    "One metric improved against a target in a loop: one change, one measurement, keep or revert.",
  source: {
    playbook: "poteto-mode/playbooks/hillclimb.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "d994445ca602d5a67b0662398f9d2677ebaa09a26ddd4e929a81565442bfa2db",
  },
  steps: [
    findVerifySkill,
    {
      title: "Metric, case and stop predicate fixed",
      slug: "fix-metric",
      instructions:
        "Ground the workload with how and pick a case that reproduces the complaint; with no such case, fix the repro first. Fix one metric, the direction that counts as better, and a stop predicate that pairs a target with a floor on attempts. Use the user's numbers when given.",
      proofLevel: "required",
      proofHint: "the metric, the case and the predicate",
      waitsForUser: false,
    },
    {
      title: "Harness proven sensitive and frozen",
      slug: "freeze-harness",
      instructions:
        "Build the measurement harness, show it separates contrasting workloads, vet it with benchmark-checklist, and freeze it as one command that prints the median of N, its error count and the work done. Record the baseline and a green regression gate. Open `decision.tsv` via show-me-your-work, outside the tree.",
      proofLevel: "required",
      proofHint: "the harness command and the baseline",
      waitsForUser: false,
    },
    {
      title: "Hill climbed to the predicate",
      slug: "climb",
      instructions:
        "One hypothesis per iteration, each naming a mechanism. Delegate the change on the hillclimb role, measure before and after with the frozen harness and run the gate. Keep only a move past noise with the gate green, else revert in full. One commit per kept fix, staged by file, and a log row either way. Push past plateaus. Stop at the predicate or when only marginal ideas remain, never relaxing it.",
      proofLevel: "required",
      proofHint: "baseline to final, kept vs reverted, the decision.tsv path",
      waitsForUser: false,
    },
    mergeThroughGate("Stack the accepted commits in the order they landed."),
    ...closingSteps,
  ],
});
