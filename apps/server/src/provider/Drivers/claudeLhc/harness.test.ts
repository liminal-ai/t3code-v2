// @effect-diagnostics nodeBuiltinImport:off -- the harness starts, inspects and outlives real sidecar processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { engineContinuationKey, type ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { EventNdjsonLogger } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ClaudeAdapterV2 from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as PortScanner from "../../../preview/PortScanner.ts";
import * as ProviderInstanceRegistry from "../../ProviderInstanceRegistry.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeClaudeLhcInstance } from "./instance.ts";
import { resolveClaudeLhcRuntime } from "./runtime.ts";
import { makeClaudeLhcSeam } from "./seam.ts";

/**
 * Live mode (`T3_CLAUDE_LHC_LIVE=1`) runs the real `claude` CLI on a real model with the env
 * credential. Its turns take minutes, so run it with `--testTimeout=1800000`, and set
 * `T3_CLAUDE_LHC_EVIDENCE` to keep its homes and logs. Without it, the sidecar runs a fake Agent SDK
 * that answers from its prompts and its projected session file, so nothing calls a model.
 */
const LIVE = process.env.T3_CLAUDE_LHC_LIVE === "1";
const EVIDENCE = process.env.T3_CLAUDE_LHC_EVIDENCE;
const unix = HostProcess.Platform.defaultValue() !== "win32";

const DRIVER = ProviderDriverKind.make("claudeAgent");
const INSTANCE_ID = ProviderInstanceId.make("claude-lhc");
const PROJECT_ID = ProjectId.make("project:claude-lhc-harness");
const MODEL = process.env.T3_CLAUDE_LHC_MODEL ?? "claude-sonnet-4-6";
const DEFAULT_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const settled = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

const FAKE_SDK = `
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
export * from "@anthropic-ai/claude-agent-sdk";

export async function renameSession() {}

const FACT = /FACT-[A-Z0-9]+/g;

function projectedFacts(options) {
  const root = join(options.env?.CLAUDE_CONFIG_DIR ?? "", "projects");
  let files = [];
  try { files = readdirSync(root, { recursive: true }).map(String); } catch {}
  const file = files.find((name) => name.endsWith(options.resume + ".jsonl"));
  return file === undefined ? [] : (readFileSync(join(root, file), "utf8").match(FACT) ?? []);
}

const textOf = ({ message }) =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

export function query({ prompt, options }) {
  const sessionId = options.sessionId ?? options.resume ?? randomUUID();
  const model = options.model ?? "claude-sonnet-4-6";
  const facts = new Set(options.resume === undefined ? [] : projectedFacts(options));
  const out = [];
  const waiting = [];
  let inputDone = false;
  let closed = false;
  let wake;
  const notify = () => { const resolve = wake; wake = undefined; resolve?.(); };
  const lifecycle = (user, state) => ({
    type: "command_lifecycle", command_uuid: user.uuid, state, uuid: randomUUID(), session_id: sessionId,
  });
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  void (async () => {
    for await (const user of prompt) {
      if (closed) break;
      waiting.push(user);
      out.push(lifecycle(user, "queued"));
      notify();
    }
    inputDone = true;
    notify();
  })();
  async function* stream() {
    for (;;) {
      while (out.length > 0) yield out.shift();
      if (closed) return;
      const user = waiting.shift();
      if (user === undefined) {
        if (inputDone) return;
        await new Promise((resolve) => (wake = resolve));
        continue;
      }
      yield lifecycle(user, "started");
      yield {
        type: "system", subtype: "init", session_id: sessionId, uuid: randomUUID(), cwd: options.cwd,
        model, tools: [], mcp_servers: [], permissionMode: options.permissionMode ?? "default",
        slash_commands: [], apiKeySource: "none", claude_code_version: "2.1.312", output_style: "default",
      };
      const text = textOf(user);
      const taught = text.match(FACT) ?? [];
      for (const fact of taught) facts.add(fact);
      const reply = /\\brecall\\b/i.test(text)
        ? "facts: " + ([...facts].sort().join(" ") || "none")
        : "noted " + (taught.join(" ") || "nothing");
      const uuid = randomUUID();
      yield {
        type: "assistant", uuid, session_id: sessionId, parent_tool_use_id: null,
        message: {
          id: "msg_" + uuid, type: "message", role: "assistant", model, content: [{ type: "text", text: reply }],
          stop_reason: "end_turn", stop_sequence: null, usage,
        },
      };
      yield {
        type: "result", subtype: "success", is_error: false, num_turns: 1, result: reply, stop_reason: "end_turn",
        terminal_reason: "completed", permission_denials: [], duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0,
        usage, modelUsage: {}, uuid: randomUUID(), session_id: sessionId,
      };
      yield lifecycle(user, "completed");
    }
  }
  const base = Object.assign(stream(), {
    getContextUsage: async () => ({ rawMaxTokens: 1000000, totalTokens: 0 }),
    setMcpServers: async (servers) => ({ added: Object.keys(servers), removed: [], errors: {} }),
    close: () => { closed = true; notify(); },
  });
  return new Proxy(base, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (value !== undefined) return typeof value === "function" ? value.bind(target) : value;
      return async () => undefined;
    },
  });
}
`;

