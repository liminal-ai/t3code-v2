import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

/**
 * Version 4 has you accept each PR at its head after the swarm's review, sends a recheck to the
 * same verifier, and steers a new order to a running owner. A running instance keeps its copied steps.
 */
export const autopilotFull = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "autopilot-full",
  version: 4,
  title: "Autopilot-full",
  description:
    "A queue of independent PRs run to merged with full autonomy, one owner per PR, and a swarm review and your acceptance before each merge.",
  source: {
    playbook: "poteto-mode/playbooks/autopilot-full.md",
    commit: "cc33ab5cbc39ab9c380ad0f2c2ade1ff0630b05c",
    sha256: "f895b656450d5fee953e51eef5ef7ded6544abf27794136444dfb95b580cae89",
  },
  steps: [
    findVerifySkill,
    {
      title: "One owner per PR, off trunk",
      slug: "spawn-owners",
      instructions:
        "The grant covers only the queue's items; items the operator names as theirs stop at merge-ready. Name the run, resolve the forge, and spawn one owner per PR in parallel off trunk, never stacked, on the cloud workers line or locally in its own worktree. Each keeps a decisions.tsv trail in the pstack store and reports every head as a `CODE-READY <sha>` PR comment. Send a new order to a running owner with `steer`, because `queue` waits for its current turn to finish.",
      proofLevel: "required",
      proofHint: "each owner's taskId and branch",
      waitsForUser: false,
    },
    {
      title: "Each PR swarm-verified at code-ready",
      slug: "swarm-verify",
      instructions:
        "Swarm-verify once at each code-ready head, every lane driving the change through the project's verify skill. A rebase, minor fix or wording-only change gets one counterpart verifier at the new head. Block a PR only for a problem you can show at its head, and send that to the owner; park the rest as follow-ups. Countersign anything that loosens a gate. Accept each PR at its head per Shipping step 1, and send a recheck after a code change to the same verifier's session.",
      proofLevel: "required",
      proofHint: "each PR's review and your acceptance at its head",
      waitsForUser: false,
    },
    {
      title: "Verified PRs merged by their owners",
      slug: "owners-merge",
      instructions:
        "An owner merges only what you accepted, rebased and green on the trunk it lands on, through the merge gate. Keep the hourly audit wake until no delegated work is left. On the operator's stop, every owner gets a zero-writes order and keeps its brief.",
      proofLevel: "required",
      proofHint: "each merge SHA",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
