# Start a thread and run a turn

A user starts a thread in a project, picks the provider and model in the composer, sends a message, and watches the agent's turn run until it ends with a reply. The thread gets a title from its first message.

## Sub-features

- `turn-new-thread` opens a draft thread in a chosen project.
- `turn-model` picks a provider and model in the composer's model picker.
- `turn-send` sends the message and shows `Working` while the run is live.
- `turn-end` shows the agent's reply and drops `Working` when the run ends.
- `turn-title` renames the thread from its first message.

## How to get to it (user POV)

- Choose the `New thread` pencil button beside `Search` in the sidebar, then pick the project.
- Add a project, which opens a draft in it. See [projects.md](./projects.md).
- Choose `New thread in <project>` from a thread's breadcrumb.

## Driving it with t3v

Preconditions:

- `node $T3V doctor` prints no `FAIL`.
- A disposable project, here `demo-project`, is in the sidebar.
- The provider you pick shows `Authenticated` in Settings > Providers. A fresh dev server's Cursor is not signed in: sign it in from **Settings > Providers > Cursor** (**Sign in**, or paste a key into **Cursor API key**), or report the Cursor turn as unreachable for that reason. Never copy credentials from prod into a dev server's `.t3`.

- **New thread.** Choose `New thread` and pick the project. Run `node $T3V browser click --role button --name "New thread"`, `node $T3V browser type "demo-project"` and `node $T3V browser press Enter`. The breadcrumb reads `demo-project / New thread` and the heading asks `What should we build in demo-project?`.
- **Pick a model.** Open the picker, which is named after the current model, choose a provider, then a model. Run `node $T3V browser click --role button --name "GPT-6-Astra"`, `node $T3V browser click --role button --name "Claude"` and `node $T3V browser click --text "Claude Haiku 5.5"`. The picker button now reads `Claude Haiku 5.5`.
- **Send.** Type and send. Run `node $T3V browser click --role textbox --name-prefix "Message"`, `node $T3V browser type "Reply with the single word pong. Do not call tools or change files."` and `node $T3V browser press Enter`. The message appears in the timeline and `Working` appears under it.
- **Run ends.** Wait for the turn. Run `node $T3V browser wait --gone "Working" --timeout 180000`. The reply `pong` shows, and the sidebar and breadcrumb carry a new title such as `Pong Reply`.
- **Proof.** Run `node $T3V browser shot <dir>/turn-ended` and `node $T3V browser text`. Grade it with `node $T3V outcome sql "select t.title, t.provider_instance_id, r.status from orchestration_v2_projection_threads t join orchestration_v2_projection_runs r using (thread_id) where t.thread_id = '<thread-id>'"`, which shows `claudeAgent` and a `completed` run.

## Gotchas

- Choosing a project's name in the sidebar opens its latest thread, not a new one. `New thread` is the unlabeled pencil icon beside `Search`, and its accessible name is `New thread`.
- Each sidebar card is a thread. The project name sits on top and the thread title under it, so two threads in one project differ only by title.
- The picker button's name is the current model, so it changes once you pick one. Read it from the composer first.
- The composer's accessible name is `Message <thread title>`, such as `Message New thread` on a draft, so the recipes target it with `--name-prefix "Message"`.
- An option's accessible name joins the model, its badges and the favorite control, such as `Claude Haiku 5.5 New model Claude Add to favorites`, and the `New model` badge comes and goes. Click the model's visible text instead of the option's full name.
- The draft's URL is `/draft/<id>` until the first send. The thread id, which outcome checks need, is the last URL segment after that.
- `browser wait --text` matches your own message as soon as it is sent. Wait with `--gone "Working"`.
- In the proof run the draft heading `What should we build in demo-project?` never counted as visible to `browser wait --text`. Wait on `--role textbox --name-prefix "Message"` instead.
- After a turn, a stray `=` glyph sits in the timeline's left margin at about (271, 476) in a 1440x900 viewport. It is the app's, and harmless to a drive.
