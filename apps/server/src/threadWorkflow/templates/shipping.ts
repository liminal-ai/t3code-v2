import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

/**
 * Version 4 replaces the verdict with the verifier's review and the lead's acceptance, and sends a
 * recheck to the same verifier. A running instance keeps its copied steps.
 */
export const shipping = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "shipping",
  version: 4,
  title: "Shipping",
  description:
    "A green stack verified PR by PR, then the contiguous verified run landed bottom-up through the merge gate.",
  source: {
    playbook: "poteto-mode/playbooks/shipping.md",
    commit: "f963d259b94b05b30c986329bf60bb2f7d75180d",
    sha256: "78365d3d706e583eb0ac1ac777d59bdd352448d29e6dd36ac2420989c45ed656",
  },
  steps: [
    findVerifySkill,
    {
      title: "Each PR reviewed independently and accepted by you",
      slug: "review-and-accept-each-pr",
      instructions:
        "Resolve the forge. One verifier per PR, a delegate_task child on the counterpart of the author's family and never the author, in its own worktree, runs the change parent against head through the project's verify skill (its brief names it and `.agents/merge-brief.md`) and posts `pstack-review: head=<sha> base=<merge-base> by=<model>` with box and issue lines, no pass or fail. You decide: post `pstack-accept:` with `checked:` and a reason for each high or medium issue or failed box you leave unfixed. A recheck after a code change goes to the same verifier's session with t3_thread_send.",
      proofLevel: "required",
      proofHint: "each PR's review and your acceptance",
      waitsForUser: false,
    },
    {
      title: "Accepted run and ceiling found",
      slug: "find-verified-run",
      instructions:
        "Walk up from the lowest unmerged PR and stop at the first without your acceptance at its head; the PRs below are the run. Before trusting an older review, run `verdict-hash.sh` on the saved merge base and review head and on the current pair. It carries only when both succeed and print the same hash.",
      proofLevel: "required",
      proofHint: "the run, its ceiling and the hash checks",
      waitsForUser: false,
    },
    {
      title: "Run landed bottom-up through the gate",
      slug: "land-run",
      instructions:
        "Merge the run's lowest unmerged PR only with `~/.agents/skills/poteto-mode/scripts/merge-gate/merge-gate --repo <owner/name> --pr <n>` (`--method merge` where the repo requires merge commits; `--plan` with `--plan-pr` unless the PR declares its plan), and read the merge brief it prints. After each merge, retarget the next PR to trunk, move its patch onto the merge result, push with `--force-with-lease`, let the diff rule decide whether its review carries, and gate it once its checks pass; touch nothing else in the stack. Watch the bottom PR with a fallback heartbeat, re-arm on each merge, and stop at the ceiling.",
      proofLevel: "required",
      proofHint: "each merge SHA, read back from the forge",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