// The fake re-exports the sidecar's own Agent SDK, so it resolves that import from the sidecar.
const fakeSdkHooks = (fakeUrl: string, sidecarUrl: string) => `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "@anthropic-ai/claude-agent-sdk") return nextResolve(specifier, context);
    if (context.parentURL === ${JSON.stringify(fakeUrl)}) {
      return nextResolve(specifier, { ...context, parentURL: ${JSON.stringify(sidecarUrl)} });
    }
    return { url: ${JSON.stringify(fakeUrl)}, shortCircuit: true };
  },
});
`;

interface Recorded {
  readonly at: string;
  readonly event: unknown;
}

const recordingLogger = (filePath: string) => {
  const events: Array<Recorded> = [];
  const logger: EventNdjsonLogger = {
    filePath,
    write: (event) =>
      DateTime.now.pipe(
        Effect.map((now) => void events.push({ at: DateTime.formatIso(now), event })),
      ),
    close: () => Effect.void,
  };
  return { events, logger };
};

const incomingTypes = (events: ReadonlyArray<Recorded>) =>
  events.flatMap(({ event }) => {
    const payload = (event as { event?: { direction?: string; payload?: { type?: unknown } } })
      .event;
    return payload?.direction === "incoming" && typeof payload.payload?.type === "string"
      ? [payload.payload.type]
      : [];
  });

// `exec` keeps the PID, so each line is the sidecar's own PID and its process group.
const SIDECAR_RECORDER = 'log=$1; shift; echo $$ >> "$0"; exec "$@" 2>> "$log"';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const recordedPids = (file: string) =>
  NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number)
    : [];

interface Harness {
  readonly root: string;
  readonly compact: { readonly trigger: number; readonly target: number };
  readonly cwd: string;
  readonly stateDir: string;
  readonly claudeHome: string;
  readonly dbPath: string;
  readonly pidFile: string;
  readonly sidecarLog: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly binaryPath: string;
  readonly native: ReturnType<typeof recordingLogger>;
}

const makeHarness = Effect.fn("makeHarness")(function* (name: string, compact: Harness["compact"]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root =
    EVIDENCE === undefined
      ? yield* fs.makeTempDirectoryScoped({ prefix: `t3-claude-lhc-${name}-` })
      : path.join(EVIDENCE, name);
  const stateDir = path.join(root, "userdata");
  const claudeHome = path.join(root, "claude-home");
  for (const directory of [stateDir, claudeHome]) {
    yield* fs.makeDirectory(directory, { recursive: true });
  }
  const host = yield* HostProcess.Environment;
  const environment: NodeJS.ProcessEnv = {
    ...host,
    CLAUDE_CONFIG_DIR: claudeHome,
    CLAUDE_LHC_NO_INFERENCE: "1",
  };
  if (!LIVE) {
    const sidecar = (yield* resolveClaudeLhcRuntime(environment)).sidecar;
    const fakeSdk = path.join(root, "fake-sdk.mjs");
    const hooks = path.join(root, "fake-sdk-hooks.mjs");
    yield* fs.writeFileString(fakeSdk, FAKE_SDK);
    yield* fs.writeFileString(
      hooks,
      fakeSdkHooks(NodeURL.pathToFileURL(fakeSdk).href, NodeURL.pathToFileURL(sidecar).href),
    );
    environment.NODE_OPTIONS = `--import=${NodeURL.pathToFileURL(hooks).href}`;
  }
  return {
    root,
    compact,
    cwd: yield* checkpointWorkspace(`claude-lhc-${name}`),
    stateDir,
    claudeHome,
    dbPath: path.join(root, "state.sqlite"),
    pidFile: path.join(root, "sidecar-pids.txt"),
    sidecarLog: path.join(root, "sidecar.log"),
    environment,
    binaryPath: process.env.CLAUDE_BIN ?? "claude",
    native: recordingLogger(path.join(root, "native.log")),
  } satisfies Harness;
});

