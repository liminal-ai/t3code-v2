---
name: verify-t3code
description: Launch this worktree's T3 Code dev server on its own state, drive the web UI the way a user does (T3's Browser panel from inside a T3 thread, or the bundled Playwright helper from anywhere), and capture proof. Use to verify any user-visible change to the web or desktop UI, the server's HTTP and WebSocket API, or the MCP tools agents get in a thread, and before a verdict or merge. Use test-t3-mobile for native mobile.
---

# Verify T3 Code

T3 Code is a web app for running coding agents in threads. The web UI is the primary surface, and the desktop app wraps it. The server's HTTP and WebSocket API and the MCP tools an agent gets inside a thread sit behind it. Native mobile is out of scope here. Use [test-t3-mobile](../test-t3-mobile/SKILL.md) for it.

Read [features/README.md](features/README.md) before you drive. It indexes one recipe per feature, and the feature you changed is the one a verdict drives.

## Two rules that protect the live install

1. **Never start a server against live T3 data.** `~/.t3/userdata` is the developer's T3 install, and on this machine v2 prod runs from `~/lim-v2/service/t3code/prod/data` on port 13987. Read and copy from them only. Never start a server on them, never open them read-write, never clean them up.
2. **Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev.** Dev is single-origin, and Vite proxies `/api`, `/ws`, `/oauth` and `/.well-known` to the server. Setting either bakes localhost into the bundle and breaks every remote browser.

## The helper

`scripts/t3v.mjs` launches, checks, drives and stops one dev server for the worktree that holds it, whatever directory you run it from. Run it with no arguments for its usage. Set the run once per shell, and every path below is under that run:

```bash
export T3V_RUN=<run>          # e.g. the pstack run name; default verify-t3code
T3V=.agents/skills/verify-t3code/scripts/t3v.mjs
node $T3V <command>
```

- Proof goes to `<main checkout>/.pstack/runs/<run>/proof/`. Git ignores it, it is outside every worktree, and `down` never touches it.
- Scratch goes to `<main checkout>/.pstack/runs/<run>/scratch/t3v/<worktree>/`: the dev log, the PIDs, the pairing URL (mode 0600) and the browser profile.
- The browser is headless Chromium from the repo's own `playwright`, started once by `browser open` and reached over CDP by every later command, so menus and focus survive between commands.

## Launch

1. Check the worktree is set up. While `.t3/setup-running` names a live PID, wait for it and do not run `vp i`. `.t3/setup-failed` holds the error tail. With no marker and broken module resolution, run `vp i`.
2. `node $T3V up` runs `vp run dev` in its own process group and waits for the pairing URL and both ports. It prints the `[dev-runner]` line with the real ports and state dir. Ports derive from the worktree path, so they stay stable across restarts, but an occupied port shifts them, so always read that line.
3. Turn on what the feature needs, such as `node $T3V settings threadWorkflowsEnabled=true` for workflows. It merges keys into `.t3/userdata/settings.json`, and the server picks the change up without a restart.
4. `node $T3V browser open` pairs the browser with the one-time startup URL and waits for the `Threads` navigation. Then the instance is usable.

Ready means a thread can start. The first agent turn of a recipe proves it. The proof run took 7 seconds from an empty `.t3` to both ports answering.

The state is the worktree's ignored `.t3`. It outranks an ambient `T3CODE_HOME`, and only an explicit `--home-dir` beats it. The first start in a worktree seeds an empty database from `~/.t3/userdata/statev2.sqlite`, read-only. `--no-seed` or `T3CODE_DEV_SEED=0` skips that. This machine has no `~/.t3`, so here the first start begins empty, with one auto-created project named `server` on the worktree's `apps/server`. To start from real data, stop the server and run `vp run migrate-dev-db -- --source ~/lim-v2/service/t3code/prod/data/userdata/statev2.sqlite`. It snapshots the source read-only and keeps recent projects and stopped threads without their schedules, pending work or auth sessions. The proof run did not exercise it. Refresh `statev2.sqlite`, never `state.sqlite`, and copy `secrets` or `settings.json` in only when the flow needs them. Data flows into the sandbox, never back out.

