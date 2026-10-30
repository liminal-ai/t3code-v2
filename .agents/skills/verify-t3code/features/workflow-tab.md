# Workflow tab

A thread workflow is a checklist of stages on one thread. The user starts one from a template in the Workflow tab of the right panel, the agent is told its current stage on each turn, the user marks a stage Done, and the user closes the workflow as finished once every stage is done or skipped.

## Sub-features

- `workflow-start` starts a workflow from one of the templates: the pstack playbooks, Fork sync, Retro round and Open-ended.
- `workflow-note` sends the agent its current stage in front of its next turn.
- `workflow-done` marks the current stage done, and offers Undo.
- `workflow-close` closes the workflow as finished with a required reason.
- `workflow-blocks-settle` refuses to settle a thread while its workflow is open, with the reason.
- `workflow-menu` holds Add a step, Show activity, Close as finished and Abandon.
- `workflow-question` puts the agent's question for the user above the stages, marks the thread Awaiting Input, and takes the answer in the tab or in chat.
- `workflow-question-chat` shows each open question above the composer until it is answered or withdrawn, and its `Answer in Workflow` button opens the tab on it.

## How to get to it (user POV)

- Open a thread that has had at least one turn, open the right panel with the panel button at the top right, and choose the `Workflow` tab.
- Ask the agent in the thread to start a workflow, which uses the `thread_workflow_*` tools.
- Choose `Answer in Workflow` on an open question's row above the composer, which opens the tab on that question.

## Driving it with t3v

Preconditions:

- `node $T3V settings threadWorkflowsEnabled=true` has run.
- A thread in a disposable project has finished one turn. Follow [agent-turn.md](./agent-turn.md).
- The thread has no open workflow.

- **Open the tab.** Open the right panel and its Workflow tab. Run `node $T3V browser click --role button --name "Toggle right panel"` and `node $T3V browser click --role button --name "Workflow W"`. A heading `Start a workflow` lists the templates, `Investigation` first and `Open-ended` last, each with a `Start` button and none marked `playbook changed` on a machine with the current pstack installed.
- **Start a template.** Start Open-ended. Run `node $T3V browser click --role button --name "Start" --in "Open-ended"`. The heading reads `Open-ended`, the line under it reads `Stage 1 of 5`, and the stages read `Verify skill named and run folder made`, `Owed work filed as grouped tickets`, `Thread reflected and verify skill kept current`, `Run cleaned up` and `Confirm done with the user`, the last marked `your call`. The first carries `Done` and a `Note` box.
- **Settle is refused.** Hover the thread's sidebar card and choose its `Settle thread`, which shows only on hover. Run `node $T3V browser hover --role button --name "<thread title>, demo-project"` and `node $T3V browser click --role button --name "Settle thread" --in "<thread title>"`, then `node $T3V browser wait --text "Failed to settle thread"`. The toast says the thread has an open workflow, and the card stays in the list.
- **The agent's note.** Ask the agent where it is. Run `node $T3V browser click --role textbox --name-prefix "Message"`, `node $T3V browser type "Which workflow stage are you on? Quote its title in one sentence. Do not call tools or change files."`, `node $T3V browser press Enter` and `node $T3V browser wait --gone "Working" --timeout 180000`. The reply names `Verify skill named and run folder made`.
- **Ask a question.** Have the agent put a question on the workflow, before any stage is done. Run `node $T3V browser click --role textbox --name-prefix "Message"`, `node $T3V browser type "Call thread_workflow_ask with title 'Which base branch should the PR target?', summary 'main (recommended) or release/next', and options main (recommended) and release/next. Then reply with one word and stop. When my answer arrives later, reply with one word again; do not tick, close or change anything."`, `node $T3V browser press Enter` and `node $T3V browser wait --role button --name "Answer in Workflow: Which base branch should the PR target?" --timeout 180000`. The question sits above the composer as a row with its title, its summary and `Answer in Workflow`, and above the stages in the tab as a two-line row. The Workflow tab shows a count of 1, and the thread's sidebar card reads `Input`.
- **Open it from the chat.** Close the right panel, then choose the row's button. Run `node $T3V browser click --role button --name "Toggle right panel"` and `node $T3V browser click --role button --name "Answer in Workflow: Which base branch should the PR target?"`. The panel opens on the Workflow tab with that question expanded and its `Answer to Which base branch should the PR target?` box focused.
- **Answer it.** Choose an option. Run `node $T3V browser click --role button --name "main" --in "Which base branch should the PR target?"`. The row leaves the chat column, the tab's row folds into `Answered (1)`, the count and the `Input` marker clear, a message quoting the question and `main` appears in the timeline as yours, and a turn starts. Wait for it with `node $T3V browser wait --gone "Working" --timeout 180000`.
- **Withdrawn or answered in chat.** Each also leaves the chat column. Ask two more: run `node $T3V browser click --role textbox --name-prefix "Message"`, `node $T3V browser type "Call thread_workflow_ask twice: title 'Ship to staging first?' with summary 'Staging is back up', then title 'Keep the demo README as it is?' with summary 'Yes (recommended) or rewrite it'. Then reply with one word and stop."`, `node $T3V browser press Enter` and `node $T3V browser wait --role button --name "Answer in Workflow: Keep the demo README as it is?" --timeout 180000`. Have the agent withdraw one: send `Withdraw the open workflow question 'Ship to staging first?' with thread_workflow_change, reason 'Staging is no longer part of this change'. Change nothing else, then reply with one word.` the same way and wait with `node $T3V browser wait --gone "Working" --timeout 180000`. Only `Keep the demo README as it is?` stays above the composer. Answer the other in chat: send `My answer to the workflow question 'Keep the demo README as it is?' is: yes, keep it. Record it on the question with thread_workflow_change answer. Change nothing else, then reply with one word.` and wait the same way. No row stays above the composer, and the `Input` marker clears.
- **Mark it done.** Choose `Done` on each stage in turn. Run `node $T3V browser click --role button --name "Done"` five times. Each stage shows a check and `Undo` as the next one takes `Done`, and the line under the heading reads `All 5 stages done`.
- **Close it.** Open the `Workflow menu` and choose `Close as finished…`, enter a reason, and confirm. Run `node $T3V browser click --role button --name "Workflow menu"`, `node $T3V browser click --role menuitem --name "Close as finished…"`, `node $T3V browser type "Verification finished."` and `node $T3V browser click --role button --name "Close workflow"`. The line under the heading reads `Finished · 5 stages`.
- **Proof.** Run `node $T3V browser shot <dir>/closed` and `node $T3V browser aria <dir>/closed`. Grade it with the outcome check: `node $T3V outcome workflow <thread-id>` prints, in order, `started` with `"template":{"id":"open-ended"` by `user`, `asked` by `agent`, `answered` by `user` with `"source":"pane"`, two more `asked` by `agent`, `withdrawn` by `agent`, `answered` by `agent` with `"source":"chat"`, `ticked` for steps `w1.1` to `w1.5` by `user`, and `closed` with `"outcome":"finished"` and your reason by `user`. `node $T3V outcome note <thread-id>` prints a `<thread-workflow>` note naming `step 1 of 5: find-verify-skill (w1.1)` and `Verify skill named and run folder made`.