const lhcInstance = (harness: Harness) =>
  makeClaudeLhcInstance({
    continuationKey: engineContinuationKey({
      engine: "claude-lhc",
      claudeHome: harness.claudeHome,
    }),
    claudeHome: harness.claudeHome,
    compact: harness.compact,
  });

const threadContext = (harness: Harness, appThreadId: ThreadId) => ({
  appThreadId,
  engineBinding: { ...lhcInstance(harness).engineBinding, providerInstanceId: INSTANCE_ID },
});

/** The runner over a seam, or stock's when there is none, recording each sidecar or CLI it starts. */
const makeRunner = (harness: Harness, seam?: ClaudeAdapterV2.ClaudeQuerySeam) =>
  ClaudeAdapterV2.makeClaudeAgentSdkQueryRunner(seam).pipe(
    Effect.provideService(ProviderEventLoggers, {
      native: harness.native.logger,
      canonical: undefined,
    }),
    Effect.provideService(AgentScope, {
      ...AgentScope.defaultValue(),
      wrap: ({ command, args }) =>
        Effect.succeed({
          command: "/bin/sh",
          args: ["-c", SIDECAR_RECORDER, harness.pidFile, harness.sidecarLog, command, ...args],
        }),
    }),
    Effect.provide(PortScanner.layerTest),
  );

const makeLhcSeam = (harness: Harness) =>
  Effect.gen(function* () {
    return yield* makeClaudeLhcSeam({
      runtime: yield* Effect.result(resolveClaudeLhcRuntime(harness.environment)),
      stateDir: harness.stateDir,
      environment: harness.environment,
      binaryPath: harness.binaryPath,
    });
  });

/** The server's Claude LHC instance as T13 builds it: the seam, the stock runner and adapter. */
const makeAdapter = Effect.fn("makeAdapter")(function* (harness: Harness) {
  const instance = lhcInstance(harness);
  const queryRunner = yield* makeRunner(harness, yield* makeLhcSeam(harness));
  const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
    instanceId: INSTANCE_ID,
    settings: { ...DEFAULT_SETTINGS, binaryPath: harness.binaryPath },
    environment: harness.environment,
    attachmentsDir: harness.cwd,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    crypto: yield* Crypto.Crypto,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    queryRunner,
    capabilities: instance.capabilities,
    engineBinding: instance.engineBinding,
  });
  return {
    instanceId: INSTANCE_ID,
    driverKind: DRIVER,
    continuationIdentity: {
      driverKind: DRIVER,
      continuationKey: instance.engineBinding.continuationKey,
    },
    engineBinding: instance.engineBinding,
    displayName: "Claude LHC",
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: adapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  } satisfies ProviderInstance;
});

/** One server lifetime over the harness's database. A second layer over the same file is a restart. */
const serverLayer = (harness: Harness) => {
  const database = SqlitePersistence.layerFromPath(harness.dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const registry = ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
    Layer.provide(
      Layer.effect(
        ProviderInstanceRegistry.ProviderInstanceRegistry,
        makeAdapter(harness).pipe(
          Effect.map((instance) => ({
            getInstance: (instanceId: ProviderInstanceId) =>
              Effect.succeed(instanceId === INSTANCE_ID ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.never,
          })),
        ),
      ),
    ),
    Layer.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer)),
  );
  return ProviderReplayHarness.layerWithRegistry(
    { name: "claude-lhc-harness", runtimePolicyOverride: { cwd: harness.cwd } },
    registry,
    { databaseLayer: database, recoverOnStartup: true },
  );
};