**From inside a T3 thread**, T3's own Browser panel drives the same server. Call `preview_open` with `profileId: "incognito"`, `reuseExistingTab: false` and the pairing URL from the scratch `pairing-url` file, then `preview_wait_for` with `locator: "role=navigation[name='Threads']"`. Use `preview_snapshot` and the interaction tools from there, passing the returned `tabId` on every call. Never pass `save: true` to `preview_snapshot`: it writes the PNG under the hosting T3's own data directory, which on this machine is prod's. The incognito profile keeps the dev cookie away from the profile you use for prod. A one-time token is spent once. `node $T3V pair` mints a fresh one into the same file through `node apps/server/src/bin.ts pair`.

**Sharing over the tailnet** is `vp run dev --share` in the background. Wait for its `pairingUrl:` line, and give that whole URL to an unpaired browser. Do not wire `tailscale serve` by hand or spend the user's pairing link. `T3CODE_DEV_AUTH_TOKEN` in the main checkout's gitignored `.env` is a reusable dev credential across worktrees on one hostname (see `docs/operations/development.md`). This machine has none configured. Never commit or print a token or a pairing URL.

## Doctor

`node $T3V doctor` is read-only. Run it first, and again whenever anything looks off. It exits 1 on any `FAIL`.

- The server PID in `.t3/userdata/server-runtime.json` is alive and owns its port.
- The server's working directory is inside this worktree.
- The server has this worktree's `.t3/userdata/statev2.sqlite` open, and no file under `~/.t3/userdata` or the prod data dir.
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
| `browser wait --text <text>` / `--gone <text>`            | Waits for text to appear, or for an exact text such as `Working` to leave. Default 15 s, `--timeout <ms>`.                                                                                       |
| `browser goto <path>`                                     | Loads a path on the web origin, such as `/settings/providers`.                                                                                                                                   |
| `browser shot <name>` / `aria <name>` / `text`            | A screenshot or ARIA snapshot under proof, or the page's text on stdout.                                                                                                                         |

A turn ends when `Working` leaves the page. `browser wait --text` matches your own message too, so never wait on a word you sent.

The other surfaces:

- **HTTP.** `curl http://127.0.0.1:<server port>/.well-known/t3/environment` answers without auth, and `/api/auth/session` reports the session. The web origin proxies both.
- **MCP tools in a thread.** A dev thread's agent gets T3's MCP tools, and the `thread_workflow_*` tools when `threadWorkflowsEnabled` is on. Prove a tool change by asking the agent in a dev thread to call it, then read the outcome below.

### Free turns with Replay (dev)

