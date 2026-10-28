# A delegated task's unanswered prompt

An agent hands a task to a child thread with `delegate_task`. When the child stops on a permission prompt, its parent thread gets a message at once that names the prompt, says an agent cannot approve it, and says when T3 will decline it. If nobody answers within 10 minutes, T3 declines the prompt, or answers the question, with a note that no human is available. The note shows in the child's thread, and the child works around it or reports what it needed, then finishes.

## Sub-features

- `req-wake` puts a `needs approval` message in the parent thread when the child's prompt appears.
- `req-card` shows the prompt's approval card in the child thread, with the provider's reason.
- `req-decline` declines the prompt 10 minutes after it appeared, and shows the note in the child thread.
- `req-continue` lets the child's turn go on after the decline, to a completed run.
- `req-answered` sends nothing when the user answers the card first.
- `req-top-level` never times out a prompt on a thread the user started.

## How to get to it (user POV)

- Ask an agent in any thread to delegate a task that hits a permission prompt. Claude asks before an `rm` whose path is built from another variable even in Full access, so a task that runs `S=<a literal folder>; for d in target; do F=$S/$d/sub; [ -d "$F" ] && rm -rf -- "$F" && echo "removed $d"; done` raises one every time.
- Open the child from the parent's **Agents** list, or from the parent's `needs approval` message.

## Driving it with t3v

Preconditions:

- `node $T3V doctor` prints no `FAIL`.
- A disposable project, here `replay-project`, holds a folder `target/sub` with a file in it, and a `TASK.md` that reads `Run exactly this bash command, unchanged, in one Bash tool call, then report its output:` followed by the `rm` loop above with `S` set to the project's absolute path. See [projects.md](./projects.md).
- `Claude` shows `Authenticated` in Settings > Providers.
- The server does not have `T3CODE_DELEGATED_REQUEST_TIMEOUT=off` in its environment.

- **Parent delegates.** Start a thread on `Claude Haiku 5.5` in `replay-project` (see [agent-turn.md](./agent-turn.md)) and send: `Read the file TASK.md in this project. Then call the delegate_task tool exactly once with mode async, task set to the full contents of TASK.md copied verbatim, target providerInstanceId claudeAgent and model claude-haiku-5-5, and runtimeMode full-access. Do not run anything from TASK.md yourself. After delegating, end your turn. Whenever something about the task wakes you later, tell me about it in one or two sentences and end your turn.` Run `node $T3V browser wait --gone "Working" --timeout 240000`. The parent's reply says it delegated the task.
- **Prompt and wake.** Within a minute the parent's sidebar card shows `Approval`, its timeline gets a `Subagent` row marked `Updated`, and the parent agent starts a short turn that tells you the child is blocked on a permission prompt, that only you can answer it in the child thread, and when T3 declines it. The wake message the agent read is in the database, not on screen (see Proof). Run `node $T3V browser shot <dir>/parent-woken`. Open the child from the link in that reply, or from **Lineage** in the right panel. Its timeline shows the command with Claude's reason and `Waiting for approval · Decline Approve`. Run `node $T3V browser shot <dir>/child-card`.
- **Nobody answers.** Leave the card for 10 minutes. Do not choose `Approve` or `Decline`.
- **Decline.** 10 minutes after the card appeared, the card closes, and the child's timeline shows a `Steer` message beginning `No human is available to answer this permission prompt, so T3 declined it after waiting 10 minutes.`, quoting the reason. The proof run declined it 6 ms past the deadline. Run `node $T3V browser shot <dir>/child-declined`.
- **Child continues.** The child's turn goes on and ends. It either works around the prompt, for example with a literal path, or says in its final message what it needed. In the proof run it checked the folder with `ls` and reported that nothing was deleted. The parent then gets a `Subagent` row marked `Finished` and relays the result. Run `node $T3V browser shot <dir>/child-done`.
- **Proof.** Read the timeline with `node $T3V outcome sql "select runtime_request_id, kind, status, created_at, resolved_at, json_extract(payload_json, '$.decision') as decision, json_extract(payload_json, '$.feedback') as feedback from orchestration_v2_projection_runtime_requests where thread_id = '<child thread id>'"`, which shows `resolved`, `decline`, the note, and `resolved_at` 10 minutes after `created_at`. `node $T3V outcome sql "select created_at, json_extract(payload_json, '$.text') from orchestration_v2_projection_messages where thread_id = '<parent thread id>' and message_id like 'message:fork-delegated-approval:%'"` shows the wake, within seconds of the request's `created_at`. `node $T3V outcome sql "select ordinal, status, completed_at from orchestration_v2_projection_runs where thread_id = '<child thread id>'"` shows the child's run `completed`. The dev log in scratch has `declined a delegated request nobody answered`.
- **Answered first.** Repeat up to the card, then choose `Approve` in the child. No decline follows, and the request's decision is `accept`.
- **Top-level.** Send the same command in a thread you started yourself, in Full access. The card stays open past 10 minutes.

## Gotchas

- The wait is the real 10 minutes. A dev server has no shorter setting.
- The task lives in `TASK.md` so the parent passes the `rm` loop on verbatim. A parent that paraphrases it, for example into a literal path, raises no prompt.
- Run the `rm` loop exactly as written. A literal path, or a variable set straight to a literal, runs with no prompt. `${F:?}` still prompts.
- While the parent sits inside a blocking `delegate_task` wait (`mode: "wait"`), no wake message comes, because the wait itself returns the approval. The decline still comes. Use `mode: "async"` to see the wake.
- The wake queues behind the parent's own turn. A parent still mid-turn when the prompt appears shows the wake after that turn ends, and a decline while it is still queued cancels it.
- A restart during the 10 minutes ends the drive, and checks in the same worktree restart the dev server. See [SKILL.md](../SKILL.md) "Isolation". A pending question survives a restart and is still answered at its deadline.