const runOf = (projection: OrchestrationV2ThreadProjection, ordinal: number) => {
  const run = projection.runs.find((candidate) => candidate.ordinal === ordinal);
  assert.isDefined(run, `run ${ordinal} exists`);
  return run!;
};

const answerOf = (projection: OrchestrationV2ThreadProjection, ordinal: number) => {
  const run = runOf(projection, ordinal);
  return projection.turnItems
    .flatMap((item) =>
      item.runId === run.id && item.type === "assistant_message" ? [item.text] : [],
    )
    .join("\n");
};

const send = (threadId: ThreadId, label: string, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${threadId}:${label}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${label}`),
      text,
      attachments: [],
      modelSelection: { instanceId: INSTANCE_ID, model: MODEL },
      dispatchMode: { type: "start_immediately" },
    } satisfies OrchestrationV2Command);
  });

/** Watches from now, so a milestone that follows the next dispatch cannot be missed. */
const watchFor = (matches: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(matches),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });

const runReaches =
  (threadId: ThreadId, ordinal: number, statuses: ReadonlySet<string>) =>
  (event: OrchestrationV2DomainEvent) =>
    event.type === "run.updated" &&
    event.threadId === threadId &&
    event.payload.ordinal === ordinal &&
    statuses.has(event.payload.status);

const projectionOf = (threadId: ThreadId) =>
  Orchestrator.OrchestratorV2.use((orchestrator) => orchestrator.getThreadProjection(threadId));

/** Sends the prompt that starts run `ordinal` and returns the thread once that run settles. */
const turn = (threadId: ThreadId, ordinal: number, text: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const done = yield* watchFor(runReaches(threadId, ordinal, settled));
      yield* send(threadId, `run-${ordinal}`, text);
      yield* Fiber.join(done);
      return yield* projectionOf(threadId);
    }),
  );

const createThread = (threadId: ThreadId, cwd: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${threadId}:create`),
      threadId,
      projectId: PROJECT_ID,
      title: "Claude LHC harness",
      modelSelection: { instanceId: INSTANCE_ID, model: MODEL },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
    } satisfies OrchestrationV2Command);
  });

const ALPHA = "FACT-ALPHA7Q2";
const BRAVO = "FACT-BRAVO4K9";
const teach = (fact: string) =>
  LIVE ? `Remember the codeword ${fact}. Reply with only the word OK.` : `remember ${fact}`;
const RECALL = LIVE
  ? "recall: reply with every codeword I asked you to remember in this conversation, separated by spaces, or NONE."
  : "recall";

const saveEvidence = (harness: Harness, name: string, contents: string) =>
  EVIDENCE === undefined
    ? Effect.void
    : Effect.sync(() => NodeFS.writeFileSync(NodePath.join(harness.root, name), contents));

const saveNativeLog = (harness: Harness) =>
  saveEvidence(
    harness,
    "native.log",
    harness.native.events.map((entry) => JSON.stringify(entry)).join("\n"),
  );

const harnessLayer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);

