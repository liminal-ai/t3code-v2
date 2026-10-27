import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

/**
 * Derived from FORK.md's "Sync from upstream" in this repo. It has no `source` because freshness
 * reads only `~/.agents/skills`; change this template in the PR that changes that section.
 */
export const forkSync = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "fork-sync",
  version: 1,
  title: "Fork sync",
  description:
    "The T3 fork synced to an upstream tag on a branch, verified, and merged, stopping before cutover.",
  source: null,
  steps: [
    findVerifySkill,
    {
      title: "Tag picked and upstream's changes read",
      slug: "pick-tag",
      instructions:
        'Fetch upstream with tags. Take the newest stable tag, or the newest nightly only for something no stable tag carries. List upstream\'s commits from the "Last synced" tag to the new one on the files we changed (`git log $OLD..$NEW -- $(git diff --name-only $OLD main)`), and read each one before merging.',
      proofLevel: "required",
      proofHint: "the tag and the commits read",
      waitsForUser: false,
    },
    {
      title: "Merged on a sync branch",
      slug: "merge-upstream",
      instructions:
        "Run `git switch -c sync/upstream-<tag> main` and `git merge --no-ff <tag>`. Resolve each conflict so upstream's new behavior and ours both survive. Where upstream now does what one of our changes did, take upstream's version and delete ours.",
      proofLevel: "required",
      proofHint: "the merge commit and each conflict resolved",
      waitsForUser: false,
    },
    {
      title: "Our code, the seams and a release verified",
      slug: "verify-sync",
      instructions:
        "Run the provider-cursor tests and FORK.md's Seams to re-check. Compare `git diff $NEW <merge>` with `git diff $OLD main`: the only differences are your conflict resolutions. Build a release, run it as a throwaway T3, never against prod, and drive it through the project's verify skill. Do not re-test upstream features.",
      proofLevel: "required",
      proofHint: "the test results, the diff comparison and the release check",
      waitsForUser: false,
    },
    {
      title: "Sync merged, cutover not started",
      slug: "merge-sync",
      instructions:
        'Open the PR against main with "Last synced" in FORK.md set to the new tag. Bot reviews do not cover a sync, so a verifier from the other model family drives it through the project\'s verify skill and posts `pstack-verdict:`. Merge with `~/.agents/skills/poteto-mode/scripts/merge-gate/merge-gate --repo liminal-ai/t3code-v2 --pr <n> --method merge`. Then stop: the cutover is a separate step Lee runs or approves.',
      proofLevel: "required",
      proofHint: "the PR URL, the verdict line and the merge SHA",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
