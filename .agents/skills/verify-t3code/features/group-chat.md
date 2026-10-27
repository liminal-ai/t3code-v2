# Group chat

A group chat puts several T3 threads in one conversation. The user opens Group chat from the sidebar footer, which swaps the thread sidebar for a group sidebar, creates a group from existing threads, and sends one message that each ticked member gets as a queued turn in its own thread. Each member's reply comes back into the group under its handle. Back in the group sidebar's footer returns to the last thread, even after a reload, and Escape leaves the page unless a dialog, menu or lane selection takes it first.

## Sub-features

- `gc-open` opens `/group-chat` from the footer's `Group chat` button and swaps in the group sidebar, whose footer holds only `Back`.
- `gc-create` creates a group from one or more threads in the `New group chat` dialog and opens it at `/group-chat/<group-id>`.
- `gc-send` sends a message to the ticked members. With nobody ticked it is only logged.
- `gc-reply` shows each member's delivery chip moving through `queued in the thread`, `responding` and `replied`, and its reply under its handle.
- `gc-envelope` opens the envelope a member received from its delivery chip.
- `gc-back` returns to the last thread from `Back`, after a full page load of a group chat URL too.
- `gc-escape` leaves Group chat on Escape when nothing else takes the key, and closes an open dialog without leaving.

Discussions, Lanes, Manage, Settle and external members are in `docs/user/group-chat.md`. This recipe does not drive them.

## How to get to it (user POV)

- On a thread page, choose the `Group chat` icon, the last icon in the sidebar footer after `Settings`, `Pull requests` and `Usage`.
- Load `/group-chat` or `/group-chat/<group-id>` directly.

## Driving it with t3v

Preconditions:

- `node $T3V doctor` prints no `FAIL`, and the dev server was not started with `T3CODE_GROUP_CHAT=off`.
- Two threads, A and B, in a disposable project, have each finished one turn on a fast model such as Claude Haiku 5.5. Follow [agent-turn.md](./agent-turn.md). Note each title from its sidebar card and each id from its URL. Titles come from the first message and can repeat, so the steps below pick a thread by its id when they do.
- Thread A is open, and both threads are idle.

- **Open Group chat.** Choose the footer icon. Run `node $T3V browser click --role button --name "Group chat"` and `node $T3V browser wait --role button --name "New group chat"`. The click prints a URL ending `/group-chat`. The sidebar is now `navigation "Group chat"`, with `New group chat` and an `Active` section reading `No active group chats`, and its footer holds only `Back`. The page heading reads `Group chat` over `No group chats yet`.
- **Create a group.** Open the dialog, name the group, tick both threads and create. Run `node $T3V browser click --role button --name "New group chat"`, `node $T3V browser fill --role textbox --name "Title" --value "Verify group"`, `node $T3V browser click --role checkbox --name-prefix "Select <title A>" --in "<thread-a-id>"`, `node $T3V browser click --role checkbox --name-prefix "Select <title B>" --in "<thread-b-id>"` and `node $T3V browser click --role button --name "Create with 2 threads"`. Before the ticks the submit button reads `Create with no threads` and is disabled. After the click the dialog closes, the URL ends `/group-chat/<group-id>`, the breadcrumb reads `Group chat` then `Verify group`, and the header carries `Chat`, `Lanes`, `Settle`, `Discuss` and `Manage`. For a one-member group, tick only A and choose `Create with 1 thread`. `Discuss` then stays disabled.
- **Read the handles.** Run `node $T3V browser aria <dir>/group-created`. The composer lists one `checkbox "Address @<handle> @<handle>"` per member, both unticked, and the hint under it starts `Nobody ticked`. Use those two handles, `<a>` and `<b>`, below.
- **Send.** Tick everyone and send one line. Run `node $T3V browser click --role button --name "Tick all"`, `node $T3V browser click --role textbox --name "Message"`, `node $T3V browser type "Reply with the single word pong. Do not call tools or change files."` and `node $T3V browser press Enter`. Before the send, the hint reads `Sends one catch-up envelope to everyone. Ticks stay after sending.`. After it, your message shows with two chips, `@<a> · …` and `@<b> · …`, and a waiting row per member.
- **Replies arrive.** Wait for both chips to read `replied`. Run `node $T3V browser wait --role button --name "@<a> · replied" --timeout 180000` and `node $T3V browser wait --role button --name "@<b> · replied" --timeout 180000`. Each member's reply, `pong`, shows under its `@<handle>` label, and the waiting rows are gone.
- **Escape closes a dialog and stays.** Open A's envelope, then press Escape. Run `node $T3V browser click --role button --name "@<a> · replied"`, `node $T3V browser shot <dir>/envelope`, `node $T3V browser press Escape` and `node $T3V browser wait --role navigation --name "Group chat"`. The dialog `Envelope sent to @<a>` reads `replied` and shows `Dispatch` `received` (stored as `accepted`), `Covers` `#1 to #1`, a `T3 run` id, and the envelope text holding your line. After Escape the dialog is gone and the page is still `Verify group`.
- **Back after a full load.** Load the group page fresh, then choose Back. Run `node $T3V browser goto /group-chat/<group-id>`, `node $T3V browser click --role button --name "Back"` and `node $T3V browser wait --role textbox --name "Message <title A>"`. The click prints a URL ending `/<thread-a-id>`, the sidebar is `navigation "Threads"` again, and thread A is open, not a new draft.
- **Escape leaves.** Open Group chat with a click, so the page has history behind it. Open a dialog, press Escape, then press Escape again. Run `node $T3V browser click --role button --name "Group chat"`, `node $T3V browser click --role button --name "New group chat"`, `node $T3V browser press Escape`, `node $T3V browser wait --gone "Pick the T3 threads that join. Each gets a short handle you can rename later."`, `node $T3V browser wait --role navigation --name "Group chat"`, `node $T3V browser press Escape` and `node $T3V browser wait --role textbox --name "Message <title A>"`. The first Escape closes only the dialog, and the page reads `Pick a group chat`. The second Escape returns to thread A.
- **Proof.** Take `node $T3V browser shot <dir>/<step>` after each step above, and `node $T3V browser aria <dir>/replied` once both chips read `replied`. Grade it with the outcome check. `outcome sql` reads only `statev2.sqlite`, so read the module's own store read-only with `sqlite3 -readonly -header -column <worktree>/.t3/userdata/group-chat/groupchat.sqlite "select g.title, m.handle, m.thread_id, d.state, d.dispatch, d.run_id, d.message_id, r.display_text as reply from groups g join members m on m.group_id = g.id and m.removed_at is null left join deliveries d on d.member_id = m.id left join messages r on r.id = d.reply_message_id where g.id = '<group-id>' order by m.added_at, d.created_at"`. It prints two rows, one each for threads A and B, with state `replied`, dispatch `accepted`, a run id, a message id and the reply `pong`. `sqlite3 -readonly -header -column <same file> "select seq, kind, json_extract(author_json, '$._tag') as author, recipients_json, display_text from messages where group_id = '<group-id>' order by seq"` prints `1` `chat` `operator` with both member ids and your line, then two `reply` rows by `member`. Check the member threads in T3's own store with `node $T3V outcome sql "select run_id, thread_id, status from orchestration_v2_projection_runs where run_id in ('<run a>', '<run b>')"`, which shows both runs `completed` on threads A and B, and `node $T3V outcome sql "select thread_id, role from orchestration_v2_projection_messages where message_id in ('<message a>', '<message b>')"`, which shows each envelope as a `user` message in its member's thread.

