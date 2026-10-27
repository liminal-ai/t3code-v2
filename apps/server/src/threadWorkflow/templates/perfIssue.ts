import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill, mergeThroughGate } from "./shared.ts";

export const perfIssue = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "perf-issue",
  version: 1,
  title: "Perf issue",
  description: "A measured slowness traced and improved against a baseline, as a one-off fix.",
  source: {
    playbook: "poteto-mode/playbooks/perf-issue.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "ff30e26e64c90ab74efc1fbe95cce2ab0a0280ec39b681beb38e3e3d61799b26",
  },
  steps: [
    findVerifySkill,
    {
      title: "Baseline measured and vetted",
      slug: "measure-baseline",
      instructions:
        "Capture a baseline trace through the project's verify skill and vet it with benchmark-checklist. Ground hypotheses with how, and never claim a ceiling without running it. Order ideas by the performance mantras, cheapest first, and stop at the first one that meets the target.",
      proofLevel: "required",
      proofHint: "the baseline number and the trace path",
      waitsForUser: false,
    },
    {
      title: "Fix measured against the baseline",
      slug: "fix-and-measure",
      instructions:
        "Plan the fix from the trace, with architect first if it crosses a function boundary, and delegate it on the perf-issue role. Review the diff, capture a post-fix trace through the project's verify skill, and compare the parsed artifacts, verifying each attempt before the next. Inconclusive or wrong-surface is not a pass. Cite the measurement in the PR.",
      proofLevel: "required",
      proofHint: "baseline, post-fix number, delta and artifact path",
      waitsForUser: false,
    },
    mergeThroughGate(),
    ...closingSteps,
  ],
});
