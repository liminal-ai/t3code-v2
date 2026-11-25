---
name: verify-t3code
description: Launch this worktree's T3 Code dev server on its own state, drive the web UI the way a user does (T3's Browser panel from inside a T3 thread, or the bundled Playwright helper from anywhere), and capture proof. Use to verify any user-visible change to the web or desktop UI, the server's HTTP and WebSocket API, or the MCP tools agents get in a thread, and before a review or merge. Use test-t3-mobile for native mobile.
---

# Verify T3 Code

T3 Code is a web app for running coding agents in threads. The web UI is the primary surface, and the desktop app wraps it. The server's HTTP and WebSocket API and the MCP tools an agent gets inside a thread sit behind it. Native mobile is out of scope here. Use [test-t3-mobile](../test-t3-mobile/SKILL.md) for it.

Read [features/README.md](features/README.md) before you drive. It indexes one recipe per feature, and the feature you changed is the one a review drives.

## Two rules that protect the live install

1. **Never start a server against live T3 data.** `~/.t3/userdata` is the developer's T3 install, and on this machine v2 prod runs from `~/lim-v2/service/t3code/prod/data` on port 13987. Read and copy from them only. Never start a server on them, never open them read-write, never clean them up.
2. **Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev.** Dev is single-origin, and Vite proxies `/api`, `/ws`, `/oauth` and `/.well-known` to the server. Setting either bakes localhost into the bundle and breaks every remote browser.

## The helper

`scripts/t3v.mjs` launches, checks, drives and stops one dev server for the worktree that holds it, whatever directory you run it from. Run it with no arguments for its usage. Set the run once per shell, and every path below is under that run:

```bash
export T3V_RUN=<run>          # e.g. the pstack run name, shared by every verifier in it; default verify-t3code
T3V=.agents/skills/verify-t3code/scripts/t3v.mjs
node $T3V <command>
```

- Proof goes to `<main checkout>/.pstack/runs/<run>/proof/`. Git ignores it, it is outside every worktree, and `down` never touches it.
- Scratch goes to `<main checkout>/.pstack/runs/<run>/scratch/t3v/<checkout folder>-<hash of its full path>/`: the dev log, the PIDs, the pairing URL (mode 0600) and the browser profile. `up` prints the path.
- The browser is headless Chromium from the repo's own `playwright`, started once by `browser open` and reached over CDP by every later command, so menus and focus survive between commands.

## Launch

1. Check the worktree is set up. While `.t3/setup-running` names a live PID, wait for it and do not run `vp i`. `.t3/setup-failed` holds the error tail. With no marker and broken module resolution, run `vp i`.
2. `node $T3V up` runs `vp run dev` in its own process group and waits for the pairing URL and both ports. It prints the `[dev-runner]` line with the real ports and state dir. Ports derive from the worktree path, so they stay stable across restarts, but an occupied port shifts them, so always read that line.
3. Set what the feature needs with `node $T3V settings <key>=<value>`. It merges keys into `.t3/userdata/settings.json`, and the server picks the change up without a restart.
4. `node $T3V browser open` pairs the browser with the one-time startup URL and waits for the `Threads` navigation. Then the instance is usable.

Ready means a thread can start. The first agent turn of a recipe proves it. The proof run took 7 seconds from an empty `.t3` to both ports answering.

**Host limits.** Run `df -h /` before a build or an `up`. T3 makes its worktrees, with their `.t3` dev state, under the prod data dir on the prod host's root disk. When that disk fills, every turn in dev and prod fails with only `Provider turn failed`. Remove a worktree when its PR merges. An `up` that fails with `ENOSPC` while the disk has room ran out of inotify watches. `fs.inotify.max_user_watches` is 65536 here, each Claude CLI session holds about 4,000 and each Vite server about 2,300. Stop a session or server you started, or ask Lee to raise the limit.

The state is the worktree's ignored `.t3`. It outranks an ambient `T3CODE_HOME`, and only an explicit `--home-dir` beats it. The first start in a worktree seeds an empty database from `~/.t3/userdata/statev2.sqlite`, read-only. `--no-seed` or `T3CODE_DEV_SEED=0` skips that. This machine has no `~/.t3`, so here the first start begins empty, with one auto-created project named `server` on the worktree's `apps/server`. To start from real data, stop the server and run `vp run migrate-dev-db -- --source ~/lim-v2/service/t3code/prod/data/userdata/statev2.sqlite`. It snapshots the source read-only and keeps recent projects and stopped threads without their schedules, pending work or auth sessions. The proof run did not exercise it. Refresh `statev2.sqlite`, never `state.sqlite`, and copy `secrets` or `settings.json` in only when the flow needs them. Data flows into the sandbox, never back out.

