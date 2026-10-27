import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

export const shipping = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "shipping",
  version: 1,
  title: "Shipping",
  description:
    "A green stack verified PR by PR, then the contiguous verified run landed bottom-up through the merge gate.",
  source: {
    playbook: "poteto-mode/playbooks/shipping.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "bf5b6afcd8a2263f47d5f7288a99cda2c687a62ae90146335f72dc54a6a1eebe",
  },
  steps: [
    findVerifySkill,
    {
      title: "Each PR verified independently",
      slug: "verify-each-pr",
      instructions:
        "Resolve the forge. One verifier per PR, a delegate_task child on the counterpart of the code author's family and never the author, works in its own worktree, runs the change parent against head through the project's verify skill (its brief names it), and posts `pstack-verdict: <PASS|PASS+NOTES|FAIL> head=<sha> base=<merge-base> by=<model>` on the PR.",
      proofLevel: "required",
      proofHint: "each PR's verdict line",
      waitsForUser: false,
    },
    {
      title: "Verified run and ceiling found",
      slug: "find-verified-run",
      instructions:
        "Walk up from the lowest unmerged PR and stop at the first without PASS or PASS+NOTES; the PRs below are the run. Before trusting an older verdict, run `verdict-hash.sh` on the saved merge base and verdict head and on the current pair. It carries only when both succeed and print the same hash.",
      proofLevel: "required",
      proofHint: "the run, its ceiling and the hash checks",
      waitsForUser: false,
    },
    {
      title: "Run landed bottom-up through the gate",
      slug: "land-run",
      instructions:
        "Merge the run's lowest unmerged PR only with `~/.agents/skills/poteto-mode/scripts/merge-gate/merge-gate --repo <owner/name> --pr <n>`, adding `--method merge` where the repo requires merge commits and `--plan` with `--plan-pr` when a plan covers it. Leave the stack alone while it lands. Watch the bottom PR with a fallback heartbeat, re-arm on each merge, and stop at the ceiling.",
      proofLevel: "required",
      proofHint: "each merge SHA, read back from the forge",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
