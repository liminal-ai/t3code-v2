# The Agents group

A user marks a long-running thread, such as a lead thread that delegates work, with **Pin as agent** from its menu. The thread leaves every other sidebar section and shows as one line in a collapsible **Agents** group directly above **Working**, newest activity first, with its status in place of its time. The details pane shows **Pinned as agent** with **Unpin**, and **Unpin agent** in the menu does the same.

## Sub-features

- `agents-mark` adds **Pin as agent** under **Pin thread** and moves the thread into **Agents**.
- `agents-unmark` returns the thread to Active from **Unpin agent** in the menu or **Unpin** in the details pane.
- `agents-group` places the group above Working, or above Snoozed and Settled in project-folder mode, collapses it and keeps the collapse across a reload.
- `agents-row` shows one line per agent, with its status (Working, Approval, Input, Failed) in the time slot and no hover actions or pin indicator.
- `agents-locked` keeps every other path from pinning, settling or snoozing an agent: menus, the pin and settle shortcuts, bulk actions and drags.
- `agents-filters` respects project scope, hidden tags and archive, and keeps agents in sidebar search and keyboard navigation.

## How to get to it (user POV)

- Right-click a thread row in the sidebar, or open the thread menu in the chat header, and choose `Pin as agent`.
- Choose `Unpin agent` from the same menus, or `Unpin` on the `Pinned as agent` row of the details pane.
- Click the `Agents` header to collapse or expand the group.

## Driving it with t3v

Preconditions:

- `node $T3V doctor` prints no `FAIL`.
- At least three finished threads in a disposable project, made on the free Replay provider: `node apps/server/src/bin.ts thread start --base-dir .t3 --provider devReplay --model multi-turn --title "<title>" --wait <project folder> "go"`. `demos/agents-group.demo.mjs` exports a `seed` that builds 22 such threads in three projects and settles five.

- **Mark.** Right-click a row and choose `Pin as agent`. Run `node $T3V browser click --role button --name-prefix "<title>," --button right`, check `node $T3V browser aria <dir>/menu` lists `menuitem "Pin as agent"` right after `menuitem "Pin thread"`, then run `node $T3V browser click --role menuitem --name "Pin as agent"`. The row leaves Active, and `node $T3V browser wait --role button --name-prefix "Agents "` finds the header, whose name ends in the agent count.
- **Outcome.** Run `node $T3V outcome sql "select title, json_extract(payload_json,'\$.tags') tags, json_extract(payload_json,'\$.pinnedAt') pinned_at from orchestration_v2_projection_threads where title = '<title>'"`. `tags` is `["agent"]` and `pinned_at` is set.
- **The group.** Scroll the sidebar to its end with `node $T3V browser scroll 3000 --at 128,500` and take `browser shot <dir>/group`. **Agents** sits above **Working** when a thread is running, else above **Snoozed** and **Settled**. Each agent is one line.
- **Agent menu.** Right-click the agent row. The menu has `Unpin agent` and no `Pin thread`, `Unpin thread`, `Pin as agent`, `Settle thread`, `Snooze` or `Auto-settle behavior`.
- **Details.** Click the agent row to open it. The details pane has a `Pinned as agent` row with a button named `Unpin`.
- **Unmark.** Run `node $T3V browser click --role button --name "Unpin"`, or `Unpin agent` from the menu. The thread returns to Active, the group disappears when it is empty, and the outcome query shows `tags` `[]` and `pinned_at` `null`.
- **Collapse.** Run `node $T3V browser click --role button --name-prefix "Agents "`, then `node $T3V browser goto /`. The header stays collapsed and shows only the open agent, if one is open, as every shelf does.
- **An old thread survives a reload.** With more than 25 settled threads, expand `Settled`, mark the oldest one with `Pin as agent`, then run `node $T3V browser goto /`. The thread is still in **Agents**, and the outcome query shows it pinned with the tag.
- **Drags.** `node $T3V browser drag --role button --name-prefix "<agent title>," --to <x>,<y>` onto the Pinned area, the Active list or the Settled header changes nothing in the outcome query. Dropped onto the composer, the agent becomes a context chip. An ordinary thread dropped on the Agents header is not marked.

## Gotchas

- The header's accessible name is `Agents <count>`, so target it with `--name-prefix "Agents "`.
- A row's accessible name is `<title>, <status>, <project>`, so target it with `--name-prefix "<title>,"`.
- Pinning wakes a settled or snoozed thread, so marking one from `Settled` moves it straight into **Agents**. The server sends only the 25 newest settled threads to the client, plus every pinned one, so an old thread survives a reload only because it is pinned. The old-thread check needs more than 25 settled threads; the demo seed settles five, so settle more from the menu.
- The collapse state lives in the browser profile's localStorage under `t3code:sidebar:agents-expanded`, so it survives `browser close` and `browser open`. Expand the group again before a recipe that expects it open.
- `hiddenThreadTags` with `agent` and `hideTaggedThreads` on hides every agent thread. Set them back after a hidden-tag check.
- The dev server adds the checkout's `apps/server` as a project named `server` at every start. Its rows show the checkout's real branch and pull request, so screenshots for a review or a video use the seeded demo projects.
