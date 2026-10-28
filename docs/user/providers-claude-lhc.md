# Claude LHC

Claude LHC runs Claude Code through the claude-lhc sidecar. The sidecar records every
turn into a long-horizon context (LHC) store and rebuilds the context when it grows
past a trigger, so a long-running thread keeps its working memory instead of losing it
to Claude Code's own compaction. It uses the same Claude Code binary, login and models
as [Claude](./providers-claude.md).

## Set up the sidecar

Claude LHC needs two things on the environment's machine:

- Node.js 24.3 or later. T3 Code starts the sidecar with this binary.
- The claude-lhc package, version 0.2.0. T3 Code checks the version beside the entry
  before it offers the instance.

Until T3 Code ships the sidecar in its release, build it from the long-horizon-context
repository:

```bash
pnpm install --filter "claude-lhc..."
pnpm --filter lhc build && pnpm --filter claude-lhc build
```

The entry is `packages/claude-lhc/dist/sidecar.js`.

## Add an instance

In **Settings > Providers**, choose **Add provider**, then **Claude LHC**. Claude LHC is
off until you add an instance. On the new instance's card, under **Setup**, fill in:

| Field         | Value                                      |
| ------------- | ------------------------------------------ |
| Node binary   | An absolute path to Node 24.3 or later     |
| Sidecar entry | The path to claude-lhc's `dist/sidecar.js` |

Until both are set, the instance shows why it cannot run, and the composer offers no
Claude LHC thread. **Binary path** and **CLAUDE_CONFIG_DIR path** work as they do for
Claude, so a second instance can run another account or a Claude Code wrapper.

## Compaction

LHC compacts a thread when its context reaches **Compact trigger** (default 700,000
tokens) and rebuilds it to about **Rebuilt view size** (default 120,000). A trigger
above 80% of the model's context window is lowered to fit, so a 200,000-token model
compacts at 160,000. Claude Code's own auto-compaction is off, and T3 Code never
compacts an idle Claude LHC thread. Typing `/compact` asks LHC to compact now.

A new window applies when a thread's session next opens: a new thread, or after a
restart.

## What differs from Claude

- **Rollback.** Editing an earlier message rewinds the LHC record too, and the
  continued thread no longer sees the removed turns.
- **Forks.** Claude LHC threads can't be forked natively. A fork carries the
  conversation as a portable handoff instead.
- **Switching.** A Claude LHC thread stays on Claude LHC. If its instance can't run,
  the thread shows it as unavailable rather than continuing on another provider.
- **Storage.** The LHC store lives beside T3 Code's data directory, in a folder with
  the same name plus `-lhc`. Back up both together.
