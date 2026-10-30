import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

/**
 * Version 2 re-pins the playbook after it named Autopilot-stack owners beside Autopilot-full ones;
 * the steps are unchanged. A running instance keeps its copied steps.
 */
export const babysit = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "babysit",
  version: 2,
  title: "Babysit",
  description:
    "A PR or a stack driven to merge-ready: conflicts, review threads and CI, one frontier PR at a time.",
  source: {
    playbook: "poteto-mode/playbooks/babysit.md",
    commit: "fbe67d73fb87470601988a09f0bb49f7747dba48",
    sha256: "37e9c5720bc26a8727b8f9b78a6db9029e3f7469fc8c62b62631da7e7b1843c8",
  },
  steps: [
    findVerifySkill,
    {
      title: "Mode declared and forge resolved",
      slug: "declare-mode",
      instructions:
        "Declare the mode before any poll. drive runs the loop to merge-ready (the default). background triages without blocking. threads-only answers review comments and touches nothing else. check is one status pass and a report, which small and docs-only PRs get, with no watcher. Resolve the forge: gh unless Origin resolves the repo. For drive and background, check nothing else is babysitting the stack, then arm watch_pull_request with a fallback heartbeat.",
      proofLevel: "required",
      proofHint: "the mode and the forge",
      waitsForUser: false,
    },
    {
      title: "Frontier PR cleared",
      slug: "clear-frontier",
      instructions:
        "In check mode, report the frontier's status and stop here. In threads-only, triage and answer the review threads and touch nothing else. Otherwise work only the lowest unmerged PR: conflicts, then review threads, then CI, batched into one push wave. Report a conflict and the branch that needs the rebase rather than resolving it, and never change stack topology. Classify CI before one fresh build. Triage Bugbot and Codex per bugbot-triage.md, fixing real findings red-first in the owning PR and checking each fix through the project's verify skill. Trust watch-pr, not a green list.",
      proofLevel: "required",
      proofHint: "watch-pr's status for the frontier PR",
      waitsForUser: false,
    },
    {
      title: "Stopped at the human's line",
      slug: "stop-at-merge-ready",
      instructions:
        "Babysitting never authorizes a merge. Once the forge reports the frontier ready, or it waits on an owner's approval, report where it stands and stop. If the request was to merge, land or ship, route it to the Shipping playbook.",
      proofLevel: "required",
      proofHint: "the final status and what waits on whom",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
