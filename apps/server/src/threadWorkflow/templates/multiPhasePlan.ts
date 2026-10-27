import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

export const multiPhasePlan = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "multi-phase-plan",
  version: 1,
  title: "Multi-phase plan",
  description:
    "A plan for work that spans phases or stacked PRs, written as a checklist an owner runs box by box. No implementation.",
  source: {
    playbook: "poteto-mode/playbooks/multi-phase-plan.md",
    commit: "03a5c1c4b89683b9fc0bf3001694af1f4bf1c689",
    sha256: "c7fe374a2c1c8dab04f46b592e9a1d9b30a8dc6bfa64f795879ce487d219104d",
  },
  steps: [
    findVerifySkill,
    {
      title: "Open questions settled by prototype",
      slug: "settle-questions",
      instructions:
        "If the change is one or two files with an obvious approach, say so and close this workflow without a plan. Otherwise settle each open question with the Prototype playbook, keeping the branch, SHA and screenshots for Appendix A, and explore in poteto-agent delegates. Ask the user only about a product or preference call no run can settle, with options.",
      proofLevel: "required",
      proofHint: "each question and what settled it",
      waitsForUser: false,
    },
    {
      title: "Plan written and checked",
      slug: "write-plan",
      instructions:
        "Copy the playbook's skeleton into the plan file, under `docs/` in the pstack store unless the operator names a path, and fill every placeholder. Every live block names the project's verify skill. Write under /technical-writing, then /unslop, and run `node ~/.agents/skills/poteto-mode/scripts/check-plan.mjs <plan.md>` until it prints nothing to fix.",
      proofLevel: "required",
      proofHint: "the plan path and the check script's output",
      waitsForUser: false,
    },
    {
      title: "Plan handed back",
      slug: "hand-back",
      instructions:
        "Post the plan path and the check script's output. If the request already gave the go to build, start the execution playbook the plan names; its PRs declare the plan with a `pstack-plan:` line in their bodies. Otherwise the user decides whether to build: put that on the workflow's open questions, or in chat where it has none, and stop.",
      proofLevel: "required",
      proofHint: "the go, quoted, or where it came from",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
