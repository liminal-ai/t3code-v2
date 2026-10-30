import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

/**
 * Version 3 gives a wording-only change one counterpart verifier too. A running instance keeps its
 * copied steps.
 */
export const autopilotFull = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "autopilot-full",
  version: 3,
  title: "Autopilot-full",
  description:
    "A queue of independent PRs run to merged with full autonomy, one owner per PR and a swarm verdict before each merge.",
  source: {
    playbook: "poteto-mode/playbooks/autopilot-full.md",
    commit: "f963d259b94b05b30c986329bf60bb2f7d75180d",
    sha256: "53c8f4cd8c1fb916e4c7e16be7b24314b6cae259c47fe88142ab2f25bbf06aa8",
  },
  steps: [
    findVerifySkill,
    {
      title: "One owner per PR, off trunk",
      slug: "spawn-owners",
      instructions:
        "The grant covers only the queue's items; items the operator names as theirs stop at merge-ready. Name the run, resolve the forge, and spawn one owner per PR in parallel off trunk, never stacked, on the cloud workers line or locally in its own worktree. Each keeps a decisions.tsv trail in the pstack store and reports every head as a `CODE-READY <sha>` PR comment.",
      proofLevel: "required",
      proofHint: "each owner's taskId and branch",
      waitsForUser: false,
    },
    {
      title: "Each PR swarm-verified at code-ready",
      slug: "swarm-verify",
      instructions:
        "Swarm-verify once at each code-ready head, every lane driving the change through the project's verify skill. A rebase, minor fix or wording-only change gets one counterpart verifier at the new head. Block a PR only for a problem you can show at its head, and send that to the owner; park the rest as follow-ups. Countersign anything that loosens a gate.",
      proofLevel: "required",
      proofHint: "each PR's verdict at its head",
      waitsForUser: false,
    },
    {
      title: "Verified PRs merged by their owners",
      slug: "owners-merge",
      instructions:
        "An owner merges only what you verified, rebased and green on the trunk it lands on, through the merge gate. Keep the hourly audit wake until no delegated work is left. On the operator's stop, every owner gets a zero-writes order and keeps its brief.",
      proofLevel: "required",
      proofHint: "each merge SHA",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
