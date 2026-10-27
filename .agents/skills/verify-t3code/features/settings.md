# Settings for verification

Two settings decide what a verification run can reach. `threadWorkflowsEnabled` turns thread workflows on and has no screen yet. Provider instances, the agents a thread can run on, are on the Providers page of Settings, where a user turns each one on or off and edits its runtime.

## Sub-features

- `settings-workflows` turns thread workflows on through the dev state's `settings.json`.
- `settings-provider-toggle` turns a provider instance on or off.
- `settings-provider-status` shows each provider's version and whether it is authenticated.

## How to get to it (user POV)

- Choose `Settings` at the foot of the sidebar, then `Providers`.
- Load `/settings/providers` directly.
- `threadWorkflowsEnabled` has no screen. Set it in `.t3/userdata/settings.json`, as `docs/user/thread-workflows.md` says.

## Driving it with t3v

Preconditions:

- `node $T3V doctor` prints no `FAIL`.

- **Turn workflows on.** Run `node $T3V settings threadWorkflowsEnabled=true`. It prints the merged file with `"threadWorkflowsEnabled": true`, and the proof run set it on a running server with no restart. A thread's right panel then offers `Workflow`. See [workflow-tab.md](./workflow-tab.md).
- **Open Providers.** Choose `Settings`, then `Providers`. Run `node $T3V browser click --role button --name "Settings"` and `node $T3V browser click --role button --name "Providers"`. The page lists `Codex` and `Claude`, each with a version, an `Authenticated` line and a switch.
- **Turn a provider off.** Run `node $T3V browser click --role switch --name "Enable Claude"`. The switch turns off.
- **Turn it back on.** Run the same command again. The switch turns on.
- **Proof.** Run `node $T3V browser shot <dir>/providers` after each switch and `node $T3V settings` after each. The file shows `"providerInstances": {"claudeAgent": {"driver": "claudeAgent", "enabled": false}}`, then `true`.

## Gotchas

- `settings.json` can change under a running server. SQLite fixtures cannot: stop the server first, as the fixtures reference says.
- The dev state starts with only what the server wrote itself. Copy `secrets` or a real `settings.json` in from the live install only when the flow needs them, and never write back.
- The dev server's providers run your machine's own CLIs. The Codex page shows binary `codex` and `CODEX_HOME` `~/.codex`, so a dev turn uses your own login and quota.
- Providers shows your account email, blurred. Keep its screenshots in proof, out of commits and replies.
- `Settings` moves the sidebar to the settings list. `Back` at its foot returns to threads.
