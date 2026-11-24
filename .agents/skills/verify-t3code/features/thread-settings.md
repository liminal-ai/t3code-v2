# Thread settings

The thread details panel shows a **Thread settings** card with the fork's own per-thread settings, so a thread can be tuned without a release. Its first group is **Limbase compaction**, on a thread that runs on Limbase or whose instance has a Limbase home. The group has two fields, **Compact at** and **Down to**. Each takes tokens, such as `700k`, or a share of the model's context window, such as `70%`. An empty field inherits, and its placeholder says what it inherits, from the instance or from Limbase's default for the model. A Claude instance with a Limbase home has the same two fields in Settings > Providers, below **Limbase home**, and every thread on the instance inherits them. A thread on any other instance shows no card.

## Sub-features

- `settings-card` shows the card only on a thread whose instance has a Limbase home or whose provider thread has a Limbase thread, with each empty field's inherited value as its placeholder and the policy Limbase holds now beside the group's name.
- `settings-guard` refuses a value before it is sent: **Down to** under 24k, **Down to** not below **Compact at**, and a **Compact at** past the model's window. A value it cannot read asks for tokens or a share.
- `settings-save` saves a value, gives the Limbase thread its new policy at once, and shows Limbase's own refusal when the service refuses it.
- `settings-warning` warns that **Down to** at 300k or more turns Limbase's cold return off, and that an inherited **Compact at** past the window makes Limbase compact at its hard limit.
- `settings-instance` edits **Limbase: compact at** and **Limbase: down to** on a Claude instance with a Limbase home, and a thread gets the change at its next turn with no restart, even while its session stays open.
- `settings-seed` keeps 700k and 100k on each Claude instance that had a Limbase home when the server first started with this build, and on no instance made later.

## How to get to it (user POV)

- Open a thread on a Limbase instance. The **Thread settings** card is in the thread details panel, below the workspace rows.
- Settings > Providers, select a Claude instance with a **Limbase home**. **Limbase: compact at** and **Limbase: down to** follow **Limbase home**.

## Driving it with t3v

Preconditions:

- A Limbase lane and a Claude Code binary at the host's tested version, per `features/limbase-thread.md`.
- To drive `settings-seed`, add the Limbase instance before the first `up` of a fresh `.t3`, so the store's first creation sees it: `node $T3V settings providerInstances='{"claudeLimbase":{"driver":"claudeAgent","displayName":"Claude Limbase","config":{"limbaseHome":"<lane>/home","binaryPath":"<claude binary>","idleCompaction":"off"}}}'`, then `node $T3V up`.
- `node $T3V doctor` prints no `FAIL`, and a disposable git project is added with `node apps/server/src/bin.ts project add --base-dir <worktree>/.t3 <folder>`.
- One finished turn on the instance, from the project folder: `node <worktree>/apps/server/src/bin.ts thread start --base-dir <worktree>/.t3 --provider claudeLimbase --model claude-haiku-5-5 --wait --json . "Read README.md with your shell tool and quote it."`. `TH` is its `threadId`, and `LB` is the thread's Limbase id: `node $T3V outcome sql "select json_extract(payload_json,'\$.nativeMetadata.limbaseThreadId') from orchestration_v2_projection_provider_threads where thread_id='<TH>'"`. `POLICY` is `MEMBASE_HOME=<lane>/home pnpm exec limbase thread show <LB> | grep "compact policy"`, run from the lane's Limbase checkout.

- **Seed.** `node $T3V outcome sql "select scope, owner_id, settings_json from fork_settings"` prints the instance row with `compactAt` 700000 and `downTo` 100000 tokens, and the dev log has `fork-settings.seeded`. `POLICY` prints `trigger 700000 target 100000`. Add a second instance with a Limbase home and restart with `node $T3V down` and `node $T3V up`. That instance has no row.
- **Card.** Click the thread in the sidebar with `node $T3V browser click --text "<thread title>"`. `node $T3V browser wait --text "Thread settings"` finds the card, which shows `Limbase compaction` with `700k → 100k`. **Compact at** has the placeholder `Instance: 700k`, and **Down to** has `Instance: 100k`. The line under the fields names the model and its window.
- **Guard.** `node $T3V browser fill --role textbox --name "Down to" --value "800k"`, then `browser press Enter`. The card shows `Down to (800k) must be below compact at (700k).` and `POLICY` does not change. `20k` shows `Down to must be at least 24k.`, and `abc` shows `Write tokens, like 700k, or a share of the window, like 70%.`
- **Save.** Fill **Down to** with `15%` and press Enter. The card shows `700k → 150k` on a 1M window, `POLICY` prints `trigger 700000 target 150000` before any turn runs, and `fork_settings` has the thread's row with `{"downTo":{"percent":15}}`.
- **Clear.** Fill **Down to** with an empty value and press Enter. The field shows its placeholder again, and the thread's row is gone from `fork_settings`.
- **Instance.** `node $T3V browser goto /settings/providers`, `browser click --role button --name "Select Claude Limbase"`, and `browser wait --text "Limbase: compact at"`. The two fields show `700k` and `100k`. Fill **Limbase: compact at** with `60%` and press Enter. `POLICY` does not change yet. Note `grep -c '"query.open"'` on the thread's events log, `.t3/userdata/logs/provider/events.<TH>.log`. Run a turn with `thread send --base-dir <worktree>/.t3 --wait --json <TH> "Say ok."` and `POLICY` prints `trigger 600000`, with the thread's own **Down to** kept, and the `query.open` count does not grow, so the change reached the live session.
- **Plain.** A thread on a Claude instance with no Limbase home shows no **Thread settings** card, and its instance has no Limbase rows.

## Gotchas

- The seed runs only when the server first creates the `fork_settings` table. On a `.t3` that already has the table, adding an instance never seeds it, which is the point. To drive the seed again, use a fresh `.t3`.
- The card's window comes from the Claude model catalog. A model that is not in the catalog shows `Shares and defaults resolve once the model reports its context window.` until a turn reports one, and the thread's policy is set at that turn.
- Limbase's own refusal reaches the card as `Limbase: the service refused the compaction policy (limbase call failed: <tag>)`. The host's call reports only the error's tag, not its text.
- A save applies at once only on a thread that already has a Limbase thread. On a new thread the policy goes into Limbase's `CreateThread` at its first turn.
