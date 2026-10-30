import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

/**
 * Version 2 re-pins the playbook after its merge-gate audit flags changed; the steps are unchanged.
 * A running instance keeps its copied steps.
 */
export const shipping = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "shipping",
  version: 2,
  title: "Shipping",
  description:
    "A green stack verified PR by PR, then the contiguous verified run landed bottom-up through the merge gate.",
  source: {
    playbook: "poteto-mode/playbooks/shipping.md",
    commit: "c545c9c7abfbdbcab8898d9c63df60c3c570939e",
    sha256: "9818abe4adf91a08e195ba3b4b8d84b9db934c87f772d84bf172d36fb042b5e0",
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
        "Merge the run's lowest unmerged PR only with `~/.agents/skills/poteto-mode/scripts/merge-gate/merge-gate --repo <owner/name> --pr <n>` (`--method merge` where the repo requires merge commits; `--plan` with `--plan-pr` unless the PR declares its plan), and read the merge brief it prints. After each merge, retarget the next PR to trunk, move its patch onto the merge result, push with `--force-with-lease`, let the diff rule decide whether its verdict carries, and gate it once its checks pass; touch nothing else in the stack. Watch the bottom PR with a fallback heartbeat, re-arm on each merge, and stop at the ceiling.",
      proofLevel: "required",
      proofHint: "each merge SHA, read back from the forge",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