describe.runIf(unix)("Claude LHC through the real adapter, runner and sidecar", () => {
  it.live("starts, answers, compacts, restarts, forks and rolls back on its own LHC record", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("lifecycle", { trigger: 700_000, target: 140_000 });
      const source = ThreadId.make("thread:claude-lhc-harness:source");
      const fork = ThreadId.make("thread:claude-lhc-harness:fork");

      const beforeRestart = yield* Effect.gen(function* () {
        yield* createThread(source, harness.cwd);
        const taughtAlpha = yield* turn(source, 1, teach(ALPHA));
        assert.equal(runOf(taughtAlpha, 1).status, "completed");
        const row = taughtAlpha.providerThreads[0]!;
        assert.deepEqual(row.nativeMetadata?.engineBinding, {
          ...lhcInstance(harness).engineBinding,
          providerInstanceId: INSTANCE_ID,
        });
        yield* turn(source, 2, teach(BRAVO));
        const compacted = yield* turn(source, 3, "/compact");
        assert.equal(runOf(compacted, 3).status, "completed");
        const recalled = yield* turn(source, 4, RECALL);
        assert.include(answerOf(recalled, 4), ALPHA);
        assert.include(answerOf(recalled, 4), BRAVO);
        return recalled;
      }).pipe(Effect.provide(serverLayer(harness)));
      const nativeId = beforeRestart.providerThreads[0]!.nativeThreadRef?.nativeId;
      assert.isString(nativeId);

      yield* Effect.gen(function* () {
        const restarted = yield* turn(source, 5, RECALL);
        assert.equal(runOf(restarted, 5).status, "completed");
        assert.include(answerOf(restarted, 5), ALPHA);
        assert.include(answerOf(restarted, 5), BRAVO);
        assert.equal(restarted.providerThreads[0]!.nativeThreadRef?.nativeId, nativeId);

        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:claude-lhc-harness:fork"),
          sourceThreadId: source,
          targetThreadId: fork,
          sourcePoint: { type: "run", runId: runOf(restarted, 1).id },
        } satisfies OrchestrationV2Command);
        const forked = yield* turn(fork, 1, RECALL);
        assert.equal(runOf(forked, 1).status, "completed");
        assert.include(answerOf(forked, 1), ALPHA);
        assert.notInclude(answerOf(forked, 1), BRAVO);
        const forkRow = forked.providerThreads[0]!;
        assert.deepEqual(
          forkRow.nativeMetadata?.engineBinding,
          restarted.providerThreads[0]!.nativeMetadata?.engineBinding,
        );
        assert.match(String(forkRow.nativeMetadata?.forkHeadMessageId), /^claude-lhc-cursor:/);

        const checkpoint = restarted.checkpoints.find(
          (candidate) => candidate.runId === runOf(restarted, 1).id,
        );
        assert.isDefined(checkpoint, "run 1 left a checkpoint");
        const rolledBack = yield* Effect.scoped(
          Effect.gen(function* () {
            const done = yield* watchFor(runReaches(source, 5, new Set(["rolled_back"])));
            yield* orchestrator.dispatch({
              type: "checkpoint.rollback",
              restoreFiles: false,
              commandId: CommandId.make("command:claude-lhc-harness:rollback"),
              threadId: source,
              scopeId: checkpoint!.scopeId,
              checkpointId: checkpoint!.id,
            } satisfies OrchestrationV2Command);
            yield* Fiber.join(done);
            return yield* projectionOf(source);
          }),
        );
        assert.deepEqual(
          rolledBack.runs.map((run) => run.status),
          ["completed", "rolled_back", "rolled_back", "rolled_back", "rolled_back"],
        );
        const afterRollback = yield* turn(source, 6, RECALL);
        assert.equal(runOf(afterRollback, 6).status, "completed");
        assert.include(answerOf(afterRollback, 6), ALPHA);
        assert.notInclude(answerOf(afterRollback, 6), BRAVO);
      }).pipe(Effect.provide(serverLayer(harness)));

      const types = incomingTypes(harness.native.events);
      assert.include(types, "command_lifecycle");
      const pids = recordedPids(harness.pidFile);
      assert.isAtLeast(pids.length, 4, "each open started a recorded sidecar");
      assert.deepEqual(pids.filter(alive), [], "no sidecar outlives its server");
      yield* saveNativeLog(harness);
    }).pipe(Effect.scoped, Effect.provide(harnessLayer)),
  );
});

// About 20k tokens of prose, under the Read tool's 25k cap, so one read carries a 40k trigger.
const NOTES = Array.from(
  { length: 1_400 },
  (_, line) =>
    `line ${line}: the harness keeps this note so the model reads past the compact trigger.`,
).join("\n");

const WORK = [
  "Use the Bash tool to run `sleep 8; wc -c notes.txt`.",
  "Then use the Read tool to read notes.txt in full.",
  "Then reply with the codeword I asked you to remember and the byte count.",
].join(" ");

