# A Claude thread on Limbase

A Claude instance with a Limbase home runs its threads on Limbase. Each thread gets one Limbase thread, every message is captured there, and when the thread's context passes the compact trigger the session moves to a compacted view and goes on. The agent can read folded history back with `mcp__limbase__get_turns`. A step that Limbase fails shows Limbase's reason in the thread. Fork and Edit from here are not native on a Limbase thread yet. A thread on any other instance runs as before.

## Sub-features

- `limbase-turn` runs a turn with tool calls on a Limbase instance, and Limbase holds its turns.
- `limbase-install` moves the session to a view in the middle of a turn, and the turn carries on with the thread's rules and tools.
- `limbase-retrieval` lets the agent call `mcp__limbase__get_turns` and `mcp__limbase__get_messages`.
- `limbase-restart` resumes the session Limbase last installed after a server restart.
- `limbase-fail-out` fails the run with a provider error `limbase: stopped at ...` when Limbase is down past its 90-second window, at a prompt or at a tool boundary, and the next turn works once Limbase is back.
- `limbase-refusals` refuses Edit from here with `Edit from here does not work on a Limbase thread yet.`, and turns a fork into a fresh session with `Could not fork the source conversation natively (Limbase does not fork threads yet). ...`.
- `limbase-plain` leaves a thread on a plain Claude instance unchanged.

## How to get to it (user POV)

- Settings > Providers: a Claude instance's **Limbase home** and **Binary path**, per `docs/user/claude-limbase.md`.
- Pick that instance in the composer's model picker and send a message.

## Driving it with t3v

Preconditions:

- A Limbase stack of the run's own, never prod's: from a Limbase checkout with `pnpm install` done, write `<dir>/stack.env` with `LIMBASE_CONVEX_PORT=<free port, check ss -H -ltn>`, `LIMBASE_CLAUDE_CLI=<this machine's claude binary>` and `LIMBASE_KINDS=<checkout>/scripts/kinds/haiku-only.json`, then run `scripts/local-stack.sh install <dir>` and `scripts/local-stack.sh up <dir>`. `<dir>` goes under the run's scratch folder. The home is `<dir>/home`. Stop it with `scripts/local-stack.sh down <dir>`.
- `node $T3V doctor` prints no `FAIL`, and a disposable git project is added with `node apps/server/src/bin.ts project add --base-dir <worktree>/.t3 <folder>`.
- A Claude Code binary at the version in `vendor/limbase/limbase-host-agent-sdk-*.tgz` `package.json` `limbase.claudeCode`. `docs/user/claude-limbase.md` installs one.

