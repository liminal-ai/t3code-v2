# Claude with long-horizon context (LHC)

A Claude instance can run its threads on long-horizon context (LHC). LHC records every message of a
thread in its own store, compacts the thread when it reaches the instance's trigger, and starts the
compacted thread from that record. A thread on an LHC instance keeps what it learned across
compaction, a restart of T3 Code, **Edit from here** and a fork.

## Set up an LHC instance

1. Open **Settings > Providers**, choose **Add provider**, pick **Claude**, and choose **Next** until
   the instance's settings show.
2. Set **Context** to **Long-horizon context (LHC)**.
3. Set **LHC compact trigger**, the token count at which LHC compacts a thread, and **LHC compact
   target**, the token count it compacts down to. The target must be below the trigger. For a model
   with a 1M-token context, 700000 and 140000 work well.
4. Choose **Add instance**.

LHC uses the same Claude Code login and Claude home as a stock Claude instance. When the trigger is
above 80% of the model's context window, LHC compacts at 80% instead, down to at most half of that.

An instance with an empty or invalid LHC field shows an error that names the field. Its threads do
not run until you fix it, and they never run as stock Claude.

LHC runs from the CLI releases for Linux x64, Linux arm64 and macOS on Apple silicon. On any other
platform an LHC instance shows `LHC runtime not staged for <platform>`.

## When a thread's values are set

Each thread keeps the trigger and target it was created with. T3 Code creates a new thread when you
send its first message, so an unsent draft takes the instance's values at the moment you send it.
A fork takes its source thread's values at once. Changing an instance's trigger or target later
changes only threads created after the change.

A thread whose first message was sent while the instance's values were empty or invalid has no LHC
values and cannot run. Fix the instance, then start a new thread.

## How LHC threads differ from stock Claude

- LHC compacts at its own trigger. **Auto-compact after** and **Compact idle threads** do not apply,
  and T3 Code never offers to compact an LHC thread when you return to it. You can still send
  `/compact`.
- A message you send while a turn runs waits for the turn to end, instead of steering it.
- Each compaction and each restart starts a new Claude Code session from LHC's record. Background
  commands and subagents still running in the old session end as interrupted.
- LHC writes compaction summaries with your Claude account, so they count against your usage.
- The session import on the welcome screen does not list LHC sessions from a Claude home that an
  LHC instance uses.

## Change or move an LHC thread

To run a thread on another instance, switch it in the model picker. T3 Code hands the context over
and starts a new session there, as it does between any two instances.

A thread stays with its instance's engine and Claude home. If you set an instance's **Context** to
**Claude Code**, change its Claude home, disable it or delete it, its LHC threads show the instance
as unavailable and do not run. Restore the instance to continue them.

Keep at least one LHC instance on a Claude home while that home holds LHC sessions. A disabled LHC
instance counts. If you delete the last LHC instance on a home, set its **Context** to **Claude
Code**, or point it at another Claude home, T3 Code stops treating that home's LHC sessions as LHC.
The session import on the welcome screen then lists them as ordinary Claude Code sessions. Importing
one continues that session on stock Claude, outside LHC's record, so it can miss later turns of the
thread. Do not import from that home until you add an LHC instance on it again.

LHC keeps its store in `lhc/` in T3 Code's state folder, beside `settings.json`. Do not delete it.
Threads whose LHC record is gone cannot continue.