const processTable = () =>
  NodeChildProcess.execFileSync("ps", ["-eo", "pid=,ppid=,pgid=,args="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match === null
        ? []
        : [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), line }];
    });

/** Every live process under the recorded sidecars, with its forest line. */
const descendants = (roots: ReadonlyArray<number>) => {
  const table = processTable();
  const found = new Set(roots.filter(alive));
  for (let grew = true; grew;) {
    grew = false;
    for (const row of table) {
      if (!found.has(row.pid) && (found.has(row.ppid) || found.has(row.pgid))) {
        found.add(row.pid);
        grew = true;
      }
    }
  }
  return table.filter((row) => found.has(row.pid));
};

const userMessage = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
});

// A stdio MCP server with one tool, so each open registers a server the CLI starts and lists.
const PROBE_MCP = `
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result =
    request.method === "initialize"
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1.0.0" } }
      : request.method === "tools/list"
        ? { tools: [{ name: "ping", description: "Reply pong", inputSchema: { type: "object", properties: {} } }] }
        : {};
  send({ jsonrpc: "2.0", id: request.id, result });
});
`;

interface OpenSample {
  readonly kind: "stock" | "lhc-fresh" | "lhc-restart";
  readonly round: number;
  readonly openToInitMs: number;
  readonly setMcpServersMs: number;
  readonly sessionId: string;
}

/** Opens one query, sends one short prompt, and times the open and the first `init`. */
const probeOpen = Effect.fn("probeOpen")(function* (
  runner: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape,
  harness: Harness,
  input: {
    readonly kind: OpenSample["kind"];
    readonly round: number;
    readonly nativeThreadId: string;
    readonly resume: boolean;
    readonly mcpScript: string;
  },
) {
  const started = yield* Clock.currentTimeMillis;
  const session = yield* runner.open({
    providerSessionId: ProviderSessionId.make(`session:perf:${input.kind}:${input.round}`),
    thread: threadContext(harness, ThreadId.make(`thread:perf:${input.kind}:${input.round}`)),
    options: ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: { instanceId: INSTANCE_ID, model: MODEL },
      nativeThreadId: input.nativeThreadId,
      resume: input.resume,
      cwd: harness.cwd,
      settings: { ...DEFAULT_SETTINGS, binaryPath: harness.binaryPath },
      environment: harness.environment,
      mcpServers: {
        probe: { type: "stdio", command: process.execPath, args: [input.mcpScript] },
      },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    }),
  });
  const opened = yield* Clock.currentTimeMillis;
  const init = yield* Deferred.make<number>();
  const result = yield* Deferred.make<string>();
  yield* session.messages.pipe(
    Stream.runForEach((message) =>
      message.type === "system" && message.subtype === "init"
        ? Clock.currentTimeMillis.pipe(Effect.flatMap((at) => Deferred.succeed(init, at)))
        : message.type === "result"
          ? Deferred.succeed(result, message.session_id)
          : Effect.void,
    ),
    Effect.forkScoped,
  );
  yield* session.offer(userMessage("Reply with only the word OK."));
  const initAt = yield* Deferred.await(init);
  const sessionId = yield* Deferred.await(result);
  yield* session.close;
  return {
    kind: input.kind,
    round: input.round,
    openToInitMs: initAt - started,
    setMcpServersMs: opened - started,
    sessionId,
  } satisfies OpenSample;
});

const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
};

