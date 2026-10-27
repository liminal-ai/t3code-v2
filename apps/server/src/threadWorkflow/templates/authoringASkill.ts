import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill, mergeThroughGate } from "./shared.ts";

export const authoringASkill = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "authoring-a-skill",
  version: 1,
  title: "Authoring a skill",
  description: "Writing or editing a SKILL.md, validated and delivered as a PR.",
  source: {
    playbook: "poteto-mode/playbooks/authoring-a-skill.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "f6a13a445c360b48d6cd72780ac01955f45b82826476efe0e67c7559329407aa",
  },
  steps: [
    findVerifySkill,
    {
      title: "Skill written",
      slug: "write-skill",
      instructions:
        "Write or edit the skill with the create-skill skill. Keep only prose that changes a decision, tell it to do the thing, delegate to other skills by path, and point at structural sources instead of restating them. When in doubt, delete. A pstack skill changes in `liminal-ai/pstack-lim` on `lim`, never only in the installed copy.",
      proofLevel: "required",
      proofHint: "the skill's path and its key design decisions",
      waitsForUser: false,
    },
    {
      title: "Skill validated",
      slug: "validate-skill",
      instructions:
        "Check that the frontmatter has `name` and `description`, every referenced file exists, and every cross-skill link resolves. Add test cases when the change is structural, and skip them when it is subjective.",
      proofLevel: "required",
      proofHint: "the validation notes",
      waitsForUser: false,
    },
    mergeThroughGate("Once a pstack skill merges, rerun the per-user install."),
    ...closingSteps,
  ],
});