**From inside a T3 thread**, T3's own Browser panel drives the same server. Call `preview_open` with `profileId: "incognito"`, `reuseExistingTab: false` and the pairing URL from the scratch `pairing-url` file, then `preview_wait_for` with `locator: "role=navigation[name='Threads']"`. Use `preview_snapshot` and the interaction tools from there, passing the returned `tabId` on every call. Never pass `save: true` to `preview_snapshot`: it writes the PNG under the hosting T3's own data directory, which on this machine is prod's. The incognito profile keeps the dev cookie away from the profile you use for prod. A one-time token is spent once. `node $T3V pair` mints a fresh one into the same file through `node apps/server/src/bin.ts pair`.

**Sharing over the tailnet** is `vp run dev --share` in the background. Wait for its `pairingUrl:` line, and give that whole URL to an unpaired browser. Do not wire `tailscale serve` by hand or spend the user's pairing link. `T3CODE_DEV_AUTH_TOKEN` in the main checkout's gitignored `.env` is a reusable dev credential across worktrees on one hostname (see `docs/operations/00_development.md`). This machine has none configured. Never commit or print a token or a pairing URL.

## Doctor

`node $T3V doctor` is read-only. Run it first, and again whenever anything looks off. It exits 1 on any `FAIL`.

- The server PID in `.t3/userdata/server-runtime.json` is alive and owns its port.
- The server's working directory is inside this worktree.
- The server has this worktree's `.t3/userdata/statev2.sqlite` open, and no file under `~/.t3/userdata` or the prod data dir. T3 makes its worktrees under the prod data dir, so the check skips files inside this worktree.
- The server and the web origin both answer 200.
- The t3v browser holds a valid session (`/api/auth/session` says `authenticated`), or a pairing URL is waiting for `browser open`.

## Drive

Every recipe in `features/` uses these commands. Target by ARIA role and accessible name, as the recipes give them. Fall back to visible text, and use coordinates only in a user-only check.

| Command                                                   | Does                                                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `browser click --role <role> --name <name> [--in <text>]` | Clicks the element with exactly that name, or with a name that starts with `--name-prefix <text>`. `--in` picks the innermost element that holds both the text and the target, such as one card. |
| `browser hover --role <role> --name <name> [--in <text>]` | Moves the mouse over the element, for controls that appear only on hover, such as a thread card's `Settle thread`.                                                                               |
| `browser click --text <text>` / `--at <x>,<y>`            | Clicks visible text, or a point from a screenshot.                                                                                                                                               |
| `browser fill --role <role> --name <name> --value <text>` | Replaces an input's value.                                                                                                                                                                       |
| `browser type <text>` / `browser press <key>`             | Types into whatever has focus, or presses Enter, Escape and so on.                                                                                                                               |
| `browser wait --text <text>` / `--gone <text>`            | Waits for text to appear, or for a text such as `Working` to leave, alone or with more words after it, as in `Working for 12s`. Default 15 s, `--timeout <ms>`.                                  |
| `browser goto <path>`                                     | Loads a path on the web origin, such as `/settings/providers`.                                                                                                                                   |
| `browser shot <name>` / `aria <name>` / `text`            | A screenshot or ARIA snapshot under proof, or the page's text on stdout.                                                                                                                         |
| `browser info`                                            | Prints `{"cdp": ..., "origin": ...}`, for a tool that attaches to this browser, such as the narrated-demo engine.                                                                                |

A turn ends when `Working` leaves the page. `browser wait --text` matches your own message too, so never wait on a word you sent.

The other surfaces:

- **HTTP.** `curl http://127.0.0.1:<server port>/.well-known/t3/environment` answers without auth, and `/api/auth/session` reports the session. The web origin proxies both.
- **MCP tools in a thread.** A dev thread's agent gets T3's MCP tools. Prove a tool change by asking the agent in a dev thread to call it, then read the outcome below.

### Free turns with Replay (dev)