describe.runIf(unix && LIVE)("Claude LHC on a real model", () => {
  it.live("runs a tool turn across a mid-turn compact, then the message queued during it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("lane-2", { trigger: 40_000, target: 20_000 });
      const threadId = ThreadId.make("thread:claude-lhc-harness:lane-2");
      yield* Effect.sync(() =>
        NodeFS.writeFileSync(NodePath.join(harness.cwd, "notes.txt"), NOTES),
      );

      const { projection, forest } = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* createThread(threadId, harness.cwd);
        yield* turn(threadId, 1, teach(ALPHA));
        const toolRunning = yield* watchFor(
          (event) =>
            event.type === "turn-item.updated" &&
            event.threadId === threadId &&
            event.payload.type === "command_execution",
        );
        const workDone = yield* watchFor(runReaches(threadId, 2, settled));
        const queuedDone = yield* watchFor(runReaches(threadId, 3, settled));
        yield* send(threadId, "work", WORK);
        yield* Fiber.join(toolRunning);
        const forest = descendants(recordedPids(harness.pidFile));
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${threadId}:queued`),
          threadId,
          messageId: MessageId.make(`message:${threadId}:queued`),
          text: RECALL,
          attachments: [],
          modelSelection: { instanceId: INSTANCE_ID, model: MODEL },
          dispatchMode: { type: "queue_after_active" },
        } satisfies OrchestrationV2Command);
        yield* Fiber.join(workDone);
        yield* Fiber.join(queuedDone);
        return { projection: yield* projectionOf(threadId), forest };
      }).pipe(Effect.scoped, Effect.provide(serverLayer(harness)));

      yield* saveEvidence(harness, "ps-forest.txt", forest.map((row) => row.line).join("\n"));
      yield* saveNativeLog(harness);
      const work = runOf(projection, 2);
      const queued = runOf(projection, 3);
      assert.equal(work.status, "completed");
      assert.include(
        answerOf(projection, 2),
        ALPHA,
        "the turn recalls a fact from before the compact",
      );
      assert.include(
        NodeFS.readFileSync(harness.sidecarLog, "utf8"),
        "[lhc compact:auto]",
        "the sidecar compacted during the turn",
      );
      assert.include(incomingTypes(harness.native.events), "command_lifecycle");
      assert.equal(queued.status, "completed");
      assert.isTrue(
        DateTime.isGreaterThanOrEqualTo(queued.startedAt!, work.completedAt!),
        "the queued message runs after the turn",
      );
      assert.isAbove(forest.length, 1, "the sidecar and its CLI were running during the turn");
      assert.deepEqual(
        forest.map((row) => row.pid).filter(alive),
        [],
        "no recorded PID survives close",
      );
    }).pipe(Effect.scoped, Effect.provide(harnessLayer)),
  );

  it.live("opens an LHC thread fresh and on restart within the budget against stock opens", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("perf", { trigger: 700_000, target: 140_000 });
      const mcpScript = NodePath.join(harness.root, "probe-mcp.mjs");
      yield* Effect.sync(() => NodeFS.writeFileSync(mcpScript, PROBE_MCP));
      const lhc = yield* makeRunner(harness, yield* makeLhcSeam(harness));
      const stock = yield* makeRunner(harness);
      const samples: Array<OpenSample> = [];
      for (let round = 1; round <= 3; round++) {
        const probe = (
          runner: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape,
          kind: OpenSample["kind"],
          nativeThreadId: string,
          resume: boolean,
        ) =>
          probeOpen(runner, harness, { kind, round, nativeThreadId, resume, mcpScript }).pipe(
            Effect.scoped,
            Effect.tap((sample) => Effect.sync(() => samples.push(sample))),
          );
        yield* probe(stock, "stock", yield* stock.allocateSessionId, false);
        const fresh = yield* probe(lhc, "lhc-fresh", yield* lhc.allocateSessionId, false);
        yield* probe(lhc, "lhc-restart", fresh.sessionId, true);
      }
      const medianOf = (kind: OpenSample["kind"]) =>
        median(samples.filter((sample) => sample.kind === kind).map((s) => s.openToInitMs));
      const summary = {
        stockMedianMs: medianOf("stock"),
        lhcFreshMedianMs: medianOf("lhc-fresh"),
        lhcRestartMedianMs: medianOf("lhc-restart"),
        maxLhcSetMcpServersMs: Math.max(
          ...samples.filter((s) => s.kind !== "stock").map((s) => s.setMcpServersMs),
        ),
        samples,
      };
      yield* saveEvidence(harness, "perf.json", JSON.stringify(summary, null, 2));
      assert.isAtMost(summary.lhcFreshMedianMs - summary.stockMedianMs, 5_000);
      assert.isAtMost(summary.lhcRestartMedianMs, 15_000);
      assert.isAtMost(summary.maxLhcSetMcpServersMs, 30_000);
    }).pipe(Effect.scoped, Effect.provide(harnessLayer)),
  );
});
