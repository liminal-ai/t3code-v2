# Link another environment

A user links two machines running T3 Code, and agents on one can then work on the other. Each machine turns on the Linked environments beta in Settings > Labs. On the machine they work from, the user links the other with its address and a pairing code from it, in Settings > Connections or with `t3 environment link`. An agent there can then hand a task to the linked machine with `delegate_task` and `target.environmentId`. The task runs there as an ordinary thread marked `From` this machine, and the parent wakes with its result. Upstream's guide is `docs/user/remote-access.md`, "Link another environment".

## Sub-features

- `link-labs` turns on `linkedEnvironmentsEnabled`, which shows the Linked environments section in Settings > Connections.
- `link-pair` links this environment to another with an address, a pairing code and an access mode.
- `link-list` lists each link with whether it answers, its access and its expiry, 30 days out.
- `link-delegate` runs a `delegate_task` on the linked environment and wakes the parent with the result.
- `link-forget` removes the link here. The other environment still lists it in its Connections until revoked there.

## How to get to it (user POV)

- Turn on **Linked environments** in **Settings > Labs** on both machines.
- Open **Settings > Connections**, choose **Link** under **Linked environments**, enter the **Address** and **Pairing code**, pick the access and choose **Link**.
- From a terminal: `t3 environment link <address> --pairing-code <code> --access <mode>`, then `t3 environment list`.
- Ask an agent to delegate a task to the linked machine.

## Driving it with t3v

Preconditions:

- Two throwaway dev servers at the PR's head, never prod: A is this worktree's, and B runs from a second worktree of the same commit (`git worktree add <path> <head sha>`, then the baseline in B). Each derives its own ports, so they run side by side ("Isolation" in SKILL.md). Set `T3V_B=<B worktree>/.agents/skills/verify-t3code/scripts/t3v.mjs`. Every `node $T3V_B` command acts on B.
- `node $T3V doctor` and `node $T3V_B doctor` print no `FAIL`.
- A disposable project in each, here `link-a` in A and `link-b` in B. See [projects.md](./projects.md).
- `Claude` shows `Authenticated` in Settings > Providers on A. B uses the same machine's Claude login.

- **Labs on A.** Run `node $T3V browser goto /settings/labs` and `node $T3V browser click --role switch --name "Linked environments"`. Then run `node $T3V browser goto /settings/connections`. The page shows a **Linked environments** section with `No linked environments` and a **Link** button. Before the switch, it has no such section.
- **Labs on B.** Run `node $T3V_B settings linkedEnvironmentsEnabled=true`. It prints the merged file with `"linkedEnvironmentsEnabled": true`, and the server reloads it without a restart.
- **Pairing code from B.** Run `node $T3V_B pair`. It writes a fresh pairing URL to the `pairing-url` file it names, mode 0600, so run it after B's `browser open` has spent the startup one. The pairing code is the part after `#token=`. Read it into a shell variable, `code=$(sed -n 's/.*#token=//p' <that file>)`, and never print it.
- **Link from A.** From A's worktree root, run `node apps/server/src/bin.ts environment link --base-dir "$PWD/.t3" "http://127.0.0.1:<B server port>" --pairing-code "$code" --access full-access`, with B's server port from its `[dev-runner]` line. It prints `Linked <label> (<environmentId>) with full-access access, until <date 30 days out>.` Keep the environment id.
- **List.** Run `node apps/server/src/bin.ts environment list --base-dir "$PWD/.t3"`. B's entry reads `reachable, access full-access, expires <date>` and its address. A's Settings > Connections lists B under Linked environments. Run `node $T3V browser shot <dir>/linked`.
- **Delegate.** Read B's project id with `node $T3V_B outcome sql "select project_id, title from projection_projects"`. Start a thread on `Claude Haiku 5.5` in `link-a` (see [agent-turn.md](./agent-turn.md)) and send: `Call the delegate_task tool exactly once with mode async, task "Reply with the single word pong. Do not call tools or change files.", and target environmentId <B's environment id>, projectId <B's link-b project id>, providerInstanceId claudeAgent and model claude-haiku-5-5. Then end your turn. When the task's result wakes you, tell me its reply in one sentence and end your turn.` Run `node $T3V browser wait --gone "Working" --timeout 240000`, and the parent's reply says it delegated the task. When B's task ends, the parent wakes for a second turn. Read its messages with `node $T3V outcome sql "select created_at, json_extract(payload_json, '$.text') from orchestration_v2_projection_messages where thread_id = '<A's thread id>' order by created_at"` until a message after the delegation says the task replied `pong`.
- **Proof.** On B, `node $T3V_B outcome sql "select t.thread_id, t.title, r.status from orchestration_v2_projection_threads t join orchestration_v2_projection_runs r using (thread_id) where t.project_id = '<B's link-b project id>'"` shows the delegated thread with a `completed` run. In B's UI that thread's header reads `From <A's label>`. Open it with `node $T3V_B browser goto /<B's environment id>/<thread id>` and run `node $T3V_B browser shot <dir>/from-a`. On A, run `node $T3V browser shot <dir>/parent-woken` and `node $T3V browser text`.
- **Forget.** Run `node apps/server/src/bin.ts environment unlink --base-dir "$PWD/.t3" <B's environment id>` in A, or choose **Forget** on B's entry in A's Settings > Connections. The list no longer shows B. B still lists A's link in its own Connections until revoked there.

## Gotchas

- This recipe comes from the source and from the 3824 fleet run's scripts. The #45 verifier drove only the Labs switch and the empty Connections section. Correct any handle the first full drive finds wrong.
- The flag must be on for both servers. While it is off on the linking side, `environment link` refuses. While it is off on either, agents start nothing over the link.
- A link sends the pairing code and then its token to the address, so plain `http` is accepted only for a loopback or Tailscale address. Use the https address for anything else.
- `t3_environment_read` does not report `linkedEnvironmentsEnabled`. Read it from the server's `settings.json`, or with `node $T3V settings` on a dev server.
- A server you cannot drive through its UI, such as a fleet box, watches its `settings.json`. Write the flag with an atomic rename so the watcher never reads half a file. The fleet run's `enable-linked.py` in `.pstack/runs/sync-3824-chain/proof/fleet/` does that.
- Never link to or from prod in a verification. The fleet run linked prod to seven fleet machines with `link-from-prod.sh` as an operations task, not a check.
- A tool reaches the linked environment only when it takes `environmentId`. The `thread_workflow_*` tools do not, so they always act on this environment.
- Links expire after 30 days. Link again with a fresh pairing code to renew one.
