import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill, mergeThroughGate } from "./shared.ts";

export const refactoring = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "refactoring",
  version: 1,
  title: "Refactoring",
  description: "A behavior-preserving change to structure, held against a pinned contract.",
  source: {
    playbook: "poteto-mode/playbooks/refactoring.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "f3117a93494c141d557102e05a69b95e21c31d5a5c04c8d2fd6334c3fc42ea06",
  },
  steps: [
    findVerifySkill,
    {
      title: "Behavior pinned and target shape named",
      slug: "pin-contract",
      instructions:
        "Learn the contract with how, then pin current behavior with a characterization test, snapshot or equivalence harness; type check and lint are not a pin. Name the structure the code is missing and the target shape, with architect first if it crosses a function boundary. If the cleanup reveals a bug or a missing feature, split it out.",
      proofLevel: "required",
      proofHint: "the pin and the named target shape",
      waitsForUser: false,
    },
    {
      title: "Structure reshaped in green steps",
      slug: "reshape",
      instructions:
        "Subtract first: dead code, one-caller wrappers, redundant validators. Then move in small behavior-preserving steps that keep the pin green, migrating every caller and deleting the old API in the same wave, with no shims. Delegate mechanical edits on the refactoring role, and spot-check renames against strings and prose.",
      proofLevel: "required",
      proofHint: "the commits, each with the pin green",
      waitsForUser: false,
    },
    {
      title: "Behavior proven unchanged",
      slug: "prove-unchanged",
      instructions:
        "Prove the behavior is unchanged on the real artifact: an equivalence diff, a replayed baseline, or a smoke run through the project's verify skill. Revert the change if it lowers reader load nowhere. Rebase into a subtraction commit, the reshape, then follow-on cleanup.",
      proofLevel: "required",
      proofHint: "the equivalence proof and the reader-load delta",
      waitsForUser: false,
    },
    mergeThroughGate(),
    ...closingSteps,
  ],
});
