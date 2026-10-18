# Fork maintenance: liminal-ai/t3code-v2

This repository is Lee's fork of `pingdotgg/t3code`. It builds the T3 Code server that runs as v2 prod on this machine. Read this file before you merge from upstream, before you push, when you set up a PR, and before you merge one.

Last synced: upstream tag `v0.1.1-nightly.20261017.3238` (`70d60e03a7`), merged by PR #4 as merge commit `ed9ee511ec`. Update this line in the PR that lands the next sync.

## What the fork adds

Everything else is upstream. `git diff --stat v0.1.1-nightly.20261017.3238 main` lists every file that differs, and that list should match this section.

- **Cursor Cloud** (PR #2, merged as `40b0206f85`). A Cursor provider instance with **Runs on** set to **Cursor Cloud** runs each thread on a Cursor VM that clones the project's GitHub repository. Prod has one such instance, `cursor-cloud`, configured in settings rather than code. The code is in `packages/provider-cursor/src/`. `server/cloud.ts` is ours. `server/adapter.ts`, `server/CursorAgentSdk.ts`, `server/skills.ts`, `server/driver.ts` and `settings.ts` are upstream files we changed. The fixes for PR #2's review threads (PR #6) added the cap on inline attachments and the skills rule. The user guide's Cursor Cloud section is in `docs/user/cursor.md`.
- **The MCP placement test** (commit `fc6ad78149`, in `packages/provider-cursor/src/server/adapter.cloud.test.ts`). A local Cursor run gets T3's MCP server on `Agent.create` and `Agent.resume`, never on a send, because a send-level `mcpServers` replaces the servers the agent opened with. A cloud run never gets it, because the VM cannot reach this machine. Upstream #15875 moved the server off sends. This test is the one fact the 3238 merge was safe because of.
- **Thread workflows** (the `feature/workflow-module` stack, not merged yet). A thread can carry a checklist workflow. The agent works through it with the `thread_workflow_*` MCP tools, the user drives it over the `threadWorkflow.*` RPC methods, and an open workflow refuses settle, archive and delete. `threadWorkflowsEnabled` in server settings turns it on, and it is off by default. Turning it off stops new workflows, but an open one keeps blocking. The bypass for that is `threadWorkflowEnforcementDisabled` in server settings, or `T3CODE_THREAD_WORKFLOW_ENFORCEMENT=off` in the server's environment when settings cannot be edited. Either one stops every workflow blocking, with no rebuild. The module never stops a turn, traps a thread, or stops the server starting. A corrupt log, an unreadable store, or a fault in a hook gives no turn note and no blocker, and logs why. The code is ours in `apps/server/src/threadWorkflow/`, `apps/server/src/mcp/toolkits/threadWorkflow/`, `apps/server/src/orchestration-v2/ThreadHooks.ts` and `packages/contracts/src/threadWorkflow.ts`. The upstream files we changed are `apps/server/src/orchestration-v2/Orchestrator.ts`, `ProviderSessionManager.ts`, `ProviderTurnStartService.ts`, `ThreadManagementService.ts` and `ThreadSettlementService.ts` (all in `orchestration-v2/`), `apps/server/src/project/ProjectService.ts`, `apps/server/src/project/http.ts`, `apps/server/src/server.ts`, `apps/server/src/ws.ts`, `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/observability/RpcInstrumentation.ts`, `apps/server/src/mcp/McpHttpServer.ts`, `apps/server/src/mcp/McpInvocationContext.ts`, `apps/server/src/mcp/toolkits/project/handlers.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/clientRpcPermissions.ts`, `packages/contracts/src/index.ts`, `packages/shared/src/t3McpToolPresentation.ts`, `packages/client-runtime/src/t3ToolSummary.ts` and `docs/internals/overview.md`. The upstream tests we changed are `ProviderTurnStartService.test.ts`, `ThreadSettlementService.test.ts` and `runtimeLayer.test.ts` in `orchestration-v2/`, and `apps/server/src/mcp/toolkits/worktree/registration.test.ts`.
- **This file.**

## Branches and merges

- `main` is the upstream nightly we last synced plus the fork's commits. Every change reaches `main` through a PR.
- Work goes on a short-lived branch: `fix/...`, `feature/...`, `sync/upstream-nightly-<n>`. T3 creates `t3/...` branches for its own worktrees. Leave branches that another thread owns alone.
- Merge every PR with a merge commit: `gh pr merge <n> --merge`. Never squash and never rebase `main`. A squash flattens upstream's history, so the next sync conflicts on every file upstream touched since. GitHub still allows squash and rebase on this repository, so nothing stops a wrong merge button but this rule.
- The fork's `origin` carries one old nightly tag, `v0.0.46-nightly.20261011.2980`. Upstream's tags come from `git fetch upstream --tags`. Without them, `git describe` names a build of today's `main` after that old tag.
- `gh` resolves this repository to `liminal-ai/t3code-v2` through `remote.origin.gh-resolved` in the shared git config. Without that line, `gh` picks the `upstream` remote and a bare `gh pr create` opens the PR on `pingdotgg/t3code`. If `gh repo view --json nameWithOwner` ever prints `pingdotgg/t3code`, run `gh repo set-default liminal-ai/t3code-v2`.

## Before you push, open a PR, or merge

1. Do not change any `AGENTS.md` or `CLAUDE.md`, including this repository's, until Lee approves the exact text.
2. Run `gh repo view --json nameWithOwner` and check that it prints `liminal-ai/t3code-v2`.
3. If the change touches a file in [Seams to re-check](#seams-to-re-check), run the tests listed there.
4. Follow upstream's `AGENTS.md` for everything else: conventional commit titles, focused tests, no repo-wide checks.
5. Get an independent verdict from a model family other than the author's before you merge. The pstack Shipping playbook covers how.
6. Merge with `--merge`. A merge changes nothing in prod until a cutover, and only Lee runs or approves a cutover.

## Sync from upstream

Sync to a published nightly tag, not to upstream `main`. A nightly is a build upstream shipped. `main` carries unreleased work.

1. Fetch and pick the tag:

   ```bash
   git fetch upstream --tags
   git tag -l 'v*-nightly.*' --sort=-creatordate | head -5
   ```

2. List what upstream changed in the files we changed. Read each of those commits before you merge.

   ```bash
   OLD=v0.1.1-nightly.20261017.3238   # the "Last synced" tag above
   NEW=<new tag>
   git log --oneline $OLD..$NEW -- $(git diff --name-only $OLD main)
   ```

3. Merge on a branch:

   ```bash
   git switch -c sync/upstream-nightly-<n> main
   git merge --no-ff $NEW
   ```

   Resolve each conflict so that upstream's new behavior and ours both survive. If upstream now does what one of our changes did, take upstream's version and delete ours.

4. Verify three things. Upstream owns testing upstream, so do not re-test upstream features.
   - Our code: the provider-cursor tests, with the commands in [Seams to re-check](#seams-to-re-check).
   - The seams: the tests in [Seams to re-check](#seams-to-re-check), and the content check that the merged tree is upstream plus our diff and nothing else. Compare `git diff $NEW <merge>` with `git diff $OLD main`. The only differences should be the conflict resolutions you made.
   - The deployment: build a release (see [Build a release](#build-a-release)) and run it as a throwaway T3, never against prod. See [Test live without touching prod](#test-live-without-touching-prod).
5. Open the PR against `main`. Set "Last synced" in this file to the new tag in the same PR.
6. Have a reviewer from the other model family verify it, then merge with `--merge`. If the merge commit carries a test that the next commit fixes, that is fine. `main`'s first-parent history stays green because the PR lands as a merge commit.
7. Stop. The cutover is a separate step that Lee runs or approves.

Bot reviews do not cover a sync. Bugbot refused PR #4 at 42,105 lines, and Codex reviews a PR once, not after each push.

## Build a release

`~/lim-v2/bin/t3-v2-deploy <ref>` builds `<ref>` from the main checkout `~/lim-v2/code/t3code-v2` into the same linux-x64 `t3` archive upstream ships. It names the release `t3-<nightly>-lim.<sha>-linux-x64` from `git describe --tags --match 'v*-nightly.*'`, so run `git fetch upstream --tags` in that checkout first. It unpacks the release into `~/lim-v2/service/t3code/prod/releases/` and smoke-tests it on port 13995.

The script never switches prod. It ends by printing the `t3-v2-cutover` command for the new release, with its sha256.

## Cut over

Lee runs or approves every cutover.

1. Run `~/lim-v2/bin/t3-v2-cutover <release-name> <sha256-of-t3>`. The restart ends every T3 thread on prod, including the one that starts it. So run it from a terminal, or from a T3 thread as a detached `systemd-run --user` job that retries while runs are active. `~/lim-v2/notes/t3-v2-cutover/waiter-3238.sh` is the one used for 3238.
2. The script refuses while any v2 run is active. It backs up `statev2.sqlite` into `prod/data/backups/`, switches `prod/current`, restarts `t3code-v2-prod`, and checks that the new binary answers 200 on 13987. If the check fails, it switches back once.
3. After the switch, whether the check passed or failed, it starts `t3-v2-triage`, a headless Claude Code agent outside T3. The agent writes `report.md` in `~/lim-v2/notes/t3-v2-cutover/<time>-<release>/`.
4. Read the report. Reload every open T3 browser tab. A tab keeps the web client it loaded before the restart, and an old client can reject values the new server sends. The report ends with that reminder.
5. Keep the backup. A release can rewrite data on first start. 3238 compacted 54,269 events, so its backup is the only uncompacted copy.

To roll back, point `prod/current` at the previous release and restart the unit. `facts.env` in the run folder names the previous release. A rollback runs the old binary on data the new one may have migrated or compacted. Nobody has tested that for 3238.

## Test live without touching prod

Run a throwaway T3 from a built release on a free port, with its own base directory. Take its data from a WAL-safe snapshot and follow every step of the safety list in `~/lim-v2/notes/cursor-cloud-evidence/verification-20261017-sync3238-r2/safety-audit.md`. That list says which files to leave out, the SQL that stops copied threads from waking, and the settings to use. Read the live ports with `ss -H -ltnp` first. 13987 is v2 prod, 13977 is the older `~/lim` T3, and 13995 is the deploy script's smoke test.

## Seams to re-check

After every upstream merge, list the upstream commits that touched the upstream files we changed. Read each one against the tables below.

```bash
OLD=v0.1.1-nightly.20261017.3238   # the "Last synced" tag
NEW=<new tag>
git log --oneline $OLD..$NEW -- $(git diff --diff-filter=M --name-only $OLD main)
git diff --diff-filter=A --name-only $OLD main | xargs -r git log --oneline $OLD..$NEW --   # upstream created a file we own
```

Then run the tests that pin the seams. Run the provider-cursor tests from the package directory. From the repository root, four `CursorSdk` tests fail because their subprocess cannot resolve `effect`.

```bash
(cd packages/provider-cursor && vp test run --config ../../vite.config.ts --dir . src/server/)
vp test run apps/server/src/provider/ProviderInstanceRegistry.test.ts \
	apps/web/src/components/settings/ProviderSettingsForm.test.ts
```

### Upstream behavior we depend on

Each row is something upstream could change without a merge conflict. The tests named in the last column fail when it does. A row with no test needs the hand check it names.

| We depend on                                                                                                                                                          | Where                                                                                                             | If upstream changes it                                                                                                                                            | Test that catches it                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T3's MCP server goes on `Agent.create` and `Agent.resume`, never on a send. A send-level `mcpServers` replaces the servers the agent opened with.                     | `adapter.ts` `makeCursorAgentOptions` and the send options in `startTurn`                                         | Local threads lose T3 tools, or a cloud VM gets an endpoint it cannot reach.                                                                                      | `adapter.cloud.test.ts` "keeps a local instance on this machine's tools, paths and checkpoints" and "runs a turn on a cloud VM without local tools, paths or checkpoints"                                               |
| The first-prompt wrapper `<t3_code_orchestration_instructions>` appears only when `runOrdinal === 1 && hasT3Mcp`. Cloud passes `hasT3Mcp: false`.                     | `packages/provider-core/src/server/orchestrationInstructions.ts` `t3OrchestrationPromptForFirstRun`               | A cloud VM is told to call T3 tools it cannot reach.                                                                                                              | the same two tests                                                                                                                                                                                                      |
| `providerThread.firstRunOrdinal` stays `null` until the first turn finalizes. The cloud environment note goes out only while it is `null`, which is the first turn.   | `adapter.ts` `resolveUserMessage`                                                                                 | The note never goes out, or it repeats every turn.                                                                                                                | "runs a turn on a cloud VM..." (first turn has the note) and "after a T3 restart: sends a message when the cut run had no cloud run" (a later turn does not)                                                            |
| `nativeConversationHeadRef` is unused by upstream's Cursor adapter. We store the cloud run id there to follow a run across a T3 restart.                              | `adapter.ts` attach-or-send block in `startTurn`                                                                  | A restart sends "continue" into a cloud run that never stopped, or attaches to the wrong run.                                                                     | "after a T3 restart: follows the cloud run T3 cut"                                                                                                                                                                      |
| `ensureThread` opens with `create` and the first turn opens with `resume`. Only `resume` recreates a cloud agent Cursor has no record of.                             | `adapter.ts` `openAgent` callers, `CursorAgentSdk.ts` `open`                                                      | A cloud thread whose first turn never started fails instead of recreating its agent.                                                                              | `CursorAgentSdk.test.ts` "starts a cloud agent Cursor has no record of under its recorded id"                                                                                                                           |
| `@cursor/sdk` reports a missing cloud agent as `status === 404`, and `Agent.getRun` and `Agent.cancelRun` accept `{ runtime: "cloud", agentId, apiKey }`.             | `CursorAgentSdk.ts` `isCloudNotFound`, `attach`, `cancelRun`                                                      | Resume, attach, or cancel misses the cloud run. Cloud cancel must stay on `Agent.cancelRun`, because `run.cancel()` reports cancelled while the VM keeps running. | `CursorAgentSdk.test.ts` describe "CursorAgentSdkRunner cloud"                                                                                                                                                          |
| `providerMessageTextWithAttachmentPaths` writes nothing for an attachment whose path resolves to `null`. Cloud resolves every path to `null` and writes its own note. | `packages/provider-core/src/server/attachmentPrompt.ts`                                                           | Cloud prompts get two notes per attachment, and a local path can reach the VM.                                                                                    | "runs a turn on a cloud VM..."                                                                                                                                                                                          |
| `buildRuntimeInstructions` says `through the ${harness} harness`, and cloud passes `"Cursor Cloud"`.                                                                  | `packages/provider-core/src/server/runtimeInstructions.ts`                                                        | The cloud agent no longer knows it runs on Cursor Cloud.                                                                                                          | "runs a turn on a cloud VM..."                                                                                                                                                                                          |
| Skill discovery takes a `runtime` argument. On `"cloud"`, `inspectCursorSkills` skips the home-directory skill roots, because a VM has only the cloned repository.    | `skills.ts` `inspectCursorSkills`, called from `driver.ts` `snapshotForCwd` and `adapter.ts` `resolveUserMessage` | A new upstream skill root or caller that skips the argument offers cloud threads skills the VM cannot load.                                                       | `driver.test.ts` "advertises the skills a cloud instance's agent can load" and `adapter.cloud.test.ts` "invokes only the skills a cloud agent can load"                                                                 |
| Settings decode keeps `runtime`, `cloudAutoCreatePR` and `cloudOpenAsCursorGithubApp`. `runtime` defaults to `"local"` and the adapter reads it once at construction. | `settings.ts`                                                                                                     | A settings rewrite that drops unknown keys silently turns `cursor-cloud` into a local instance.                                                                   | None. `ProviderSettingsForm.test.ts` only checks which fields the form shows. After a sync, open `cursor-cloud` in **Settings > Providers** on the throwaway T3 and check that **Runs on** still says **Cursor Cloud**. |

`CursorAdapterV2.testkit.ts`, `ProviderInstanceRegistry.test.ts`, `driver.test.ts` and `adapter.test.ts` gained an `attach` stub on their fake sessions or the three settings fields. A new upstream fake session or `CursorSettings` literal needs the same additions. `driver.test.ts` also carries the skills test named in the table above, and `adapter.test.ts` carries "fits a delegated child's long thread id into Cursor's agent name limit", which pins `cursorAgentName`.

### Thread workflow hook call sites

Core reaches the thread workflow module only through `ThreadHooks`. Each row is a call site upstream can move or bypass without a merge conflict. Run the tests in the last column after every sync:

```bash
vp test run apps/server/src/threadWorkflow apps/server/src/mcp/toolkits/threadWorkflow \
	apps/server/src/orchestration-v2/runtimeLayer.test.ts \
	apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts \
	apps/server/src/orchestration-v2/ThreadSettlementService.test.ts
```

| Call site                                                                                                                                                                                                            | If upstream changes it                                                                                             | Test that catches it                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Orchestrator.ts` `refuseIfThreadBlocked`, called in the thread mutation guard for `thread.settle` and `thread.archive`, and first in the `thread.delete` case. `thread.auto-settle` settles through the same guard. | A new way to settle, archive or delete that skips the guard lets a thread with an open workflow leave active work. | `runtimeLayer.test.ts` "refuses settle, archive and delete while the hook blocks, and allows them after", and `threadWorkflow/integration.test.ts` "refuses every way out of active work while an instance is open"                                   |
| `ThreadManagementService.ts` `settleThread` checks before it defers an agent's settle of its own thread to the end of the turn.                                                                                      | The agent never hears the refusal, because the deferred settle fails after its turn.                               | `runtimeLayer.test.ts` "refuses an agent settling its own thread mid-turn instead of deferring it"                                                                                                                                                    |
| `ThreadSettlementService.ts` skips a thread the hook blocks before it dispatches `thread.auto-settle`.                                                                                                               | The sweep logs a refused settle every minute.                                                                      | `ThreadSettlementService.test.ts` "does not dispatch a settle the lifecycle hook would refuse"                                                                                                                                                        |
| `ProjectService.ts` `refuseBlockedThreads` before a forced project delete, and again per thread under its lock.                                                                                                      | A project delete removes a thread with an open workflow.                                                           | `runtimeLayer.test.ts` "refuses a forced project deletion as a whole, naming every blocked thread" and "stops a cascade at a thread blocked after the preflight, and a retry finishes"                                                                |
| `ProviderTurnStartService.ts` asks for `turnNote` and puts it in front of the first provider turn of a root run.                                                                                                     | The agent stops seeing its current step, or a module fault fails the turn.                                         | `ProviderTurnStartService.test.ts` "prefixes a root run's prompt with the thread's turn note", "asks for the turn note as compacting on /compact and sends none" and "sends the user's text unchanged and logs a warning when the module's note dies" |
| `ProviderSessionManager.ts` adds the `thread-workflow` MCP capability when the flag is on or the thread has an open workflow.                                                                                        | Agents lose the workflow tools.                                                                                    | None. After a sync, check on a throwaway T3 that `thread_workflow_get` answers in a thread with the flag on.                                                                                                                                          |
| `server.ts` provides `ThreadWorkflow.layerForServer` below every hook consumer and `ThreadWorkflow.layerIdleReactorStart` beside the other reactors. A consumer built outside it gets the inert default.             | Every guard silently stops refusing.                                                                               | None for `server.ts` itself. `threadWorkflow/integration.test.ts` builds the module under the real orchestration graph. After a sync, check on a throwaway T3 that settling a thread with an open workflow is refused.                                |

### Code that copies upstream

When upstream changes the original, check the copy by hand. No test compares them.

| Our copy                                                                                                                 | Upstream original                                                                                   | What must still match                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud.ts` `linkCursorCloudPullRequests`, a small MCP HTTP client                                                        | `apps/server/src/mcp/AcpMcpStdioBridge.ts` `callAcpMcpTool`                                         | Protocol version `2025-06-18`, the `mcp-session-id` and `mcp-protocol-version` headers, and the `initialize`, `notifications/initialized`, `tools/call` sequence                                                             |
| The `link_pull_request` call with `{ url }`                                                                              | `apps/server/src/mcp/toolkits/pullRequests/tools.ts` `LinkPullRequestTool`                          | The tool name and its `url` argument. If either changes, every cloud PR link fails and the turn still completes.                                                                                                             |
| `cloud.ts` `cursorCloudPrompt`, which inlines text attachments within `PROVIDER_SEND_TURN_MAX_INPUT_CHARS`               | `providerMessageTextWithAttachmentPaths` in `packages/provider-core/src/server/attachmentPrompt.ts` | The `[Attached ... "name"` note prefix, and the rule that an attachment's text or note goes in only if the prompt stays within the input limit, earlier attachments first. Our copy always keeps the cloud environment note. |
| `cloud.ts` `resolveCursorCloudCheckout`, which shells out to git for the remote, branch, unpushed count, and dirty state | `apps/server/src/vcs/GitVcsDriverCore.ts`                                                           | How "on origin" and "commits ahead" are decided. Our copy also strips credentials from the remote URL first, which upstream's `parseGitHubRepositoryNameWithOwnerFromRemoteUrl` does not do.                                 |
| `adapter.ts` `cursorAgentName`                                                                                           | upstream's `` `T3 Code ${threadId}` `` agent name                                                   | The `T3 Code ` prefix and Cursor's 100-character name limit                                                                                                                                                                  |

## Fixes owed upstream

None are open. Worktree isolation for delegated tasks (pingdotgg/t3code#19102) was raised during the 3238 sync. It is merged upstream and shipped in 3238, so the fork owes nothing there. pstack-lim could use it in place of the `git worktree add` steps its skills ask helpers to run, which is a change for that repository.

One gap could go upstream. The web client warns when the server is older than the client (`apps/web/src/versionSkew.ts`), but not when the client is older than the server, so a tab left open across a server update keeps an old client until it happens to reload. The fork covers it with the reload line in the cutover report.