- **Instance.** Run `node $T3V settings providerInstances='{"claudeLimbase":{"driver":"claudeAgent","displayName":"Claude Limbase","config":{"limbaseHome":"<dir>/home","binaryPath":"<claude binary>","idleCompaction":"off"}}}'`, keeping any instance the file already has, such as `devReplay`. Settings > Providers lists `Claude Limbase` with its **Limbase home**.
- **Turn.** From the project folder, run `node <worktree>/apps/server/src/bin.ts thread start --base-dir <worktree>/.t3 --provider claudeLimbase --model claude-haiku-5-5 --wait --json . "List the files here with your shell tool, then read one and quote it."`. It prints `"status":"completed"` and a reply. `node $T3V outcome sql "select json_extract(payload_json,'$.nativeMetadata.limbaseThreadId') from orchestration_v2_projection_provider_threads where thread_id='<thread id>'"` prints a `th_...` id, and `limbase thread show <th id>` (with `MEMBASE_HOME=<dir>/home`) shows the thread with `compact policy trigger 700000 target 100000`. `node .agents/skills/verify-t3code/scripts/limbase-turns.mjs <dir>/home <th id> t1` prints the capture cursor and the turn's prompt, tool calls and reply.
- **Install.** A view comes due only past the trigger. For a drive, lower `COMPACT_POLICY` in `apps/server/src/fork/Limbase.ts` in the worktree, never committed, to a trigger above the session's fixed context, for example `{ trigger: 110_000, target: 15_000 }`, and create the thread after the dev server restarts on that edit. Set a standing rule in the first turn, then have the agent read about 40,000 tokens of files across tool calls with `thread send`. `limbase-turns.mjs` then prints a cursor with `viewRevision` 1 or more. The turn completes, the reply still follows the rule, a T3 tool such as `mcp__t3-code__t3_project_list` still answers, the row's `nativeThreadRef.nativeId` is the new session id, and the project's folder under `~/.claude/projects/` holds one file for the thread. The next turn opens no new process: `grep -c '"query.open"'` on `.t3/userdata/logs/provider/events.<thread>.log` does not grow. Restore the policy before you commit.
- **Controls after an install.** On the same thread, in the browser: pick another reasoning level in the model picker while a turn runs. The events log gains a `query.apply_flag_settings` with the new `effortLevel`, and `query.open` does not grow. Have the agent launch a background subagent that reads in small pieces, hover its row under `Lineage`, and choose `Stop subagent <name>`. The events log gains a `query.stop_task`, the row reads `Stopped`, and `query.open` does not grow.
- **Retrieval.** `thread send` a prompt that asks the agent to call `mcp__limbase__get_turns` with `["t1"]` and say what the first turn set. The reply names the rule, and the events log holds `mcp__limbase__get_turns`.
- **Restart.** `node $T3V down`, `node $T3V up`, then `thread send` a turn. It completes, and the last `query.open` in the events log has `"resume"` equal to the row's stored session id.
- **Fail-out at a prompt.** `scripts/local-stack.sh down <dir>`, then `thread send` a turn. After about 90 seconds the run is `failed`. The thread shows the warning line `Operation stopped by hook: limbase: stopped at view: ...` and the provider error `limbase: stopped at view: view.due did not answer within the step's window`, which is the `error` turn item's `failure.message`. `scripts/local-stack.sh up <dir>`, and the next turn completes.
- **Fail-out at a tool boundary.** With Limbase up, `thread send` a turn that tells the agent to run `<limbase checkout>/scripts/local-stack.sh down <dir>` with its shell tool in the foreground, then read a file. After about 90 seconds the run is `failed`, the sidebar card says `Failed`, and the thread shows `Provider error` with `limbase: stopped at capture: the step's records were not saved within the retry window`. Bring Limbase up, and the next turn completes. An agent asked to `sleep` hits this machine's shell hook, which blocks a chained sleep, so stop Limbase from the tool call itself.
- **Refusals.** In the browser, open the thread, expand a sent message's bubble, choose `Edit from here`, then `Revert and keep changes`. A toast reads `Edit from here does not work on a Limbase thread yet.` and the timeline is unchanged. Choose `Fork from this response` on a reply and send a message in the fork. The fork's turn shows `Could not fork the source conversation natively (Limbase does not fork threads yet). Started a fresh session with its history.`, and its row has a new `limbaseThreadId`.
- **Plain.** Run the turn above with `--provider claudeAgent`. Its row has no `limbaseThreadId`, and its events log has no `mcp__limbase`. Drive `features/agent-turn.md` on it too.

- **Release build.** A dev server never runs the single-executable step, which rejects a static import of a file-backed package such as `zod` or `undici`. After `vp run --filter t3 build`, run `VP_NODE_VERSION=<engines.node> vp env exec --node <engines.node> node apps/server/scripts/cli.ts build-exe`. It ends `Built dist-exe/t3`, not `ServerCliExecutableImportError`. Before a merge, `~/lim-v2/bin/t3-v2-deploy <head>` builds the release and passes its smoke test. It never switches prod.

## Gotchas

- The Limbase service's socket path comes from `<home>/config/membase.json`, read at each open. A home whose path is long keeps its socket under `/tmp`.
- `thread send --json` exits 1 for a turn that Limbase stopped and prints the failure on its last line, not JSON.
- A dev server reads `apps/server/src/fork/Limbase.ts` again after an edit and restarts, which closes every live query. Edit the policy before you start the thread you drive.
- `GetTurns` ids are Limbase's own turn chunks, not T3 runs: one long T3 turn can span several.
