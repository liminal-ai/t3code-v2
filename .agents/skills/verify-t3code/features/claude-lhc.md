# Claude with long-horizon context (LHC)

A Claude instance whose **Context** is **Long-horizon context (LHC)** runs its threads through claude-lhc. Settings shows **Context** and the two LHC fields, an instance with an empty or invalid field shows an error naming it, and a thread on a ready instance remembers a fact across an automatic compact, a manual `/compact`, a restart, **Edit from here** and a fork. A thread never continues on another engine or Claude home: a changed, disabled or deleted instance shows as unavailable or refuses with the reason, and never starts stock Claude.

## Sub-features

- `lhc-instance` adds a Claude instance with **Context** set to LHC, an error status for empty fields, and ready once both are set.
- `lhc-recall` keeps a codeword across an automatic compact and a manual `/compact`, with and without summary inference.
- `lhc-restart` resumes the same LHC thread after a server restart and after Stop.
- `lhc-idle` releases an idle thread's query, and never schedules stock idle compaction for it.
- `lhc-rollback` forgets a fact taught after the turn that **Edit from here** rewinds to.
- `lhc-fork` gives a fork its source's facts up to the fork point and a copy of its source's binding.
- `lhc-refusal` refuses a thread whose instance changed engine or home, was disabled or deleted, or lost its runtime or store.
- `lhc-handoff` switches a thread between LHC and stock Claude with a visible context transfer.

## How to get to it (user POV)

- **Settings**, **Providers**, **Add provider**, **Claude**, then **Next** until its settings show. **Context** is a select, and **LHC compact trigger** and **LHC compact target** are text fields below it.
- An existing Claude instance's card in **Settings**, **Providers** shows the same three fields.
- A new thread whose model picker names the LHC instance, then its composer.
- `docs/user/claude-lhc.md` is the user's guide.

## Driving it with t3v

Preconditions:

- `node $T3V doctor` prints no `FAIL`.
- The server can run claude-lhc. In a dev checkout `vp i` installs it, and Node 24.3 or later runs it. `node -e 'import("claude-lhc/package.json",{with:{type:"json"}}).then(m=>console.log(m.default.version))'` from `apps/server` prints the vendored version.
- A disposable Claude home under the run's scratch, such as `<main checkout>/.pstack/runs/<run>/scratch/<pr>/claude-home`. Never point an LHC instance at your real `~/.claude`, because LHC writes its generations there.
- A Claude credential in the server's environment, since the disposable home has no login: start the server with `CLAUDE_CODE_OAUTH_TOKEN="$(cat <credential file>)" node $T3V up`. Never print it or write it into `settings.json`.
- A disposable project folder.

