# Merge brief: liminal-ai/t3code-v2

- Gate: `~/.agents/skills/poteto-mode/scripts/merge-gate/merge-gate --repo liminal-ai/t3code-v2 --pr <n> --method merge`. Merge commits only. Never squash, rebase or run `gh pr merge` (FORK.md, "Branches and merges").
- The gate also needs Codex's review of the PR's current head and no open review thread. Codex reviews when a PR opens or leaves draft; after a push, comment `@codex review` and wait for its summary to name the new head. On the 3766 sync it caught a regression three verifier rounds had not.
- A verdict drives the change through `.agents/skills/verify-t3code/` on a dev server built from the PR's head, by path:
  - `apps/server/src/threadWorkflow/`, `apps/server/src/mcp/toolkits/threadWorkflow/` or `apps/web/src/threadWorkflow/`: `features/workflow-tab.md`, with its outcome check.
  - `packages/provider-cursor/`: `features/agent-turn.md` with a Cursor instance picked.
  - `apps/web/src/groupChat/`, `apps/server/src/groupChat/`, `routes/group-chat*` or `mainAppLocation.ts`: `features/group-chat.md`.
  - Any other `apps/web/` or `apps/server/` change: the feature file for each flow it touches, and `features/agent-turn.md` at least.
  - Docs only (`docs/`, `*.md`): no drive. Read the changed text against the code it describes.
- Before the push: `vp run check:changed`. Run no repo-wide checks. An upstream sync changes nearly every package, so it typechecks each package the fork touches and lints the files that differ from the upstream tag instead.
- A change to a file in FORK.md "Seams to re-check" runs the tests listed there. Run the provider-cursor tests from `packages/provider-cursor`, because four fail from the root.
- CI does not run the live drive, or an upstream sync's throwaway-release check (FORK.md "Sync from upstream" step 4). Before a cutover question, the release runs one real turn on Cursor, Claude and Codex, per the verify skill's "Release check".
- `AGENTS.md` or `CLAUDE.md` text: Lee approves the exact text, and the gate checks the approval comment.
- An upstream sync goes to a published tag and updates "Last synced" in FORK.md in the same PR.
- A merge changes nothing in prod. Only Lee runs or approves a cutover (FORK.md "Cut over").
