# Claude threads on Limbase

A Claude instance can run its threads on Limbase, the memory service on this machine. Limbase keeps
every message of a thread. When the thread's context reaches 700,000 tokens, Limbase compacts it to
a view of about 100,000 tokens, and the thread goes on from that view in the same Claude session.
Claude Code's own compaction is off on these threads. A thread can therefore run for millions of
tokens. The agent gets two tools, `get_turns` and `get_messages`, to read back any part of the
thread that the view folded.

## Set up a Limbase instance

1. Run a Limbase service on this machine. Its home folder holds `config/membase.json`, which names
   the service's socket. The Limbase repository's `docs/runbooks/local-install.md` shows how to install
   and start it.
   Upgrade the Limbase service and T3 Code's bundled Limbase host together: the commit in
   `vendor/limbase/pin.json` is the service version the host expects. A host and a service on
   different contract versions fail every step on a Limbase thread, and the error names both.
2. Install the Claude Code version that the bundled Limbase host is tested on, in a folder of its
   own, so that it never updates itself:

   ```bash
   npm install --prefix ~/.local/share/limbase-claude/2.1.322 \
     @anthropic-ai/claude-agent-sdk-linux-x64@0.3.322
   ~/.local/share/limbase-claude/2.1.322/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --version
   ```

   The second command prints `2.1.322 (Claude Code)`. On another platform, use that platform's
   package, such as `@anthropic-ai/claude-agent-sdk-darwin-arm64`.

3. Open **Settings > Providers** and add a **Claude** instance, or edit one.
4. Set **Binary path** to the `claude` binary from step 2.
5. Set **Limbase home** to the Limbase home folder, for example `~/.limbase/home`.
6. Leave **Compact idle threads** at **Never**, or at **Use default** while the default is off.

Threads that start on the instance after this run on Limbase. A thread that started on the instance
before you set **Limbase home** stays a plain Claude thread. A thread on any other instance is not
changed.

### Why the CLI version matters

Limbase writes Claude Code's session file when it installs a view, in the format of the Claude Code
version its host is tested on. The `claude` on your PATH updates itself, so do not use it for a
Limbase instance. When a Limbase thread starts on another version, the server log shows the warning
`limbase.claude-code-version` with both versions, and the thread still runs.

The tested version is in `vendor/limbase/` of this repository: `limbase.claudeCode` in the
`package.json` inside the tarball. When the fork updates the tarball, repeat step 2 with the new
version, and change **Binary path** to it.

## What you see

- **An install.** Nothing in the thread. The turn pauses for about a second while the session moves
  to the view, then goes on.
- **Each step.** Limbase saves each step before the next request. Each step waits about 0.2 seconds
  for that.
- **A step that Limbase fails.** The run fails, and the thread shows a provider error that starts
  `limbase: stopped at`, then where and why. A step stopped at a prompt also shows a warning line
  that starts `Operation stopped by hook:`. A queued message waits, as after any failed run. Send
  the next message when Limbase is back, and the thread goes on.
- **Limbase down.** A step waits up to 90 seconds for Limbase, then fails as above. A new thread
  fails at once with `Limbase: the service did not create a thread`, or `Limbase: could not reach the
  Limbase home` when the home folder has no `config/membase.json`. The server and other threads keep
  running.
- **Fork.** A Limbase thread does not fork natively yet. A fork shows `Could not fork the source
  conversation natively (Limbase does not fork threads yet). Started a fresh session with its
  history.` The fork is then a new Limbase thread that starts from a summary of the source.
- **Edit from here.** Works as on any Claude thread. When you send the edited message, Limbase cuts
  the thread back to the turn before it, and the answer knows nothing after that turn. Editing the
  first message starts a new Limbase thread.
- **An edit that Limbase cannot make.** The run fails with `limbase: stopped at`, the reason, and
  a sentence that says what to do. Every message you send fails the same way until you edit again.
  `rollback refused: anchor` and `overBound` (more than 1,001 turns after the edited message) say
  `Edit an earlier message to go on.` Any other failure of the edited message, such as a Limbase
  that is down, says `Edit the message again to retry.`
- **Restarts.** After a restart of T3 Code, or after the 30-minute idle release, the thread resumes
  the session that Limbase last installed.

## Known costs

- An install replaces the Claude Code process. Background work still running at that moment, such as
  a background shell command, a dev server or a background subagent, is stopped after 5 seconds. The
  agent does not hear that it stopped.
- Several prompts that you send during a turn reach the model one tool call apart, in order.
- Limbase does not keep a subagent's messages. T3 Code may not show the model of a subagent that ran
  before the last install.
- A turn whose previous session T3 Code could not resume continues the same Limbase thread in a
  fresh session. T3 Code's recovery text, the thread's history as a summary, is recorded in Limbase
  as a prompt, and the model works from that text until the next install.
