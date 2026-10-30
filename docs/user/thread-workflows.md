# Thread workflows

A thread workflow is the arc of one thread's work: a few stages, in order, with who finished each one and when. The agent gets the whole current stage when it changes, a one-line reminder of it on every other turn, and marks stages done as it goes. The **Workflow** tab of the right panel shows the whole arc at a glance: what is done, where the work is now, and what comes next.

While a thread has an open workflow, the thread cannot be settled, archived or deleted. To change course, say so in the workflow: skip a stage with a reason, close the workflow as finished once its stages are done, or abandon it with a reason. Each change is recorded with who made it, so a thread never quietly ends before its stages are done.

## Turn workflows on

Workflows are off by default. Set `"threadWorkflowsEnabled": true` in the server's `settings.json` in its `userdata` directory. There is no Settings screen for it yet.

## Start a workflow

Open the **Workflow** tab and pick a template, or ask the agent to start one. The templates are the pstack playbooks, plus fork sync and the retro round:

- **Build and fix:** Feature, Bug fix, Refactoring, Perf issue, Hillclimb, Visual parity and Prototype.
- **Deliver:** Babysit drives a PR to merge-ready, and Shipping verifies a stack and lands it.
- **Run larger work:** Autonomous run, Orchestrate, Autopilot-full and Multi-phase plan.
- **Read and resume:** Investigation and Session pickup.
- **Look after the tools:** Authoring a skill, Eval, Worktree cleanup, Fork sync (from `FORK.md`) and Retro round.
- **Open-ended** is for work no playbook fits.

A playbook template already holds its playbook's steps. Each opens by finding the project's verify skill and making the run folder, and closes with grouped tickets, a reflect, and cleanup. When a playbook changed after its template was built, the template shows **playbook changed**, and when the playbook is not installed on the server's machine, **playbook missing**. Either way it still starts.

Open-ended opens and closes the same way, and asks you to confirm the work is done after cleanup. The agent writes the stages between in one call, as 2 to 3 stages at one level. A workflow holds at most 8 open stages. A stage that is done, skipped or removed has left the count, so a long thread can keep adding the next stage as it finishes the last. Detail and side quests go in comments on the current stage, not in new stages.

## Read the pane

The tab is one list. Done stages show their title and a one-line result. The current stage is emphasized and carries the **Done** button. Upcoming stages are titles only. Skipped and removed stages stay in order, muted. The line under the title says where the work is, such as **Stage 3 of 5**.

A stage that ends with your decision carries a small **your call** marker. It is not an alarm. **Waiting on you** appears at the top of the tab only when the agent has asked you a question through its question tool and is waiting for the answer. The count on the tab is that plus the open questions on the workflow, described below.

The agent's instructions for a stage, what proof it asked for, and who did what are behind the chevron on each row, under the stage's slug: the short name the agent's reminder calls it by.

## Questions

When the agent needs your decision but can keep working, it puts a question on the workflow instead of asking in chat, where the question would scroll away. Each question is one sentence, with a subline that holds the options or the agent's recommendation. Behind the chevron are the agent's reasoning, the options with the recommended one marked, and the stage that waits on the answer. That stage carries a **waiting on question** marker in the list.

Each open question also shows above the composer in the chat, with its title and subline, until it is answered or withdrawn, so you see it without opening the tab. Its **Answer in Workflow** button opens the tab on that question, expanded, with its answer box ready. While the agent waits on its question tool, that request takes the space above the composer, and the workflow questions come back once you answer it.

Open questions sit at the top of the tab, above the stages. While any question is open, the thread reads **Awaiting Input** in the sidebar, and a new question raises one **Input needed** notification, the same as a question-tool request. Both clear when the last open question is answered or withdrawn.

Answer in the tab or in chat:

- **In the tab.** Expand the question and click an option, or type an answer and press **Answer**. Your answer is posted into the thread as a message that quotes the question, so the agent reads both and starts a turn if it was idle, or sees it after its current turn.
- **In chat.** Type the answer in the composer. The agent records it on the question, so the marker clears without you touching the tab.

Answered and withdrawn questions fold into **Answered (n)** under the open ones, each with its answer and who gave it: **you** from the tab, or **agent (from chat)**. The agent withdraws a question that no longer matters, with a reason. **Reopen** puts a question back; only you can do that. Every change is recorded in the activity log.

## Mark a stage done

Click **Done** on the current stage. The note beside it is optional. After Done, the stage shows **Undo**, which reopens it.

Skip, comment, add a stage after, remove, reopen and unskip are in the menu on each row. Each one records your reason.

## Manage the workflow

The menu in the header holds everything about the workflow itself: switch to another workflow on the thread, start a new one when none is open, show the activity log, close the workflow as finished once every stage is done or skipped, abandon it, or reopen a closed one.

A workflow that sees no activity for a day asks you, through the agent, whether to carry on or close it. The agent puts that on the workflow as a question too.

## Turn enforcement off

Turning `threadWorkflowsEnabled` off stops new workflows and the daily question, but an open workflow keeps blocking. To stop every workflow blocking settle, archive and delete, set `"threadWorkflowEnforcementDisabled": true` in `settings.json`, or start the server with `T3CODE_THREAD_WORKFLOW_ENFORCEMENT=off`. The setting takes effect at once. The environment variable takes effect when the server restarts.

## Limits

- The Workflow tab is on web and desktop. On mobile, a thread with an open workflow has a **Workflow** button in its header that opens the same arc to read. Marking a stage done, the menus, starting a workflow and the questions stay on web and desktop for now, and the mobile thread list does not yet mark a thread with an open question.
- Agents on Cursor Cloud have no workflow tools: they cannot start, mark done or close a workflow. Use the tab for those threads.
