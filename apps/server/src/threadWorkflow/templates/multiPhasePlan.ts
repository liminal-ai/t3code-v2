import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

/**
 * Version 2 re-pins the playbook after its skeleton took the execution playbook's blocking rule;
 * the steps are unchanged. A running instance keeps its copied steps.
 */
export const multiPhasePlan = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "multi-phase-plan",
  version: 2,
  title: "Multi-phase plan",
  description:
    "A plan for work that spans phases or stacked PRs, written as a checklist an owner runs box by box. No implementation.",
  source: {
    playbook: "poteto-mode/playbooks/multi-phase-plan.md",
    commit: "fbe67d73fb87470601988a09f0bb49f7747dba48",
    sha256: "2853685d0795599a43b526678e69436a1fe7f2e0010c5297ebad096acc154413",
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
        "Post the plan path and the check script's output. If the request already gave the go to build, skip the closing steps below with the reason that the execution workflow carries them, close this workflow, and start the execution playbook the plan names; its PRs declare the plan with a `pstack-plan:` line in their bodies. Otherwise the user decides whether to build: ask for the go with `thread_workflow_ask` and stop.",
      proofLevel: "required",
      proofHint: "the go, quoted, or where it came from",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
