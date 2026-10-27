import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill, mergeThroughGate } from "./shared.ts";

export const visualParity = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "visual-parity",
  version: 1,
  title: "Visual parity",
  description:
    "Pixel-exact UI equivalence, matching two implementations or migrating a styling system, proven by image diff.",
  source: {
    playbook: "poteto-mode/playbooks/visual-parity.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "f174b278fe15119471545fe80babfbd7eecb66ee4a622eb64f8e9303f8318cfb",
  },
  steps: [
    findVerifySkill,
    {
      title: "Baseline harness in place",
      slug: "baseline-harness",
      instructions:
        "Before any migration, build a visual regression harness that screenshots the current component across its states, plus the target when matching two implementations. Hold the anti-shortcut clauses: no harness edits, no baseline tampering, no restructuring to make a diff pass. If the baseline looks wrong, stop and ask the user before touching it.",
      proofLevel: "required",
      proofHint: "the harness location and the baseline set",
      waitsForUser: false,
    },
    {
      title: "Components migrated to a zero diff",
      slug: "migrate-components",
      instructions:
        "Migrate shared primitives first, then one component at a time, one owner per component in its own worktree. Verify each against its baseline by image diff through the project's verify skill. A nonzero diff is a fail: investigate the pixel delta and loop until it is zero.",
      proofLevel: "required",
      proofHint: "each component's diff result",
      waitsForUser: false,
    },
    mergeThroughGate("Open one PR per component or per safe batch."),
    ...closingSteps,
  ],
});
