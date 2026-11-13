# Import Claude Code and Codex history

The welcome screen's last step lists the projects found in each Claude Code and Codex home, and imports the selected projects with their recent threads.

## Sub-features

- `import-list` lists projects from every enabled instance's home, with a thread count.
- `import-run` imports the selected projects and their recent threads.

## How to get to it (user POV)

- A first run with no projects opens it.
- Load `/welcome` directly, then choose `Continue` twice.

## Driving it with t3v

Preconditions:

- `node $T3V doctor` prints no `FAIL`.
- A disposable Claude home under the run's scratch, such as `<main checkout>/.pstack/runs/<run>/scratch/<pr>/claude-home`, with sessions in `projects/<slug>/<session id>.jsonl` whose `cwd` is a disposable project folder. Never point an instance at your real `~/.claude`.
- Point every instance at a disposable home, including `codex`, or the list also shows your real history.

- **Configure the homes.** Run `node $T3V settings 'providerInstances={"claudeAgent":{"driver":"claudeAgent","config":{"homePath":"<disposable home>"}},"codex":{"driver":"codex","config":{"homePath":"<empty folder>"}}}'`.
- **Open the list.** Run `node $T3V browser goto /welcome`, then `node $T3V browser click --role button --name "Continue"` twice. The heading reads `Import your projects`. Save `node $T3V browser shot <dir>/import-list` and `node $T3V browser aria <dir>/import-list`.
- **Check the home.** Projects you have not opened lately sit under `Other folders`. Run `node $T3V browser click --role button --name-prefix "Other folders"` to show them. The project shows a thread count equal to its sessions.
- **Import it.** Select the project's checkbox with `node $T3V browser click --role checkbox --name-prefix "<folder>/ <project>"`, and choose `Import 1 project`.
- **Proof.** Run `node $T3V outcome sql "select thread_id, resume_cursor_json from provider_session_runtime"`. Each imported Claude thread's `resume_cursor_json` carries its session id as `resume`.

## Gotchas

- Session ids come from file names. A copied transcript keeps its records' session id, and the import checks both.
- The import reads only threads active in the last 30 days.
