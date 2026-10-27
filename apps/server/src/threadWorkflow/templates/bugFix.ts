import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill, mergeThroughGate } from "./shared.ts";

export const bugFix = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "bug-fix",
  version: 1,
  title: "Bug fix",
  description: "A reported defect reproduced, root-caused and fixed with runtime evidence.",
  source: {
    playbook: "poteto-mode/playbooks/bug-fix.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "eba9b2a754f7227ad1c14cd125fae4d4926ba8cacfdf9e36ae7c0f263477a6dd",
  },
  steps: [
    findVerifySkill,
    {
      title: "Bug reproduced on its surface",
      slug: "reproduce-bug",
      instructions:
        "Reproduce the bug yourself through the project's verify skill. Ask the user to reproduce it only after driving that skill as far as it goes, with the specific reason it cannot reach the target. If it will not fire, synthesize the trigger, tighten the conditions or instrument until it does.",
      proofLevel: "required",
      proofHint: "the failing repro command and its output",
      waitsForUser: false,
    },
    {
      title: "Root cause confirmed with runtime evidence",
      slug: "find-root-cause",
      instructions:
        "Binary-search the cause. Seed hypotheses with how over the subsystem and why for regression history, take the split that cuts the most each pass, and rule hypotheses out with runtime evidence and instrumentation, not guesses. Confirm the surviving mechanism before planning the fix.",
      proofLevel: "required",
      proofHint: "the mechanism and the evidence that confirms it",
      waitsForUser: false,
    },
    {
      title: "Fix passes the original repro",
      slug: "fix-and-verify",
      instructions:
        "Plan the fix, with architect first if it crosses a function boundary, and delegate it on the bug-fix role. Ship the smallest change the evidence justifies and revert what a refuted hypothesis motivated. Verify through the project's verify skill that the original repro passes, extending that skill in the same PR when it could not reach the bug. Stage the failing repro before the fix in git history.",
      proofLevel: "required",
      proofHint: "the repro output before and after the fix",
      waitsForUser: false,
    },
    mergeThroughGate(),
    ...closingSteps,
  ],
});