A dev server run from source registers the `Replay (dev)` provider, instance `devReplay` (upstream #26207). It is a local ACP agent, `apps/server/scripts/dev-replay-agent.ts`, that plays recorded turns with simulated streaming through the real ACP adapter, orchestration and UI, and spends no model. Its models are scenarios: `Showcase` (thinking, a plan, tool calls, an approval and markdown), `Plan and reads`, `Write approval`, `Question` and `Multi turn`. Each prompt plays the scenario's next recorded turn, whatever the prompt says. Pick it in the composer's model picker like any provider, call `window.t3dev.replay("<scenario id>")` in the page (`showcase`, `todo-list`, `approval`, `question`, `multi-turn`), which starts the thread on approval-required, or run `node apps/server/src/bin.ts thread start --base-dir .t3 --provider devReplay --model showcase <project> "go"`. Turn it off in Settings rather than deleting it, because a dev server adds it back on start.

- It stands in for a turn's UI and pipeline: a thread starting, `Working`, streaming, plan and tool-call rows, an approval card (`approval`, on an approval-required thread as `t3dev.replay` starts it) or a question card (`question`) and its answer, and the run ending. Use it for a change to those surfaces, and to rehearse a recipe before a paid turn.
- It cannot stand in for a provider. A change to a driver, adapter, sign-in or model list, such as `packages/provider-cursor/`, needs that provider's real turn.
- It cannot stand in for anything the agent must do. Its tool calls are recorded rows: nothing runs, and it never calls T3's MCP tools. `delegate_task`, the workflow tools, linked environments and delegated requests need a real agent.
- Its reply never follows the prompt, so a recipe that grades a `pong` reply needs a real provider.
- A packaged release has no agent script, so the Release check cannot use it.

## Evidence

Save proof under `proof/` with names in drive order. For a user-visible path, keep a screenshot of each action and of the state it produced, and the thread timeline (`browser text`). Exercise the real user path, never internal setters, direct SQLite writes or test-only endpoints. A screen alone is not proof of a change that stores something, so read the side effect too:

| Outcome                                 | Where it lives                                            | Read it with                               |
| --------------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| Workflow changes, with who made each    | `.t3/userdata/thread-workflows/threads/<thread-id>.jsonl` | `node $T3V outcome workflow [<thread-id>]` |
| The workflow note the agent was sent    | `.t3/userdata/logs/provider/events.<thread-id>.log`       | `node $T3V outcome note <thread-id>`       |
| Projects, threads, runs, messages       | `.t3/userdata/statev2.sqlite`, opened read-only           | `node $T3V outcome sql "<select>"`         |
| A tool the agent called, and its result | `.t3/userdata/logs/provider/events.<thread-id>.log`       | `grep` it for `mcp__t3-code__<tool name>`  |
| Server behavior and errors              | the dev log in scratch                                    | `grep` it                                  |

The thread id is the last path segment of the thread's URL. Clients read projects from `projection_projects` and everything else from the `orchestration_v2_projection_*` tables. To seed SQLite fixtures, read [the fixtures reference](references/sqlite-fixtures.md), and stop the server before any write.

Two kinds of check prove a feature:

- **The normal drive** follows the feature's recipe with its handles.
- **A user-only check** gets only what a user gets: screenshots, a mouse, a keyboard, and the app's own help text, which here includes `docs/user/`. Give it to a fresh agent whose brief states the goal in the user's words and allows only `shot`, `click --at`, `click --text`, `type`, `press` and `scroll`. `scripts/user-only` is the only command its brief names: `user-only shot <name>`, `click <x> <y>`, `click-text <visible text>`, `type <text>`, `press <key>` and `scroll <dy>`. Its screenshots go to `proof/user-only/`, or `proof/$T3V_USER_DIR/`. It never sees selectors, source, this skill or the feature files. **An outcome check** runs beside it and reads the outcome table above to grade whether the user's goal happened. When the user-only check fails where the normal drive passed, the gap is the app's or its help text's. Record it in that feature's `Gotchas`, and never give the check more knowledge.

## Isolation

Two worktrees run two dev servers side by side, because each derives its ports from its own path and keeps its state in its own `.t3`. Never run two servers on one state dir. `up` refuses when `server-runtime.json` names a live server, so drive that one or stop it. Never drive a server this run did not start.

The dev server restarts on any write under `apps/server/src` or `packages/`, and a restart cancels every pending approval and the run that raised it. `vp test` and `vp run check:changed` in the same worktree write a vite temp file under `packages/`, so they restart it too. While a drive waits on a live approval, run nothing in its worktree. Run checks in another worktree, or before or after the drive.

## Release check

A dev server runs the worktree's source, so it cannot show a fault that only the packaged release has, such as a dependency the archive leaves out. Before a cutover question, run the release `t3-v2-deploy` built as a throwaway and complete one real turn on each provider prod uses. FORK.md "Test live without touching prod" holds the safety rules this follows.

1. **Base dir.** Make `<run scratch>/<name>/base/userdata/` with a `settings.json` holding FORK.md's safety settings and the provider instances to check, copied from prod's `settings.json`, which holds no secrets. To time the first start's migrations against real data, add a copy of prod's database taken with `sqlite3 -readonly "file:<prod statev2.sqlite>?mode=ro" "VACUUM INTO '<copy>'"`, then run the safety list's SQL pass on the copy. `.backup` restarts on every prod write and never finishes. The safety list says to boot a copy only when no migration will run, because a migration that backfills from `orchestration_events` brings back the wakes the SQL pass removed from projections alone. So first read each migration the release adds (`git diff --name-only <prod's release sha> <new sha> -- apps/server/src/persistence/Migrations/`), and boot the copy only if none reads `orchestration_events` or rebuilds a projection. 3770's two, `068_ShellStopRequestIndex` and `069_ThreadMessageSearch`, add an index and fill a search table from `orchestration_v2_projection_messages`.
2. **Cursor sign-in.** Cursor signs in from its instance credential. Copy only `secrets/provider-auth-<sha256 of "6:cursor" followed by the instance id>.bin` from prod's `userdata/secrets/`, keep it mode 0600, never print it, and delete the copy at teardown. Claude and Codex use this machine's CLI logins.
3. **Start.** `T3CODE_HOME=<base> T3CODE_NO_BROWSER=1 T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false T3CODE_TELEMETRY_ENABLED=false setsid nohup <release>/t3 serve --host 127.0.0.1 --port <free port> --base-dir <base> --no-browser > <base>/../serve.log 2>&1 &`. The log names each migration that ran and when the server listened. `$!` is the shell wrapper's PID, so find the server's with `ss -H -ltnp` on that port, and confirm its `/proc/<pid>/cwd` before you stop it.
4. **Turns.** Add a disposable project with `<release>/t3 project add --base-dir <base> <folder>`, then from inside that folder run one turn per provider: `<release>/t3 thread start --base-dir <base> --provider <instance> --model <slug> --wait --json . "Reply with the single word pong. Do not call tools or change files."`. Each prints `"status":"completed"` and `"reply":"pong"`. Slugs in use here: `cursor` `grok-4.7`, `claudeAgent` `claude-haiku-5-5`, `codex` `gpt-6-astra`.
5. **UI on the release.** t3v cannot attach to `t3 serve`. Open the pairing URL from the log in T3's Browser panel with `preview_open` (`profileId: "incognito"`), as above.

**A Cursor turn for a verdict runs here.** A fresh dev server starts with Cursor signed out, and `features/agent-turn.md` forbids copying prod's credential into its `.t3`. Someone can sign it in with Cursor, but an unattended verifier can't, so the merge brief sends a `packages/provider-cursor/` change to this check. Steps 1 to 4 with only the `cursor` instance are enough. A release built from an earlier commit than the PR's head stands in for the head only when `git diff --stat <release sha> <head>` changes no runtime code. On #45 the release `fb48715408` differed from head `661cacaf88` only in `FORK.md` and `driver.test.ts`. Otherwise build the head with `t3-v2-deploy <head>`.

**On a Mac over ssh.** The steps above assume the linux-x64 release on this machine. On the M1 on 2026-10-28, a new darwin-arm64 build's Cursor turn failed over ssh with `Cursor Agent SDK open failed`, the keychain answered `User interaction is not allowed`, and `SecurityAgent` was running, while Claude and Codex turns passed. The likely cause, not yet confirmed on the M1, is a keychain password prompt that the ad-hoc-signed build raises on the Mac's screen, as the v0.1.2 Mac app did on first launch. Until someone types the password at that screen, report the Cursor turn as blocked on it rather than as a Cursor failure.

## Cleanup

`node $T3V down` stops the browser and the dev server's process group by the PIDs `up` and `browser open` recorded, and removes the unused pairing URL. It never kills by name or pattern. If something else holds your port, kill it only after `/proc/<pid>/cwd` shows it is in your worktree. In T3, close your Browser panel tab with `t3_preview_close`. Proof survives `down`. Delete the worktree's `.t3`, and any folder you added as a project, only when you no longer need their state. An assistant turn ending is not teardown, so keep the server up while the user is still looking.