## Gotchas

- A question's controls are named after its title: `Details for <title>` opens it, `Answer to <title>` is the free-text field, and the option buttons sit inside the row, so target them with `--in "<title>"`. The stage rows have a plain `Details` button, which `--in` on a question title does not reach. The row above the composer has one button, `Answer in Workflow: <title>`.
- While the agent waits on its own question tool, that request's drawer takes the space above the composer and the workflow question rows leave until it is answered.
- Answer a question before marking the last stage done. Once every stage is done, the agent's next note tells it to close the workflow, and the turn the answer starts will close it as `agent`, so the user's close below never happens.
- On 2026-10-30 a card whose turn had ended was a `treeitem` named `<thread title>, Done, <project>`, and `click --role treeitem --name "<thread title>, Done, demo-project"` opened its thread. The settle drive below was not rerun against that name.
- The sidebar card's accessible name is `<thread title>, <project>`, and its `Settle thread` button is hidden until the card is hovered, so `click` on it alone times out behind the status slot. Hover the card first.
- On a thread with no surface open, `Toggle right panel` shows `Open a surface`, a list of surfaces with one-letter shortcuts. `Workflow` is the last one, and its accessible name is `Workflow W` because the shortcut is part of it. `--name "Workflow"` matches the open tab's own button instead.
- The note reaches the agent only on a turn that starts after the workflow does. The thread's stored messages hold only the user's text, so read the note from the provider log with `outcome note`, not from SQLite.
- Open-ended started from the tab has the five shared stages and none of the agent's own, so its first stage's note tells the agent to insert 2 to 3 stages after it. If the agent follows that, the stage counts above change, so keep the drive's prompts to questions.
- A thread started with `t3 thread start` has an `mcp:` id. `outcome workflow <thread-id>` and `outcome note <thread-id>` find nothing for it, because the workflow file and the provider log encode the colon (`mcp_3a…`, `mcp%3A…`). Run `outcome workflow` with no id and pick the thread's file, and read the note from `.t3/userdata/logs/provider/events.mcp-<id>.log`.
- A workflow closes as finished only once every stage is done or skipped (`docs/user/thread-workflows.md`), and `Close workflow` stays disabled until the required reason has text.
- A template card carries `playbook changed` when the pstack playbook it was built from moved under it, and `playbook missing` when that playbook is not installed on the server's machine. It still starts. Open-ended has no playbook and never carries one.

The user-only check of the proof run (`proof/t5/user-only/report.md` of run `retro-1026-t3-fork`) reached every step from screenshots and `docs/user/thread-workflows.md`. These are the gaps it found in the app and its guide:

- The guide says "Open the **Workflow** tab" but not where it is. The user found it by opening the far-right panel toggle and reading `Open a surface`.
- The template cards count "steps" (`10 steps`, `1 step`), while the pane and the guide say "stages".
- The Open-ended card says to start it with 2 to 3 stages, but starting it from the tab gives only the five shared stages, and nothing asks the user for stages. The agent's note on the first stage asks the agent instead.
- Nothing in the tab explains the `playbook changed` badge; the user guide does.
- The heading reads `All 1 stages done`, a grammar slip.
- `Undo` leaves the stage once the workflow is closed, and the guide does not say so.
