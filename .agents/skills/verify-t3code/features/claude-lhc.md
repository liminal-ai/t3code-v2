# Claude LHC threads

A user adds a Claude LHC provider instance, points it at a Node binary and the claude-lhc sidecar, and runs a thread on it. Each turn records into the LHC store, the thread continues the same conversation after a server restart, an edit from an earlier message rewinds the LHC record, and `/compact` rebuilds the view through LHC.

## Sub-features

- `lhc-add` adds a Claude LHC instance from Add provider, beside stock Claude.
- `lhc-unavailable` shows why an instance without its Node binary or sidecar cannot run.
- `lhc-setup` fills the Node binary and sidecar entry on the instance card.
- `lhc-turn` runs a turn through the sidecar into the LHC store.
- `lhc-restart-resume` continues the same LHC thread after a server restart.
- `lhc-rollback` rewinds the LHC record with `Edit from here`.
- `lhc-compact` compacts through LHC when the user sends `/compact`.
- `lhc-stock` leaves stock Claude turns off the sidecar.

## How to get to it (user POV)

- Choose `Settings`, then `Providers`, then `Add provider`, then `Claude LHC`.
- Pick the instance in the composer's model picker, under its own provider icon beside `Claude`.
- Hover a sent message in a Claude LHC thread and choose `Edit from here`.

## Driving it with t3v

Preconditions:

- `node $T3V doctor` prints no `FAIL`.
- A claude-lhc build at the version `lhc/sidecar.json` pins. Until a release stages it, build one from a separate clone of long-horizon-context, never in its checkout: `pnpm install --frozen-lockfile --filter "claude-lhc..."`, then `pnpm --filter lhc build && pnpm --filter claude-lhc build`. The entry is `packages/claude-lhc/dist/sidecar.js`.
- A Node 24.3 or later binary, named by an absolute path.
- A disposable project folder that is its own git repository (`git init` in it), added through [projects.md](./projects.md). Here it is `lhc-demo`.

- **Add the instance.** Run `node $T3V browser goto /settings/providers`, `node $T3V browser click --role button --name "Add provider"` and `node $T3V browser click --role radio --name "Claude LHC"`. Then `node $T3V browser click --role button --name "Next"`, fill `--role textbox --name "Label"` and `--name "Instance ID"` (here `LHC Work` and `lhc_work`), `Next` again, and `node $T3V browser click --role button --name "Add instance"`. The config step lists `Compact trigger` and `Rebuilt view size` and no idle compaction setting.
- **See it unavailable.** The new card's status reads `Not found · Set CLAUDE_LHC_NODE to a Node 24.3.0 or later binary.` Save `node $T3V browser shot <dir>/lhc-unavailable`.
- **Set up the sidecar.** Run `node $T3V browser fill --role textbox --name "Node binary" --value <node path>`, `node $T3V browser press Tab`, the same for `--name "Sidecar entry"` with the entry path, and `Tab`. The status turns to `Authenticated`. `node $T3V settings` shows both under the instance's `environment` with `"sensitive": false`.
- **Take a turn.** Open a new thread in `lhc-demo`, open the picker (its button is named after the current model, such as `GPT-6-Astra`), choose `--role button --name "LHC Work"`, then `--text "Claude Haiku 5.5"`. Send a prompt that plants a word, such as `Remember the codeword PERIWINKLE-42 for later. Reply with only the word noted. Do not call tools or change files.`, and wait with `browser wait --gone "Working" --timeout 180000`. The LHC registry gains a thread: `sqlite3 -readonly "file:.t3-lhc/registry.sqlite?mode=ro" "select thread_id, title from threads"`.
- **Restart and resume.** Run `node $T3V down`, then `node $T3V up` and `node $T3V browser open`, and `browser goto` the thread's path. Ask for the codeword. The reply names it, the registry still holds one thread, and `select * from thread_alias` gains an alias for the resumed generation.
- **Roll back.** Hover a later user message, then `node $T3V browser click --role button --name "Edit from here" --in "<that message's text>"` and `--role button --name "Revert and keep changes"`. The prompt returns to the composer. Replace it with a prompt that quotes the conversation, and send. The reply quotes no removed turn, and the thread's store records the rollback: `sqlite3 -readonly "file:<file>?mode=ro" "select event_kind, payload from event where event_kind = 'rollback'"`, where `<file>` comes from `threads.file_path` in the registry. After another restart the thread shows no removed turn.
- **Compact.** Send `/compact`. The timeline shows `Context compacted` with the rebuilt size, and `thread_alias` gains an alias for the compacted generation.
- **Stock Claude.** Start a thread on `Claude` > `Claude Haiku 5.5` and send `Reply with the single word pong. Do not call tools or change files.` The LHC registry gains no thread and no alias.
- **Proof.** Read the LHC store read-only: `sqlite3 -readonly "file:.t3-lhc/registry.sqlite?mode=ro" "select * from thread_alias; select thread_id, title from threads"`. One thread holds every alias of the conversation. Grade runs with `node $T3V outcome sql "select t.title, t.provider_instance_id, r.ordinal, r.status from orchestration_v2_projection_threads t join orchestration_v2_projection_runs r using (thread_id)"`: rolled-back runs read `rolled_back`.

## Gotchas

- Add provider's config step has no Node binary or sidecar fields. They appear under `Setup` on the instance card after `Add instance`.
- A dev server's base dir is the worktree's `.t3`, so its LHC store is `.t3-lhc` beside it, which git ignores.
- The sidecar writes projected native sessions into the Claude home's `projects/` folder, the same place stock Claude writes its sessions.
- The sidecar runs in Claude Code's process group with its stderr dropped, as Claude Code's is, so its own log lines never reach the dev log. Read the LHC store instead.
- Claude's adapter labels every Claude session `claudeAgent`, so `orchestration_v2_projection_provider_sessions.driver` reads `claudeAgent` for a Claude LHC thread. Its `provider_instance_id` names the LHC instance.
- After `node $T3V down`, the server can take a few seconds to exit, and an `up` in that window reports a server still running. Wait and run `up` again.
- A sidecar built from a branch whose package version differs from `lhc/sidecar.json` shows as unavailable with both versions in its status.