- **Add the instance in the UI.** Choose `Settings`, `Providers`, then `node $T3V browser click --role button --name "Add provider"`. Choose `Claude` and `Next`, set `Instance ID` to `claude-lhc-test`, choose `Next`, set `CLAUDE_CONFIG_DIR path` to the disposable home, and pick `Long-horizon context (LHC)` with `node $T3V browser click --role combobox --name "Context"` and `node $T3V browser click --role option --name "Long-horizon context (LHC)"`. Leave both LHC fields empty, choose `Add instance`, then `Done` or `Skip for now` on the sign-in step. The instance's card shows an error that reads `Set LHC compact trigger and LHC compact target to run LHC threads.` Save `node $T3V browser shot <dir>/settings-1` and `node $T3V settings`.
- **Fill the fields.** Type `40000` into `LHC compact trigger` and `20000` into `LHC compact target` with `node $T3V browser fill --role textbox --name "LHC compact trigger" --value 40000`, the same for the target, and `node $T3V browser press Tab` to leave the field. The error clears and the card shows the instance ready. `node $T3V settings` shows `"contextEngine": "claude-lhc"`, `"lhcCompactTrigger": "40000"` and `"lhcCompactTarget": "20000"`. Save `<dir>/settings-2`.
- **Or configure it directly.** `node $T3V settings 'providerInstances={"claude-lhc-test":{"driver":"claudeAgent","config":{"homePath":"<disposable home>","contextEngine":"claude-lhc","lhcCompactTrigger":"40000","lhcCompactTarget":"20000"},"environment":[{"name":"CLAUDE_LHC_NO_INFERENCE","value":"1"}]}}'`. `CLAUDE_LHC_NO_INFERENCE=1` turns the summary model off. Leave it out to check summaries written by inference.
- **Recall across compaction.** Start a thread on `claude-lhc-test` in the disposable project. Teach a codeword, ask the agent to read a file over 40k tokens, then ask for the codeword. Send `/compact`, then ask again. Both answers name the codeword. The thread shows two compaction items, and the manual one settles with no reply bubble.
- **Restart, Stop and idle.** Run `node $T3V down && node $T3V up` with the credential, open the thread and ask again. Ask for a long Bash command, choose Stop while it runs, and resend. Leave the thread idle until its query is released.
- **Idle compaction stays off for a bound thread.** Set `"idleCompaction":"beforeCacheExpires"` on the LHC instance with a trigger above 200000, such as `700000` and `140000`, on a 1M-context model, and on a stock control instance on another disposable home. Grow one thread on each past 200000 tokens with one completed run, then wait past the prompt cache's expiry less two minutes (about 58 minutes on a subscription credential). The stock thread gets a `/compact` sent by T3 Code, and the LHC thread gets none.
- **Rollback and fork.** On one thread teach fact A, then fact B, and choose **Edit from here** on the message before B. The thread knows A and not B. On another, teach A then B, fork from the turn that taught A, and ask the fork for both. The fork knows A and not B, and its source knows both.
- **Refusals.** Retype the instance with `node $T3V settings` (remove `contextEngine`), change its `homePath`, disable it, delete it, or point `CLAUDE_LHC_SIDECAR` and `CLAUDE_LHC_NODE` in its `environment` at a missing file. Then open a thread on it and send, also with `node apps/server/src/bin.ts thread send --base-dir .t3 --wait <thread-id> "<message>"`. The composer shows the instance as unavailable, or the turn fails naming the reason. Restore the instance, and the next send resumes the same thread.
- **Handoff.** Switch an LHC thread to a stock Claude instance in the model picker and send, then switch back. Each switch shows the context transfer, and the destination opens a new native session.
- **Proof.** Run `node $T3V outcome sql "select thread_id, provider_session_id, json_extract(payload_json, '$.nativeMetadata.engineBinding') from orchestration_v2_projection_provider_threads"`. Each LHC thread's row carries a binding with `"engine":"claude-lhc"`, the instance's `claude-lhc:home:<home>` key and its compact pair, and no stock row carries one. Read LHC's registry with `sqlite3 -readonly .t3/userdata/lhc/registry.sqlite "select * from thread_current_alias"`, which lists each LHC thread's current native session. The provider log `.t3/userdata/logs/provider/events.<thread-id>.log` shows each open.

## Gotchas

- The LHC fields save when the field loses focus. A screenshot taken while the cursor is still in the field shows the old status.
- A thread's trigger and target freeze when the server creates the thread, at its first send. Changing the instance's pair afterwards changes only newer threads. A thread first sent while the instance was invalid has no pair and keeps refusing after the fix.
- LHC starts a new native session at each compaction and each restart, so `thread_current_alias` moves forward while the thread stays one LHC thread.
- Without `CLAUDE_LHC_NO_INFERENCE=1`, LHC's summary workers spend the credential's quota.
- The meter paints the binding's trigger capped at 80% of the model's context window, where LHC compacts, so a 700000 trigger on a 200k model shows 160000.
- An LHC instance on Windows or a CLI archive built for another host reports `LHC runtime not staged for <target>`.
