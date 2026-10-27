# Thread workflows

A thread workflow is the arc of one thread's work: a few stages, in order, with who finished each one and when. The agent gets the whole current stage when it changes, a one-line reminder of it on every other turn, and marks stages done as it goes. The **Workflow** tab of the right panel shows the whole arc at a glance: what is done, where the work is now, and what comes next.

While a thread has an open workflow, the thread cannot be settled, archived or deleted. To change course, say so in the workflow: skip a stage with a reason, close the workflow as finished once its stages are done, or abandon it with a reason. Each change is recorded with who made it, so a thread never quietly ends before its stages are done.

## Turn workflows on

Workflows are off by default. Set `"threadWorkflowsEnabled": true` in the server's `settings.json` in its `userdata` directory. There is no Settings screen for it yet.

## Start a workflow

Open the **Workflow** tab and pick a template: **Single task**, **Orchestrate**, or **Open-ended**. You can also ask the agent to start one. An agent writes the whole plan in one call, as 4 to 7 stages at one level, and a workflow holds at most 8 open stages. A stage that is done, skipped or removed has left the count, so a long thread can keep adding the next stage as it finishes the last. Detail and side quests go in comments on the current stage, not in new stages.

## Read the pane

The tab is one list. Done stages show their title and a one-line result. The current stage is emphasized and carries the **Done** button. Upcoming stages are titles only. Skipped and removed stages stay in order, muted. The line under the title says where the work is, such as **Stage 3 of 5**.

A stage that ends with your decision carries a small **your call** marker. It is not an alarm. **Waiting on you** appears at the top of the tab only when the agent has asked you a question and is waiting for the answer, and the count on the tab means the same thing.

The agent's instructions for a stage, what proof it asked for, and who did what are behind the chevron on each row, under the stage's slug: the short name the agent's reminder calls it by.

## Mark a stage done

Click **Done** on the current stage. The note beside it is optional. After Done, the stage shows **Undo**, which reopens it.

Skip, comment, add a stage after, remove, reopen and unskip are in the menu on each row. Each one records your reason.

## Manage the workflow

The menu in the header holds everything about the workflow itself: switch to another workflow on the thread, start a new one when none is open, show the activity log, close the workflow as finished once every stage is done or skipped, abandon it, or reopen a closed one.

A workflow that sees no activity for a day asks you, through the agent, whether to carry on or close it.

## Turn enforcement off

Turning `threadWorkflowsEnabled` off stops new workflows and the daily question, but an open workflow keeps blocking. To stop every workflow blocking settle, archive and delete, set `"threadWorkflowEnforcementDisabled": true` in `settings.json`, or start the server with `T3CODE_THREAD_WORKFLOW_ENFORCEMENT=off`. The setting takes effect at once. The environment variable takes effect when the server restarts.

## Limits

- The Workflow tab is on web and desktop. On mobile, a thread with an open workflow has a **Workflow** button in its header that opens the same arc to read. Marking a stage done, the menus and starting a workflow stay on web and desktop for now.
- Agents on Cursor Cloud have no workflow tools: they cannot start, mark done or close a workflow. Use the tab for those threads.
