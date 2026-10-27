# Workflow tab

A thread workflow is a checklist of stages on one thread. The user starts one from a template in the Workflow tab of the right panel, the agent is told its current stage on each turn, the user marks a stage Done, and the user closes the workflow as finished once every stage is done or skipped.

## Sub-features

- `workflow-start` starts a workflow from one of the three templates.
- `workflow-note` sends the agent its current stage in front of its next turn.
- `workflow-done` marks the current stage done, and offers Undo.
- `workflow-close` closes the workflow as finished with a required reason.
- `workflow-menu` holds Add a step, Show activity, Close as finished and Abandon.

## How to get to it (user POV)

- Open a thread that has had at least one turn, open the right panel with the panel button at the top right, and choose the `Workflow` tab.
- Ask the agent in the thread to start a workflow, which uses the `thread_workflow_*` tools.

## Driving it with t3v

Preconditions:

- `node $T3V settings threadWorkflowsEnabled=true` has run.
- A thread in a disposable project has finished one turn. Follow [agent-turn.md](./agent-turn.md).
- The thread has no open workflow.

- **Open the tab.** Open the right panel and its Workflow tab. Run `node $T3V browser click --role button --name "Toggle right panel"` and `node $T3V browser click --role button --name "Workflow W"`. A heading `Start a workflow` lists `Single task`, `Orchestrate` and `Open-ended`, each with a `Start` button.
- **Start a template.** Start Open-ended. Run `node $T3V browser click --role button --name "Start" --in "Open-ended"`. The heading reads `Open-ended`, the line under it reads `Stage 1 of 1`, and the stage `Confirm done with the user` carries `Done` and a `Note` box.
- **The agent's note.** Ask the agent where it is. Run `node $T3V browser click --role textbox --name "Message"`, `node $T3V browser type "Which workflow stage are you on? Quote its title in one sentence. Do not call tools or change files."`, `node $T3V browser press Enter` and `node $T3V browser wait --gone "Working" --timeout 180000`. The reply names `Confirm done with the user`.
- **Mark it done.** Choose `Done`. Run `node $T3V browser click --role button --name "Done"`. The stage shows a check and `Undo`, and the line under the heading reads `All 1 stages done`.
- **Close it.** Open the `Workflow menu` and choose `Close as finished…`, enter a reason, and confirm. Run `node $T3V browser click --role button --name "Workflow menu"`, `node $T3V browser click --role menuitem --name "Close as finished…"`, `node $T3V browser type "Verification finished."` and `node $T3V browser click --role button --name "Close workflow"`. The line under the heading reads `Finished · 1 stage`.
- **Proof.** Run `node $T3V browser shot <dir>/closed` and `node $T3V browser aria <dir>/closed`. Grade it with the outcome check: `node $T3V outcome workflow <thread-id>` prints three records by `user`, `started` with `"template":{"id":"open-ended"`, `ticked` for step `w1.1`, and `closed` with `"outcome":"finished"` and your reason. `node $T3V outcome note <thread-id>` prints a `<thread-workflow>` note naming `step 1 of 1: confirm-done (w1.1)` and `Confirm done with the user`.

## Gotchas

- On a thread with no surface open, `Toggle right panel` shows `Open a surface`, a list of surfaces with one-letter shortcuts. `Workflow` is the last one, and its accessible name is `Workflow W` because the shortcut is part of it. `--name "Workflow"` matches the open tab's own button instead.
- The note reaches the agent only on a turn that starts after the workflow does. The thread's stored messages hold only the user's text, so read the note from the provider log with `outcome note`, not from SQLite.
- Open-ended has one stage, `Confirm done with the user`, and its note tells the agent to add 4 to 7 stages above it. If the agent follows that, the stage counts above change, so keep the drive's prompts to questions.
- A workflow closes as finished only once every stage is done or skipped (`docs/user/thread-workflows.md`), and `Close workflow` stays disabled until the required reason has text.
- The `Single task` and `Orchestrate` cards can carry a `playbook changed` badge. Open-ended starts the same either way.

The user-only check of the proof run (`proof/t5/user-only/report.md` of run `retro-1026-t3-fork`) reached every step from screenshots and `docs/user/thread-workflows.md`. These are the gaps it found in the app and its guide:

- The guide says "Open the **Workflow** tab" but not where it is. The user found it by opening the far-right panel toggle and reading `Open a surface`.
- The template cards count "steps" (`10 steps`, `1 step`), while the pane and the guide say "stages".
- The Open-ended card says to start it with 4 to 7 stages before the sign-off step, but starting it from the tab gives only the sign-off stage, and nothing asks the user for stages.
- Nothing explains the `playbook changed` badge.
- The heading reads `All 1 stages done`, a grammar slip.
- `Undo` leaves the stage once the workflow is closed, and the guide does not say so.
