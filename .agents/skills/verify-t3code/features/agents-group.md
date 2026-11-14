# The Agents group

A user marks a long-running thread, such as a lead thread that delegates work, with **Pin as agent** from its menu. The thread leaves every other sidebar section and shows as one line in a collapsible **Agents** group directly above **Working**, newest activity first, with its status in place of its time. The details pane shows **Pinned as agent** with **Unpin**, and **Unpin agent** in the menu does the same.

## Sub-features

- `agents-mark` adds **Pin as agent** under **Pin thread** and moves the thread into **Agents**, from Active or from Settled.
- `agents-unmark` returns the thread to Active from **Unpin agent** in the menu or **Unpin** in the details pane.
- `agents-group` places the group above Working, or above Snoozed and Settled in project-folder mode, collapses it and keeps the collapse across a reload.
- `agents-row` shows one line per agent, with its status (Working, Approval, Input, Failed) in the time slot and no hover actions or pin indicator.
- `agents-locked` keeps every other path from pinning, settling or snoozing an agent: menus, the pin and settle shortcuts, bulk actions and drags.
- `agents-filters` respects project scope and hidden tags, and keeps agents in sidebar search and keyboard navigation.

## How to get to it (user POV)

- Right-click a thread row in the sidebar, or open the thread menu in the chat header, and choose `Pin as agent`.
- Choose `Unpin agent` from the same menus, or `Unpin` on the `Pinned as agent` row of the details pane.
- Click the `Agents` header to collapse or expand the group.

## Driving it with t3v

Preconditions:

- `node $T3V doctor` prints no `FAIL`.
- At least three finished threads in a disposable project, made on the free Replay provider: `node apps/server/src/bin.ts thread start --base-dir .t3 --provider devReplay --model multi-turn --title "<title>" --wait <project folder> "go"`. `demos/agents-group.demo.mjs` exports a `seed` that builds 22 such threads in three projects under `.t3/demo-projects/` and settles five. The steps below name its threads.
- `Q` is the outcome query for one thread: `Q="select title, json_extract(payload_json,'\$.tags') tags, json_extract(payload_json,'\$.pinnedAt') pinned_at, json_extract(payload_json,'\$.settledOverride') settled_override from orchestration_v2_projection_threads where title = '<title>'"`, read with `node $T3V outcome sql "$Q"`.

Mark, unmark and the group:

- **Mark.** Run `node $T3V browser click --role button --name-prefix "<title>," --button right`, check `node $T3V browser aria <dir>/menu` lists `menuitem "Pin as agent"` right after `menuitem "Pin thread"`, then run `node $T3V browser click --role menuitem --name "Pin as agent"`. The row leaves Active, and `node $T3V browser wait --role button --name-prefix "Agents "` finds the header, whose name ends in the agent count. The outcome query shows `tags` `["agent"]` and `pinned_at` set.
- **The group.** Run `node $T3V browser scroll 3000 --at 128,500` and `node $T3V browser shot <dir>/group`. **Agents** sits above **Working** when a thread is running, else above **Snoozed** and **Settled**. Each agent is one line.
- **Agent menu.** Right-click the agent row. The menu has `Unpin agent` and `Filter by <project>`, and no `Pin thread`, `Unpin thread`, `Pin as agent`, `Settle thread`, `Snooze` or `Auto-settle behavior`.
- **Details.** Click the agent row to open it. The details pane has a `Pinned as agent` row with a button named `Unpin`. The pane is open by default, but a pane closed on a thread stays closed for that thread, so press `node $T3V browser click --role button --name "Toggle thread details panel"` when the row is missing.
- **Unmark.** Run `node $T3V browser click --role button --name "Unpin"`, or `Unpin agent` from the menu. The thread returns to Active, the group disappears when it is empty, and the outcome query shows `tags` `[]` and `pinned_at` `null`.
- **Collapse.** Run `node $T3V browser click --role button --name-prefix "Agents "`, then `node $T3V browser goto /`. The header stays collapsed and shows only the open agent, if one is open, as every shelf does. Click it again to expand.
- **Mark from Settled.** Run `node $T3V browser click --role button --name-prefix "Settled "` to expand it, right-click a settled row such as `Tag the weekly build,` and choose `Pin as agent`. The thread moves straight into **Agents**, and the outcome query shows `settled_override` `active`, `pinned_at` set and `tags` `["agent"]`. Run `node $T3V browser goto /` and `browser wait --role button --name-prefix "Agents "`. The thread is still in **Agents**.

Status on agent rows:

- **Input.** Start a thread that waits on a question: `node apps/server/src/bin.ts thread start --base-dir .t3 --provider devReplay --model question --title "Lead: on-call triage" .t3/demo-projects/api-server "go"`. Mark it with `Pin as agent`. `node $T3V browser wait --role button --name-prefix "Lead: on-call triage, Input"` finds it, and `browser shot <dir>/status-input` shows `Input` in the row's time slot. It waits until someone answers, so the screenshot is stable. Delete the thread from its menu afterwards (`Delete`, then `browser click --role button --name "Confirm"`).
- **Working.** With an agent on the `multi-turn` scenario, read its id with `node $T3V outcome sql "select thread_id from orchestration_v2_projection_threads where title = 'Lead: release train'"`, then run `node apps/server/src/bin.ts thread send --base-dir .t3 <thread id> "go" &` and at once `node $T3V browser wait --role button --name-prefix "Lead: release train, Working" --timeout 20000`. The wait prints `found`. The Replay turn ends in about a second, too soon for a screenshot, and the row then moves to the top of **Agents**, because it has the newest activity.