A dev server run from source registers the `Replay (dev)` provider, instance `devReplay` (upstream #26207). It is a local ACP agent, `apps/server/scripts/dev-replay-agent.ts`, that plays recorded turns with simulated streaming through the real ACP adapter, orchestration and UI, and spends no model. Its models are scenarios: `Showcase` (thinking, a plan, tool calls, an approval and markdown), `Plan and reads`, `Write approval`, `Question` and `Multi turn`. Each prompt plays the scenario's next recorded turn, whatever the prompt says. Pick it in the composer's model picker like any provider, call `window.t3dev.replay("<scenario id>")` in the page (`showcase`, `todo-list`, `approval`, `question`, `multi-turn`), which starts the thread on approval-required, or run `node apps/server/src/bin.ts thread start --base-dir .t3 --provider devReplay --model showcase <project> "go"`. Turn it off in Settings rather than deleting it, because a dev server adds it back on start.

- It stands in for a turn's UI and pipeline: a thread starting, `Working`, streaming, plan and tool-call rows, an approval card (`approval`, on an approval-required thread as `t3dev.replay` starts it) or a question card (`question`) and its answer, and the run ending. Use it for a change to those surfaces, and to rehearse a recipe before a paid turn.
- It cannot stand in for a provider. A change to a driver, adapter, sign-in or model list, such as `packages/provider-cursor/`, needs that provider's real turn.
- It cannot stand in for anything the agent must do. Its tool calls are recorded rows: nothing runs, and it never calls T3's MCP tools. `delegate_task`, linked environments and delegated requests need a real agent.
- Its reply never follows the prompt, so a recipe that grades a `pong` reply needs a real provider.
- A packaged release has no agent script, so the Release check cannot use it.

## Evidence

Save proof under `proof/` with names in drive order. For a user-visible path, keep a screenshot of each action and of the state it produced, and the thread timeline (`browser text`). Exercise the real user path, never internal setters, direct SQLite writes or test-only endpoints. A screen alone is not proof of a change that stores something, so read the side effect too:

| Outcome                                 | Where it lives                                      | Read it with                              |
| --------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| Projects, threads, runs, messages       | `.t3/userdata/statev2.sqlite`, opened read-only     | `node $T3V outcome sql "<select>"`        |
| A tool the agent called, and its result | `.t3/userdata/logs/provider/events.<thread-id>.log` | `grep` it for `mcp__t3-code__<tool name>` |
| Server behavior and errors              | the dev log in scratch                              | `grep` it                                 |

The thread id is the last path segment of the thread's URL. Pass it as is. On disk an `mcp:` id becomes `events.mcp-….log`. Clients read projects from `projection_projects` and everything else from the `orchestration_v2_projection_*` tables. To seed SQLite fixtures, read [the fixtures reference](references/sqlite-fixtures.md), and stop the server before any write.

Two kinds of check prove a feature:

- **The normal drive** follows the feature's recipe with its handles.
- **A user-only check** gets only what a user gets: screenshots, a mouse, a keyboard, and the app's own help text, which here includes `docs/user/`. Give it to a fresh agent whose brief states the goal in the user's words and allows only `shot`, `click --at`, `click --text`, `type`, `press` and `scroll`. `scripts/user-only` is the only command its brief names: `user-only shot <name>`, `click <x> <y>`, `click-text <visible text>`, `type <text>`, `press <key>` and `scroll <dy>`. Its screenshots go to `proof/user-only/`, or `proof/$T3V_USER_DIR/`. It never sees selectors, source, this skill or the feature files. **An outcome check** runs beside it and reads the outcome table above to grade whether the user's goal happened. When the user-only check fails where the normal drive passed, the gap is the app's or its help text's. Record it in that feature's `Gotchas`, and never give the check more knowledge.

## Narrated demo videos

A PR that changes what a user sees or does in the web or desktop UI carries a narrated before-and-after acceptance video (`.agents/merge-brief.md`). The shared `narrated-demo` skill at `~/.agents/skills/narrated-demo/` makes it. Its `SKILL.md` lists the prerequisites, and its `references/demo-video.md` covers scene files, the pacing grammar, the sync probe, the privacy check, publishing and the running log. Read both before your first video.

**Install.** The video needs the shared skill at `~/.agents/skills/narrated-demo/`. `~/lim-v2/bin/lim-setup` installs it with the rest of lim-v2's skills. It copies them from the `~/lim-v2` checkout and does not pull that checkout. Every box other than lim-builder gets `~/lim-v2` only from lim-builder: `~/lim-v2/bin/lim-fleet` pushes lim-builder's `main` to each box and runs `lim-setup` there. Never pull `~/lim-v2` on another box. When the skill is missing there, run `lim-fleet` on lim-builder, or ask Lee to.

On lim-builder:

```bash
git -C ~/lim-v2 pull --ff-only
~/lim-v2/bin/lim-setup
diff -rq -x node_modules ~/lim-v2/skills/narrated-demo ~/.agents/skills/narrated-demo
```

The `diff` prints nothing when the install matches the checkout.

This repo keeps two parts of its own:

- `scripts/demo-adapter.mjs` gives the engine the recorded checkout's Playwright from `apps/web`, its dev server's origin from `.t3/userdata/server-runtime.json`, and a `t3v(...args)` helper for each scene file's `seed`. The helper runs that checkout's `t3v.mjs` and resolves to its stdout.
- `demos/` holds one scene file per feature. A scene file's `seed` gets `{ page, t3v, checkout }`.

Record the before side from a worktree at the PR's merge base, and the after side from the head worktree. Start a dev server and its browser for each, and print its CDP URL (see Isolation). Run this block from the root of each worktree:

```bash
T3V=.agents/skills/verify-t3code/scripts/t3v.mjs
node $T3V up
node $T3V browser open
node $T3V doctor
node $T3V browser info
```

`browser info` prints `{"cdp": ..., "origin": ...}`. Pass that CDP URL to `--cdp` explicitly (see "The CDP URL" in the shared reference). Then run these from the head worktree:

```bash
DEMO=~/.agents/skills/narrated-demo/scripts/demo.mjs
ADAPTER=.agents/skills/verify-t3code/scripts/demo-adapter.mjs
SCENES=.agents/skills/verify-t3code/demos/<feature>.demo.mjs
OUT=<main checkout>/.pstack/runs/<run>/proof/<pr-id>/demo
node $DEMO tts --demo $SCENES --out $OUT
node $DEMO record --demo $SCENES --adapter $ADAPTER --checkout . --cdp <head cdp> --out $OUT --side after --probe
node $DEMO mux --out $OUT
node $DEMO record --demo $SCENES --adapter $ADAPTER --checkout <base worktree> --cdp <base cdp> --out $OUT --side before
node $DEMO record --demo $SCENES --adapter $ADAPTER --checkout . --cdp <head cdp> --out $OUT --side after
node $DEMO mux --out $OUT
node $DEMO privacy $OUT --by <who> --note "<what was checked>"
node $DEMO publish $OUT --repo liminal-ai/t3code-v2 --pr <n> --dry-run
node $DEMO publish $OUT --repo liminal-ai/t3code-v2 --pr <n>
```

The first `mux` measures the probe's drift on the dry run. The second makes the video. `publish` keeps one PR comment that starts with `<!-- narrated-demo -->`. It rewrites an older `<!-- t3code-demo -->` comment to that marker. Lee accepts the video in a PR comment, and the merge waits for it.

To check the engine after a change, record the sample against one dev server. `demos/sample.demo.mjs` exports one `{ scenes }` list, so its `record` takes no `--side` and writes `$OUT/run/`:

```bash
DEMO=~/.agents/skills/narrated-demo/scripts/demo.mjs
ADAPTER=.agents/skills/verify-t3code/scripts/demo-adapter.mjs
SAMPLE=.agents/skills/verify-t3code/demos/sample.demo.mjs
OUT=<main checkout>/.pstack/runs/<run>/proof/<pr-id>/demo-sample
node $DEMO tts --demo $SAMPLE --out $OUT
node $DEMO record --demo $SAMPLE --adapter $ADAPTER --checkout . --cdp <cdp> --out $OUT --probe
node $DEMO mux --out $OUT
```

## Isolation

Two checkouts run two dev servers side by side, because each derives its ports and its t3v scratch from its full path and keeps its state in its own `.t3`. Verifiers can share one `T3V_RUN` even when their checkouts have the same folder name. Never run two servers on one state dir. `up` refuses when `server-runtime.json` names a live server, or when the process group of an earlier `up` still runs, so drive that one or stop it. Never drive a server this run did not start.

The dev server restarts on any write under `apps/server/src` or `packages/`, and a restart cancels every pending approval and the run that raised it. `vp test` and `vp run check:changed` in the same worktree write a vite temp file under `packages/`, so they restart it too. While a drive waits on a live approval, run nothing in its worktree. Run checks in another worktree, or before or after the drive.

An idle wait or a timing probe needs a server without the watcher. During one idle wait, a watching server restarted three times on `packages/client-runtime/node_modules/.vite-temp/vite.config.ts.timestamp-*` with no source change, and each restart released the query early. Copy `apps/server/package.json` to the run's scratch, set its `dev` script to `node src/bin.ts`, run `node $T3V up`, then copy the saved file back at once. `git checkout` would drop any uncommitted edit to it. The running server keeps no watcher, so a source change then needs `down` and `up`.

## Release check

A dev server runs the worktree's source, so it cannot show a fault that only the packaged release has, such as a dependency the archive leaves out. Before anyone asks Lee for a cutover, run these three checks in order. Do not start step 3 until steps 1 and 2 pass. Link the `pre` report, which lists every checked instance, in the cutover ask.

1. **Seam tests.** Run the seam tests in `FORK.md`.
2. **Feature drives.** Run the feature drives `.agents/merge-brief.md` names.
3. **Provider matrix.** Run `node .agents/skills/verify-t3code/scripts/release-check.mjs pre --release <dir> --run <run folder>`. Optional flags are `--prod-settings <path>` and repeatable `--model <instance>=<slug>`. The script reads prod's live enabled set from `server.getConfig` with a short session it revokes. A failed revoke adds a `(teardown)` failure row. It copies `settings.json` with `FORK.md`'s safety settings and keeps `binaryPath` and `enabled` verbatim. Codex homes and shadow homes move to scratch, and Limbase gets a throwaway lane. The script writes credentials and the settings copy at mode 0600, and teardown deletes them. A credential staging error fails only that instance's row. A blank Antigravity `binaryPath` runs `provider.install.start` over the network for the latest managed runtime. The row shows the managed version the release ran, and fails if the release resolved `agy` from `PATH` instead. Each enabled instance runs a `pong` turn with a per-run title. Missing or disabled prod instances fail. The script archives only its own threads, notes others, and writes `<run folder>/proof/release-check-<release-dir-name>.md`. Exit 0 is pass, 1 is any failure, and 2 is bad usage, including a flag from the other mode.

**Migration timing (optional).** Follow `FORK.md` "Test live without touching prod" for the snapshot, safety pass, and migration read. Boot the copy only when no new migration reads `orchestration_events` or rebuilds a projection.

**UI on the release (optional).** `t3v.mjs` cannot attach to `t3 serve`, and `pre`'s server is gone by report time. If you need a release-only UI check, start a separate throwaway `t3 serve` from the release with its own base directory per `FORK.md` "Test live without touching prod". Open its pairing URL in T3's Browser panel with `preview_open` (`profileId: "incognito"`).

**What a turn here cannot show.**

- A local Cursor agent's shell runs in the one SDK worker process every Cursor session shares (`@cursor/sdk`, upstream `29af131f06`), with no per-agent environment. An environment probe such as `echo "$TMPDIR"` prints the server's environment for Cursor by design (FORK.md, the TMPDIR bullet), so grade per-agent environment on Claude or Codex.
- Codex's workspace-write sandbox (bwrap) fails on lim-builder before any command runs, on `main` too: `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. `bwrap --ro-bind / / --unshare-net true` reproduces it. A sandboxed write cannot be proved here, and a full-access turn skips the sandbox, so it is no substitute. Prove the `sandboxPolicy` Codex receives from `buildCodexTurnStartParams` in `CodexAdapterV2.ts`, as #49's last verdict did. Run the live write only on a host where that bwrap command exits 0. Otherwise report the write as unprovable on this host, not as a FAIL.
- Claude turns still write to the machine's `~/.claude` history.

**On a Mac over ssh.** The steps above assume the linux-x64 release on this machine. On the M1 on 2026-10-28, a new darwin-arm64 build's Cursor turn failed over ssh with `Cursor Agent SDK open failed`, the keychain answered `User interaction is not allowed`, and `SecurityAgent` was running, while Claude and Codex turns passed. The likely cause, not yet confirmed on the M1, is a keychain password prompt that the ad-hoc-signed build raises on the Mac's screen, as the v0.1.2 Mac app did on first launch. Until someone types the password at that screen, report the Cursor turn as blocked on it rather than as a Cursor failure.

## After the cutover

Roll out headless boxes first. After you install the release on each host per `~/lim-v2/docs/release.md`, run `node .agents/skills/verify-t3code/scripts/release-check.mjs smoke <host> --run <run folder>`. It runs one `pong` turn per enabled instance in `claudeAgent`, `codex`, and `antigravity`, or the instances `--providers` names. Naming a disabled instance fails that row. Disabled providers do not run. The script archives only the threads this run started, notes others, and writes `<run folder>/proof/smoke-<host>.md`. Each host gets this small smoke check, not the full provider matrix. Link each host's `<run folder>/proof/smoke-<host>.md` in the fleet rollout report. Include one line per host with the checked instances and verdict.

The M5 is always last. Before you touch the M5, run `~/lim-v2/bin/t3-v2-install-mac-app --check-idle`. It prints `state=<idle|asleep|active|offline|unknown> hid_idle_s=<n|-> last_lee_msg_age_s=<n|->` with 900 s thresholds (`T3_V2_IDLE_AFTER`). See `~/lim-v2/machines/m5-macbook-pro.md` for threshold details.

- **Exit 0 (`idle` or `asleep`).** Update the M5 and run its smoke check unattended.
- **Exit 2 (`active`).** Finish every headless box first. Then end the turn with one plain message to Lee, not buried in orchestration chatter. State what is already rolled out, what will change on the M5, and roughly how long the swap and smoke take. Offer to go now, wait until a time he picks, or run automatically once the M5 is idle. If he defers to a time he picks, set a T3 `schedule_task` wake for that time. If he defers to once idle, have the wake rerun `--check-idle` and reschedule itself while it exits 2 or 3. Only after an exit 0 does the wake install the M5, run its smoke check, and delete the schedule.
- **Exit 3 (`offline` or `unknown`).** Leave the M5 alone, finish every headless box, and schedule a `--check-idle` wake that reschedules itself while it exits 2 or 3. When the wake sees exit 0, it updates the M5, runs its smoke check, and deletes the schedule.
- **Exit 64 (usage error).** Fix the arguments and rerun. It is not idle, active, or offline.

`--relaunch` refuses on exit 2 or 3 without `--force`. On the M1, pass `--force`, because agents drive it and no person works at it, so its input is theirs, not Lee's. On the M5, pass `--force` only after Lee says go.

## Re-verification

After a rebase or a small change, a review may carry an earlier passing lane to the new head instead of rerunning it, when nothing that changed reaches what the lane runs (poteto-mode's Shipping playbook, step 3). Compare `git range-diff` of the PR's own patch, and the diff of `main` under it, against what each lane runs:

| Lane                                                  | Runs                                                                                    | Rerun when the change touches                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `.agents/merge-brief.md` checks                       | `vp run check:changed`, the seam tests of each FORK.md seam the PR changes              | anything. They rerun at every new head.                                                            |
| A focused suite or package typecheck outside them     | the files it compiles or imports                                                        | one of those files, a test config, `package.json` or the lockfile                                  |
| `features/agent-turn.md` and every recipe with a turn | the web app, `apps/server/src/orchestration-v2/`, the provider package of that turn     | any of those. A change in one adapter reruns only that provider's turn                             |
| A feature recipe (`features/<name>.md`)               | the paths the merge brief maps to it, and the web screens it drives                     | those paths, or a screen or ARIA name the recipe targets                                           |
| A user-only check                                     | the screens and `docs/user/`                                                            | either                                                                                             |
| An outcome check                                      | the store or log it reads (the provider event log, the projection tables)               | that store's writer or format                                                                      |
| The Release check's turns                             | `scripts/release-check.mjs`, the release archive, its CLI, server and provider packages | runtime code, a dependency or packaging, `scripts/release-check.mjs`, or the Release check's steps |

Any change to this skill's steps for a lane (its feature file, this file's section, or `scripts/t3v.mjs` or `scripts/release-check.mjs` for what the lane calls) reruns that lane. Docs outside `docs/user/`, FORK.md and test-only changes carry every live lane, and the changed tests and text get a fresh run and read. The review lists each carry as `shortcut <id>: <what was not rerun, and the review it carries>. <why nothing that changed reaches it>`, and the lead accepts each on the gate run. Accepted precedents: #49's last verdict carried Claude turns, the TMPDIR filesystem cases and the provider typechecks across a Codex-only sandbox-policy fix.

## Cleanup

`node $T3V down` stops the browser and the dev server's whole process group (the server, Vite and the file watcher) by the PIDs `up` and `browser open` recorded, and removes the unused pairing URL. It never kills by name or pattern. It refuses, and says why, when the group's cwd is not this checkout. It waits for the group to exit, then exits 1 naming any process still listening on the server or web port. Kill such a process only after `/proc/<pid>/cwd` shows it is in your checkout. In T3, close your Browser panel tab with `t3_preview_close`. Proof survives `down`. Delete the worktree's `.t3`, and any folder you added as a project, only when you no longer need their state. An assistant turn ending is not teardown, so keep the server up while the user is still looking.
