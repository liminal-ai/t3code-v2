# T3 Code verification map

This directory is the maintained source for verifying T3 Code's user-facing behavior on web and desktop. Read this index before you drive the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Run every command from a shell where `T3V_RUN` names your run and `T3V=.agents/skills/verify-t3code/scripts/t3v.mjs`.
- Start this worktree's dev server with `node $T3V up`, never one against `~/.t3/userdata` or the prod data dir.
- Pair the helper's browser with `node $T3V browser open`.
- Require `node $T3V doctor` to print no `FAIL`.
- Add a disposable folder as the project for agent turns. The auto-created `server` project is this worktree's `apps/server`, and an agent with Full access there edits the code under test.
- Never drive an instance that this run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS selectors or DOM position.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Keep agent prompts that tell the agent not to call tools or change files, unless the feature under test is a tool.
- Wait for a turn to end with `browser wait --gone "Working"`, never on a word your own message contains.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is a screenshot after each action, and the ARIA snapshot of the final state.
- Mutation proof includes the outcome the feature file names, read with `node $T3V outcome`.
- Name artifacts in drive order under the feature's folder in proof.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with t3v` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Start a thread and run a turn](./agent-turn.md) covers the composer, the model picker, and how a run ends.
- [Workflow tab](./workflow-tab.md) covers starting a template, the agent's note, Done, closing, and the settle refusal.
- [Group chat](./group-chat.md) covers opening it, creating a group, a message and each member's reply, Back, and Escape.
- [Projects](./projects.md) covers adding a local folder as a project and starting a thread in it.
- [Settings for verification](./settings.md) covers `threadWorkflowsEnabled` and provider instances.
- [Claude LHC threads](./claude-lhc.md) covers adding a Claude LHC instance, its sidecar setup, a turn, restart-resume, rollback, `/compact`, and stock Claude staying off the sidecar.
- [Pair another browser](./pairing.md) covers a fresh pairing URL, the pairing page, and a second browser.
