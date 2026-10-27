import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, RUN_FOLDER } from "./shared.ts";

export const worktreeCleanup = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "worktree-cleanup",
  version: 1,
  title: "Worktree cleanup",
  description:
    "Local disk reclaimed by pruning merged or abandoned git worktrees, stale simulators and caches.",
  source: {
    playbook: "poteto-mode/playbooks/worktree-cleanup.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "5eea31f8691f1586e2734547072eb5f7b406d6b550ff55ee910c405682b59687",
  },
  steps: [
    {
      title: "Disk snapshot and worktree audit taken",
      slug: "audit-worktrees",
      instructions: `Record \`df -h /\`, then run poteto-mode's \`scripts/worktree-audit.sh [-b <pr-base-ref>] [--threads <tsv>] [repo-path]\`, passing \`-b origin/<branch>\` when PRs target another branch. It reads paths from \`git worktree list\`; never hand-type one. ${RUN_FOLDER}`,
      proofLevel: "required",
      proofHint: "df -h / and the audit's buckets",
      waitsForUser: false,
    },
    {
      title: "In-use worktrees ruled out",
      slug: "rule-out-in-use",
      instructions:
        "The audit's bucket is advice. Cross-check every candidate against the pinned and active threads in the T3 sidebar, and ask the user for that set only when the sidebar cannot show it. Fan subagents out to read the thread of each verify-recent-chat row or doubtful one. The pinned set wins.",
      proofLevel: "required",
      proofHint: "the candidates held back and why",
      waitsForUser: false,
    },
    {
      title: "Confirmed set pruned",
      slug: "prune-worktrees",
      instructions:
        "When a candidate has `wip:N` uncommitted edits, show its diff: the user decides whether to drop it, before anything is removed. Name the `scratch:N` files. Remove the rest with `git worktree remove --force <path>`, `rm -rf` a dir that survives on ignored build artifacts, then `git worktree prune`. With no wip candidate, skip the wait.",
      proofLevel: "required",
      proofHint: "the worktrees pruned and the user's answer on any wip",
      waitsForUser: true,
    },
    {
      title: "Caches reclaimed and space measured",
      slug: "reclaim-caches",
      instructions:
        "When more space is needed, prune caches: npm, uv, pnpm, bun and Docker build cache, then old Playwright and Electron builds. Confirm with `df -h /` and list the worktrees again.",
      proofLevel: "required",
      proofHint: "df -h / before and after",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
