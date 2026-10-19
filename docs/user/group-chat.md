# Group chat

A group chat puts several of your threads in one conversation. You write once, tick the members you want an answer from, and each of them gets your message as a turn in its own thread. Their replies come back into the group under short handles, so the members can read each other and you can read them all in one place. Open it from **Group chat** in the sidebar footer, next to **Settings** and **Usage**.

Group chat lives on the T3 server that serves the page. The hosted client at app.t3.codes, and a desktop app that only has remote environments, say "Group chat works only on the T3 server that serves this page." The mobile app has no group chat section.

## Start a group

Pick **New group chat**, give it a title, and choose one or more threads. A group of one is a plain catch-up channel to that thread. A discussion needs two. The picker finds a thread by its title, by its full id, or by the first six or more characters of its id. Subagent threads stay hidden until you turn **Show subagents** on. Archived threads never appear, because a message to one can never be delivered.

Each member gets a handle made from its thread title, such as `@alpha`. A handle is 1 to 16 characters of lower-case letters, digits, `-` and `_`, and starts with a letter or digit. Change it in **Manage**. Words the app uses for other things, such as `operator`, `everyone` and `system`, are refused.

A thread can be in several groups. Each group keeps its own handles and its own log.

## Address members and send

Tick the members you want a reply from, or type `@` and pick a handle, which ticks that member for you. **Tick all** and **Clear** set every box at once. Ticks stay set after you send. Enter sends and Shift+Enter adds a line.

A message with nobody ticked is only logged. No member thread starts a run, and every member sees that message in its next envelope.

Group messages never steer a run that is already going. A message to a busy thread waits in that thread's queue like any other queued message, so **Stop**, **Resume**, edit, delete and reorder in the thread work on it as they do on your own messages.

## What a member receives

A member does not see the group live. Each time you address it, the app builds one envelope with every group message since that member last heard from the group, oldest first, each labelled with its sender. The member's own earlier replies are left out. The first envelope also explains the group and names the other members, and the first envelope to a member you add later carries the history up to that point.

To see exactly what a member received, open the delivery chip under your message. The dialog shows the envelope text and the range of messages it covers.

Replies render as Markdown. A reply over 4,000 characters is cut to a preview with **Show all**. Members' tool calls do not show in the group. Open the thread for those.

## Delivery states

Each addressed member gets a chip under your message, and a row in the chat while its reply is on the way. The chip reads **queued in the thread** once the thread has accepted the envelope and nothing holds it, **responding** once it runs, and **replied** when the reply is in the group. **Failed** shows the reason and offers **Retry**, which sends the same envelope again. **Stop** on a waiting row withdraws the envelope if it has not started yet.

A delivery that waits shows why, with a link to the thread:

- **busy with its own run**. The thread is in a turn of its own. The envelope runs next.
- **waiting for its earlier envelope**. An earlier group message to this member has not finished. One envelope at a time goes to each thread.
- **queue held in T3**. T3 holds that thread's queue. **Stop** in the thread does that, and so does a run that failed, a worktree that is missing, or a provider that is turned off. **Resume thread** in the thread releases the whole queue, this envelope included, in the order it was queued.
- **waiting on a question**. The member asked you something. Answer it in the group chat, under the member's row, or in the thread.
- **waiting on an approval in T3**. Give the approval in the thread.
- **stopped in T3**. You pressed **Stop** on the reply itself. What the member wrote before the stop shows in the group as a note that counts for nothing. **Retry** asks again. A new message you address to that member goes out as usual; the stopped envelope waits for **Retry**.

If you delete the envelope from the thread's queue in T3, the delivery reads **removed from the thread's queue in T3**. If you edit it there, the envelope dialog shows the text that ran, marked **edited in T3**.

## Discussions

A discussion lets the members talk among themselves for a bounded number of rounds. Pick **Discuss**, choose two or more participants, write the topic, and set the round limit.

Round 1 sends every participant the topic at the same time. Each later round sends each participant the other participants' replies from the round before. A message you send during a discussion is logged, ticked members answer it as a turn of their own, and the other participants see it in their next round.

The panel above the composer shows the round, who has replied this round, and who has signed off. A participant signs off by ending its reply with `[[SIGN-OFF]]` alone on the last line. The marker anywhere else, in a code block for example, does not count.

A discussion ends for one of these reasons, and the reason shows in the panel and in the chat:

- **all signed off in round N**. Every participant signed off in the same round.
- **reached N rounds**. The round limit was hit.
- **stopped by operator**. You pressed **Stop** in the panel. No further round starts. A reply already in progress may still arrive, labelled **arrived after Stop, not counted**.
- **fewer than two participants left after removals**. You removed participants until one or none remained. Removing one of three lets the discussion go on with two.

When a participant's reply stops in T3, the round waits. **Retry** on that participant sends the round to it again. **Stop** ends the discussion without it.

A discussion runs on the server. Closing the page does not stop it, and a server restart resumes it where it was.

## Swim lanes

**Lanes** in the group header shows the same log as columns. Your messages are in the first column and each member has a column of its own, with its cards in time order. Read down a column for one member's replies, or across a row to compare what every member said to the same prompt. **Chat** switches back and lands where you were in the conversation. The choice is kept per group.

Click a card to select its turn. The prompt that started the turn gets the accent, a line runs from it to the first reply, and a line in each member's colour runs on to the next reply. Cards outside the turn fade back. `j` and `k`, or the arrow keys, move to the next or previous turn and scroll it into view. Esc clears the selection. **Line up on select** moves the columns so the selected turn's cards start on one line. **Packed** keeps every column as tight as it can be.

A discussion is a section with a divider per round. Select a reply from round 2 on to see what it responded to. A solid line comes from each earlier reply it names with `@`, a dashed line from one it only saw, and the toolbar counts them, such as "names 1 of the 2 round 1 replies it saw".

A card over 4,000 characters collapses to a preview with **Show all**. Scroll to the top to read older messages.

## Settle, manage, and delete

**Settle** moves a group to the **Settled** section of the group sidebar. Sending into a settled group brings it back. **Manage** renames the group, edits handles, adds and removes members, and settles or unsettles each member's thread. A thread that refuses to settle, because it has an open workflow for example, shows its reason as T3 gave it.

Removing a member keeps its messages in the log. Add the same thread back and it keeps its place in the history and gets an envelope that catches it up on what it missed. It keeps its handle too, unless another member has taken that handle meanwhile; then it gets a new one.

**Delete** removes the group and its log after you confirm. The member threads are never deleted, archived or changed.

## Turn group chat off

Start the server with `T3CODE_GROUP_CHAT=off`. The sidebar entry stays, and the page says group chat is turned off. Every delivery and discussion stays where it was and carries on when the server starts without the flag.
