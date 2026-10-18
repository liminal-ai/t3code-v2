# Thread workflows

A thread workflow is a checklist attached to a thread. It holds the steps the work must go through, and who finished each one and when. The agent sees the current step at the start of every turn and ticks steps off as it goes. You can tick, skip, add, remove and reopen steps yourself in the **Workflow** tab of the right panel.

While a thread has an open workflow, the thread cannot be settled, archived or deleted. To change course, say so in the workflow: skip a step with a reason, close the workflow as finished once its steps are done, or abandon it with a reason. Each change is recorded with who made it, so a thread never quietly ends before its steps are done.

## Turn workflows on

Workflows are off by default. Set `"threadWorkflowsEnabled": true` in the server's `settings.json` in its `userdata` directory. There is no Settings screen for it yet.

## Start a workflow

Open the **Workflow** tab and pick a template: **Single task**, **Orchestrate**, or **Open-ended**, which starts from a goal and lets you or the agent add steps. You can also ask the agent to start one.

Steps that wait for you, and questions the agent is waiting on, stay pinned at the top of the tab. A workflow that sees no activity for a day asks you, through the agent, whether to carry on or close it.

## Turn enforcement off

Turning `threadWorkflowsEnabled` off stops new workflows, but an open workflow keeps blocking. To stop every workflow blocking settle, archive and delete, set `"threadWorkflowEnforcementDisabled": true` in `settings.json`, or start the server with `T3CODE_THREAD_WORKFLOW_ENFORCEMENT=off`. The setting takes effect at once. The environment variable takes effect when the server restarts.

## Limits

- The Workflow tab is on web and desktop. Mobile has no tab yet.
- Agents on Cursor Cloud have no workflow tools: they cannot start, tick or close a workflow. Use the tab for those threads.