## Gotchas

- Handles come from thread titles, and titles come from each thread's first message, so read the handles from the `Address @<handle> @<handle>` checkboxes rather than guessing them. Target one with `--name-prefix "Address @<handle>"`.
- A picker checkbox's accessible name is the whole row: `Select <title> <title> <project> <thread id> <status> <activity> Updated <when>`. Match it with `--name-prefix "Select <title>"`, and add `--in "<thread id>"` because two threads can share a title.
- A new group starts with nobody ticked. A message sent like that is only logged, marked `Logged only · nobody addressed`, and starts no member turn. Choose `Tick all` or an `Address @<handle>` box first. Ticks are kept per group in the browser's `localStorage`, so a later drive in the same profile may start ticked.
- Do not type `@` in the drive's message. It opens the `Mention a member` list, and Enter then picks a member instead of sending.
- A chip's accessible name is `@<handle> · <state>`, with a middle dot (U+00B7), and it changes as the state moves. t3v matches names exactly, so wait on the full `replied` name, or target any state with `--name-prefix "@<handle> · "`.
- On the group chat pages the name `Group chat` also labels the sidebar navigation and the page heading, so keep `--role button` for the footer icon on a thread page. On the group chat pages the footer shows `Back` in place of the icons.
- `New group chat` stays disabled until the group chat data loads. Wait for it before clicking. With `T3CODE_GROUP_CHAT=off` it never enables, and the page reads `Group chat is turned off on this server.`. A store that cannot open reads `Group chat could not open its data. The server log says why.`.
- Escape steps back one history entry rather than straight to the last thread. From `/group-chat/<group-id>` reached from `/group-chat`, it lands on `/group-chat`. On a page loaded fresh, by `browser goto`, a pasted URL or a new tab, there may be no entry behind it, so Escape can open `/`, a new draft, while `Back` returns to the last thread. Drive the Escape exit after an in-app click, as above.
- In the `Lanes` view, Escape first clears a selected card, and only a second Escape leaves.
- The thread picker lists only threads on the server that serves the page. It never lists archived threads, and it hides subagent threads until `Show subagents` is on.
- Each reply is a real agent turn in the member's thread. An idle thread starts the envelope at once. A busy one queues it behind its own run, and the waiting row reads `busy with its own run`. Keep members on a fast model and the prompt to one word.
- `browser wait --text` matches your own message, and the group shows your line, so never wait on `pong`. Wait on the chips.
- The member thread's timeline shows the envelope, which explains the group and labels your line, not your bare text. The group's own `messages` table holds your text, and `statev2.sqlite` holds the envelope.
- Open `groupchat.sqlite` read-only only. The dev server holds it, and `node $T3V outcome sql` cannot reach it.