Locked paths:

- **Pin and settle shortcuts.** As a control, open a plain thread with `browser click --role button --name-prefix "<plain title>,"` and press `node $T3V browser press Control+Shift+p`. The outcome query shows it pinned. Press it again to unpin it. Then open an agent the same way and press `Control+Shift+p` and `Control+Shift+s`. The outcome query still shows `pinned_at` set, `settled_override` `null` and `tags` `["agent"]`. On macOS the keys are `Meta+Shift+p` and `Meta+Shift+s`.
- **Bulk menu.** Run `node $T3V browser click --role button --name-prefix "<agent title>," --modifiers Control`, then the same on a plain row, then right-click the plain row. The menu offers `Settle (2)`, `Regenerate titles (2)`, `Mark unread (2)` and `Delete (2)`, with no pin or snooze item. Choose `Settle (2)`. The plain thread's `settled_override` becomes `settled`, and the agent keeps `pinned_at` set, `settled_override` `null`, no snooze and its tag. Un-settle the plain thread from its menu (`Un-settle thread`) afterwards.
- **Drags.** All of a drag's ends must be on screen, so first scope the list: right-click an api-server agent and choose `Filter by api-server`, and pin one plain api-server thread with `Pin thread` so Pinned has a row. Then run `node $T3V browser drag --role button --name-prefix "<agent title>," --to-role button --to-name-prefix "<target>"` for each target: the pinned row (`Rate-limit the search API,`), an Active row (`Retry webhook deliveries with backoff,`) and the Settled header (`Settled `). The outcome query for the agent is unchanged after each. As a control, drag a plain row to `--to-name-prefix "Settled "`, and it settles. Drag the agent with `--to-role region --to-name "Message input"`, and the composer gains a link named `Thread, <agent title>`. Drag a plain row to `--to-name-prefix "Agents "`, and its outcome query shows no tag and no pin. Undo the control settle, the pin, the composer text (`Control+a`, `Backspace`) and the scope (`Show all projects` in a row menu).

Filters:

- **Search.** Run `node $T3V browser fill --role combobox --name "Search threads" --value "<part of an agent title>"`. The `Thread search results` listbox has the agent as an option. Clear it with `node $T3V browser click --role button --name "Clear thread search"`.
- **Keyboard.** Arrow keys move focus only while a row has it, and clicking a row moves focus into the composer. Right-click the last Active row, then `node $T3V browser press Escape`, which leaves focus on that row. `browser press ArrowDown` twice moves focus past the `Agents` header onto the first agent, and `browser press Enter` opens it: the `Thread breadcrumb` in `browser aria` names it. Right-click the last agent, press `Escape` and `ArrowDown`, and focus is on the `Settled` header. `Enter` then toggles it, which `browser aria` shows as `button "Settled <n>"` with or without `[expanded]`.
- **Project scope.** Right-click an agent and choose `Filter by <project>`. **Agents** lists only that project's agents, and `combobox "Filter threads by project: <project>"` names it. `Show all projects` in a row menu clears it.
- **Hidden tags.** Run `node $T3V settings 'hiddenThreadTags=["agent"]'`. **Agents** still shows. Run `node $T3V settings hideTaggedThreads=true`. **Agents** and its rows are gone. Reset with `node $T3V settings hideTaggedThreads=false 'hiddenThreadTags=[]'`.
- **Folder mode.** Run `node $T3V browser goto /settings/labs`, `node $T3V browser click --role switch --name "Boring sidebar (group by project)"` and `browser goto /`. **Agents** sits after the last project folder and before **Snoozed** and **Settled**. Click the switch again to go back.

## Gotchas

- The header's accessible name is `Agents <count>`, so target it with `--name-prefix "Agents "`.
- A row's accessible name is `<title>, <status>, <project>`, or `<title>, <project>` with no status, so target it with `--name-prefix "<title>,"`.
- **Pin as agent** pins first, then tags. **Unpin agent** removes the tag, then unpins. When the second command fails, the thread is left in **Pinned**, plain, and the outcome query shows the pin without the tag or the reverse.
- Pinning wakes a settled or snoozed thread, so marking one from `Settled` moves it straight into **Agents** and clears its settle. That is why the check reads `settled_override`, not the 25-newest settled cap: an agent is never a settled thread.
- `browser drag` refuses a target that is off screen. A sidebar of 20 threads is taller than the viewport, so scope or collapse it first.
- The collapse state lives in the browser profile's localStorage under `t3code:sidebar:agents-expanded`, so it survives `browser close` and `browser open`. Expand the group again before a recipe that expects it open.
- `hideTaggedThreads` set to `true` together with `agent` in `hiddenThreadTags` hides every agent thread. Neither key alone does. Both live in the server's `settings.json` with no settings screen. Set them back after a hidden-tag check.
- The dev server adds the checkout's `apps/server` as a project named `server` at every start. Its rows show the checkout's real branch and pull request, so screenshots for a review or a video use the seeded demo projects.
