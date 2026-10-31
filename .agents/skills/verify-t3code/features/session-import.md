# Import Claude Code and Codex history

The welcome screen's last step lists the projects found in each Claude Code and Codex home, and imports the selected projects with their recent threads. A Claude home that an LHC instance also uses lists only its stock sessions. When the LHC store is missing or cannot be read, the step lists nothing from that home and shows a line that names the home, the LHC instance and the reason. An import from a list that went stale refuses the LHC sessions and says how many and why.

## Sub-features

- `import-list` lists projects from every enabled stock instance's home, with a thread count.
- `import-lhc-hidden` leaves LHC generations out of a home an LHC instance shares, renamed or not.
- `import-lhc-withheld` shows a status line instead of a shared home's projects when the LHC store is missing or unreadable.
- `import-run` imports the selected projects and their recent threads.
- `import-refused` names the refused count and reason in the warning after an import.

## How to get to it (user POV)

- A first run with no projects opens it.
- Load `/welcome` directly, then choose `Continue` twice.

## Driving it with t3v

Preconditions:

- `node $T3V doctor` prints no `FAIL`.
- A disposable Claude home under the run's scratch, such as `<main checkout>/.pstack/runs/<run>/scratch/<pr>/claude-home`, with sessions in `projects/<slug>/<session id>.jsonl` whose `cwd` is a disposable project folder. Never point an instance at your real `~/.claude`.
- For LHC sessions, run claude-lhc's seeded drives in a long-horizon-context worktree at the vendored source SHA (`vendor/claude-lhc/pin.json`), `VERIFY_KEEP_SCRATCH=1 .agents/skills/verify-claude-lhc/drive.mjs compact` and `... fork`. Each kept scratch holds an isolated Claude home and an LHC store. Copy the store's files into `.t3/userdata/lhc/` and use the Claude home as the disposable home.
- Point every instance at a disposable home, including `codex`, or the list also shows your real history.

- **Configure the homes.** Run `node $T3V settings 'providerInstances={"claudeAgent":{"driver":"claudeAgent","config":{"homePath":"<shared home>"}},"claude-lhc-work":{"driver":"claudeAgent","config":{"homePath":"<shared home>","contextEngine":"claude-lhc"}},"claude-other":{"driver":"claudeAgent","config":{"homePath":"<other home>"}},"codex":{"driver":"codex","config":{"homePath":"<empty folder>"}}}'`. The server reads the raw `contextEngine` key, so this works before Claude LHC is registered.
- **Open the list.** Run `node $T3V browser goto /welcome`, then `node $T3V browser click --role button --name "Continue"` twice. The heading reads `Import your projects`. Save `node $T3V browser shot <dir>/import-list` and `node $T3V browser aria <dir>/import-list`.
- **Check the shared home.** Projects you have not opened lately sit under `Other folders`. Run `node $T3V browser click --role button --name-prefix "Other folders"` to show them. The shared home's project shows a thread count equal to its stock sessions only. No status line names an LHC instance.
- **Withhold it.** Move `.t3/userdata/lhc` aside and load `/welcome` again. The list shows no project from the shared home, still shows the other home's project, and shows a line such as `3 sessions in <shared home> are hidden. LHC instance claude-lhc-work uses this home, and its LHC store is missing.`. An unreadable store, such as `chmod 000` on `registry.sqlite`, reads `could not be read` instead.
- **Import from a stale list.** Remove `contextEngine` from `claude-lhc-work` and open the list, which now counts the LHC sessions. Set `contextEngine` back with `node $T3V settings`, then select the project's checkbox with `node $T3V browser click --role checkbox --name-prefix "<folder>/ <project>"`, and choose `Import 1 project` without reloading. The warning toast reads, for example, `2 sessions in <shared home> were not imported. LHC instance claude-lhc-work uses this home, and those sessions belong to LHC.`.
- **Proof.** Run `node $T3V outcome sql "select thread_id, resume_cursor_json from provider_session_runtime"`. No row resumes an LHC session id. The scan's `diagnostics` and the import's `refused` are also in the WebSocket responses.

## Gotchas

- The scanner caches the last list's transcripts. The import rechecks each one against the current settings and store, so a stale list is the way to see a refusal.
- Session ids come from file names. A copied transcript keeps its records' session id, and the import checks both.
- An LHC instance counts even when it is disabled, because its sessions stay in the home.
- The list hides only sessions in a home that an LHC instance shares. Deleting the last LHC instance on a home makes its LHC sessions look stock again.
- The import reads only threads active in the last 30 days.
