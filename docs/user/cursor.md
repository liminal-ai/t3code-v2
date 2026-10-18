# Cursor

Cursor V2 runs through the official [`@cursor/sdk`](https://cursor.com/docs/api/sdk/typescript)
TypeScript package. It does not use Cursor's ACP transport for V2 execution.

## Prerequisites

- Node.js 22.13 or newer. The repository's supported Node version satisfies this requirement.
- Sign in with Cursor in **Settings > Providers > Cursor**, or provide a Cursor API key in
  `CURSOR_API_KEY`.
- A model accepted by the Cursor SDK. `auto` is sent to the SDK as its `default` model selection.

By default Cursor runs on this machine in the thread's workspace. A Cursor instance can instead run
its threads on Cursor Cloud. See [Cursor Cloud](#cursor-cloud).

## Sign in

Choose **Sign in**, then open the sign-in page and complete it in your browser. T3 Code
updates automatically when sign-in finishes. This works when connected to a remote environment too.
On mobile, use **Settings > Provider accounts** for an already configured Cursor instance.

Each provider instance keeps its own login on the environment that runs it. Your Cursor editor and
CLI login are separate. A configured `CURSOR_API_KEY` overrides browser sign-in; remove that override
to use the browser flow.

Use **Change account** or **Sign out** in the same settings section. Both stop that
instance's running threads and keep their history. Sign-out forgets the saved credential; to revoke
the generated key before it expires, remove it from your Cursor dashboard's API keys.

## Cursor Cloud

A Cursor Cloud thread runs on a Cursor VM instead of this machine, and keeps running there while T3
Code is closed. To use it, add a Cursor instance in **Settings > Providers** and set **Runs on** to
**Cursor Cloud**. Keep a separate instance on **Local** for threads that should run here. Two
switches apply only to cloud instances:

- **Open a pull request when a cloud run finishes** is off by default.
- **Open pull requests as the Cursor GitHub app** is on by default. Turn it off to open them as the
  signed-in Cursor user.

The project's `origin` must be a GitHub repository that your Cursor account can access. A cloud
thread works on its own clone:

- The VM clones the thread's branch if that branch is on GitHub, and the repository's default branch
  otherwise. Commits you have not pushed and uncommitted edits never reach it. The agent is told what
  it is missing.
- The agent cannot reach this machine's files or T3 Code's tools. Only skills in the repository are
  offered, and the agent can load them only once they are pushed.
- Images are sent. Text files and pasted text travel inline, up to 100 KB each, while the message
  stays within 120,000 characters. A file that does not fit is left out, with a note when there is
  room for one. Other files are not sent, and the agent is told so.
- T3 Code does not checkpoint cloud runs, so their changes have no diff or restore in T3 Code. Review
  them on the branch or pull request the agent pushes.
- Runtime modes do not limit a cloud agent. A message sent during a run waits for the run to end
  instead of restarting it.
- Stop asks Cursor to cancel the run. If Cursor accepts the request but has not confirmed that the
  run stopped 30 seconds later, the turn fails with a link to check the run on cursor.com.
- Pull requests that a cloud run opens or updates are linked to the thread.

Keep **Settings > General > Continue threads after restarts** on. After T3 Code restarts, it then
follows a cloud run that was still going. With it off, the run finishes on Cursor without T3 Code
seeing the result.

## V2 Capability Mapping

The adapter supports:

- creating and resuming local and Cursor Cloud agent threads;
- changing the model and model parameters between turns;
- assistant text, reasoning, tool activity, plans, and todo streaming;
- thread-scoped T3 Code MCP tools, for local threads;
- image attachments;
- interruption, queued app messages, and orchestrator-owned interrupt/restart steering;
- provider conversation snapshots through `Agent.messages.list()`;
- Cursor `task` subagents, projected as read-only child app threads with their tool activity and
  final result.

The public SDK does not currently expose native agent fork, conversation rollback, active steering,
or interactive approval callbacks. Direct active steering is advertised as unsupported, while V2
steering uses the orchestrator's interrupt-and-restart path and preserves the app run identity across
provider turns. Same-provider Cursor forks use the orchestrator's portable full-thread context
handoff into a fresh Cursor agent. The SDK has in-process custom callback tools, but the V2 adapter
intentionally uses the authenticated, thread-scoped MCP server instead.

Portable handoffs summarize eligible timeline items and can omit the end of long messages. Read
[Context in portable handoffs](./portable-handoffs.md) before using a fork for work whose exact
instructions must carry forward.

Cursor task events include an `agentId`, but the local SDK does not register that identifier as a
resumable agent: `Agent.resume()` returns `AgentNotFoundError`. The adapter therefore does not attach
a provider thread to native task projections or advertise subagent thread IDs. A projected child is
read-only: send messages from the parent thread.

Runtime modes map to the controls the local SDK exposes: full access disables its sandbox, while
restricted modes and explicit non-full-access sandbox policies enable it. Explicit approval policy
overrides also control Cursor Auto-review. Auto-review is not represented as an interactive T3 Code
approval flow.

The existing Cursor binary path and API endpoint settings belong to the CLI/ACP integration. Cursor
V2 execution does not launch that binary, and the SDK does not expose an API endpoint override.

## Replay And Live Testing

Cursor replay fixtures preserve the SDK boundary: agent open/resume, sends, ordered `onDelta`
updates, terminal results, cancellation, message snapshots, and close. The real V2 adapter,
orchestrator, event store, projections, and checkpoint logic still run in tests.

Record a fixture against the real SDK with:

```bash
pnpm --filter t3 record:cursor-replay --scenario simple
```

Use `--out <path>` to record a temporary probe without replacing a checked-in fixture. Supported
scenarios are listed by the recorder when an invalid scenario is supplied.
