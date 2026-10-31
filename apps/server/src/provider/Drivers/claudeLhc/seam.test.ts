// @effect-diagnostics nodeBuiltinImport:off -- the runner's spawner hands claude-lhc a Node ChildProcess.
import * as NodeChildProcess from "node:child_process";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2EngineBinding,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type {
  ClaudeSeamQueryOptions,
  ClaudeThreadContext,
} from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type {
  ClaudeLhcQueryOptions,
  ClaudeRunnerQuery,
  LhcForkSessionOptions,
  LhcSubagentMessagesOptions,
  SidecarSpawnOptions,
} from "./client.ts";
import { ClaudeLhcOperationError } from "./client.ts";
import { ClaudeLhcRuntimeProblem } from "./runtime.ts";
import { makeClaudeLhcSeam, type ClaudeLhcSeamClient } from "./seam.ts";

const RUNTIME = { node: "/opt/lhc/node", sidecar: "/opt/lhc/sidecar.js" };
const STATE_DIR = "/srv/t3/userdata";
const LHC_HOME = "/srv/t3/userdata/lhc";
const CLI = "/usr/local/bin/claude";
const INSTANCE_ENV = { CLAUDE_CONFIG_DIR: "/homes/lhc", CLAUDE_LHC_NO_INFERENCE: "1" };
const QUERY_ENV = { ...INSTANCE_ENV, TMPDIR: "/repo/.pstack/tmp" };
const FORK_HEAD = "claude-lhc-cursor:th_0123456789abcdef:claude-lhc:assistant:msg_1";
const SIGNAL = new AbortController().signal;

const binding = (trigger: number, target: number): OrchestrationV2EngineBinding => ({
  providerInstanceId: ProviderInstanceId.make("claude-lhc"),
  engine: "claude-lhc",
  continuationKey: "claude-lhc:home:/homes/lhc",
  claudeHome: "/homes/lhc",
  compact: { trigger, target },
  nativeContinuation: "required",
  compaction: "provider",
});

const thread = (
  id: string,
  engineBinding: OrchestrationV2EngineBinding | null,
): ClaudeThreadContext => ({ appThreadId: ThreadId.make(id), engineBinding });

const idleQuery: ClaudeRunnerQuery = {
  next: () => Promise.resolve({ done: true, value: undefined }),
  [Symbol.asyncDispose]: () => Promise.resolve(),
  setMcpServers: () => Promise.resolve({ added: [], removed: [], errors: {} }),
  setModel: () => Promise.resolve(),
  applyFlagSettings: () => Promise.resolve(),
  setPermissionMode: () => Promise.resolve(),
  stopTask: () => Promise.resolve(),
  backgroundTasks: () => Promise.resolve(false),
  interrupt: () => Promise.resolve(undefined),
  close: () => {},
};

const prompt: AsyncIterable<SDKUserMessage> = (async function* () {})();

function recordingClient(options: { readonly failFork?: boolean } = {}) {
  const queries: Array<ClaudeLhcQueryOptions> = [];
  const forks: Array<readonly [string, LhcForkSessionOptions]> = [];
  const lookups: Array<readonly [string, string, LhcSubagentMessagesOptions]> = [];
  const client: ClaudeLhcSeamClient = {
    query: (_prompt, queryOptions) => {
      queries.push(queryOptions);
      return idleQuery;
    },
    forkSession: (sessionId, forkOptions) => {
      forks.push([sessionId, forkOptions]);
      return options.failFork === true
        ? Effect.fail(
            new ClaudeLhcOperationError({ operation: "forkSession", cause: "store locked" }),
          )
        : Effect.succeed({ sessionId: "fork-session", headMessageId: FORK_HEAD });
    },
    getSubagentMessages: (sessionId, agentId, lookupOptions) => {
      lookups.push([sessionId, agentId, lookupOptions]);
      return Effect.succeed([
        {
          type: "user",
          uuid: "subagent-first",
          session_id: sessionId,
          message: { role: "user", content: "task" },
          parent_tool_use_id: "toolu_launch",
          parent_agent_id: null,
        },
      ]);
    },
  };
  return { client, queries, forks, lookups };
}

function recordingSpawner(child: unknown = new NodeChildProcess.ChildProcess()) {
  const spawned: Array<SidecarSpawnOptions> = [];
  const spawnClaudeCodeProcess = ((spawnOptions: SidecarSpawnOptions) => {
    spawned.push(spawnOptions);
    return child;
  }) as ClaudeSeamQueryOptions["spawnClaudeCodeProcess"];
  return { spawned, spawnClaudeCodeProcess };
}

const queryOptions = (
  spawnClaudeCodeProcess: ClaudeSeamQueryOptions["spawnClaudeCodeProcess"],
): ClaudeSeamQueryOptions => ({
  resume: "native-session",
  model: "claude-sonnet-5",
  tools: { type: "preset", preset: "claude_code" },
  permissionMode: "default",
  pathToClaudeCodeExecutable: CLI,
  env: QUERY_ENV,
  spawnClaudeCodeProcess,
});

const LAUNCH = { command: "/usr/bin/systemd-run", args: ["--user", "--scope", "--", RUNTIME.node] };

const seam = (
  client: ClaudeLhcSeamClient,
  runtime: Result.Result<typeof RUNTIME, ClaudeLhcRuntimeProblem> = Result.succeed(RUNTIME),
) =>
  makeClaudeLhcSeam({
    runtime,
    stateDir: STATE_DIR,
    environment: INSTANCE_ENV,
    binaryPath: CLI,
    client,
  }).pipe(Effect.provide(NodeServices.layer));

describe("makeClaudeLhcSeam", () => {
  it.effect("runs the resolved Node and sidecar as the runner's program", () =>
    Effect.gen(function* () {
      const lhc = yield* seam(recordingClient().client);
      assert.deepEqual(lhc.program(queryOptions(recordingSpawner().spawnClaudeCodeProcess)), {
        command: RUNTIME.node,
        args: [RUNTIME.sidecar],
      });
    }),
  );

  it.effect("opens each thread on the store under the state dir with its own row's pair", () =>
    Effect.gen(function* () {
      const recorded = recordingClient();
      const lhc = yield* seam(recorded.client);
      const { spawnClaudeCodeProcess } = recordingSpawner();
      lhc.createQuery(
        prompt,
        queryOptions(spawnClaudeCodeProcess),
        thread("thread-a", binding(40_000, 20_000)),
        LAUNCH,
      );
      lhc.createQuery(
        prompt,
        queryOptions(spawnClaudeCodeProcess),
        thread("thread-b", binding(700_000, 140_000)),
        LAUNCH,
      );
      const [first, second] = recorded.queries;
      assert.equal(first?.lhc.home, LHC_HOME);
      assert.deepEqual(first?.lhc.compact, { trigger: 40_000, target: 20_000 });
      assert.equal(second?.lhc.home, LHC_HOME);
      assert.deepEqual(second?.lhc.compact, { trigger: 700_000, target: 140_000 });
      assert.notProperty(first, "spawnClaudeCodeProcess");
      assert.equal(first?.resume, "native-session");
      assert.equal(first?.pathToClaudeCodeExecutable, CLI);
    }),
  );

  it.effect("starts the scope-wrapped sidecar through the runner's spawner, in the query env", () =>
    Effect.gen(function* () {
      const recorded = recordingClient();
      const lhc = yield* seam(recorded.client);
      const child = new NodeChildProcess.ChildProcess();
      const spawner = recordingSpawner(child);
      lhc.createQuery(
        prompt,
        queryOptions(spawner.spawnClaudeCodeProcess),
        thread("thread-a", binding(40_000, 20_000)),
        LAUNCH,
      );
      const sidecar = recorded.queries[0]!.lhc;
      assert.deepEqual(sidecar.spawn, { ...LAUNCH, env: QUERY_ENV });

      const spawnOptions = { ...LAUNCH, env: QUERY_ENV, signal: SIGNAL };
      assert.strictEqual(sidecar.spawnProcess?.(spawnOptions), child);
      assert.deepEqual(spawner.spawned, [spawnOptions]);
    }),
  );

  it.effect("refuses a sidecar process the runner's spawner did not start as a ChildProcess", () =>
    Effect.gen(function* () {
      const recorded = recordingClient();
      const lhc = yield* seam(recorded.client);
      const spawner = recordingSpawner({ stdin: null, stdout: null });
      lhc.createQuery(
        prompt,
        queryOptions(spawner.spawnClaudeCodeProcess),
        thread("thread-a", binding(40_000, 20_000)),
        LAUNCH,
      );
      assert.throws(
        () =>
          recorded.queries[0]!.lhc.spawnProcess?.({ ...LAUNCH, env: QUERY_ENV, signal: SIGNAL }),
        "The Claude query runner did not spawn the claude-lhc sidecar.",
      );
    }),
  );

  it.effect("refuses to open a thread with no binding or no pair, naming the thread", () =>
    Effect.gen(function* () {
      const recorded = recordingClient();
      const lhc = yield* seam(recorded.client);
      const { spawnClaudeCodeProcess } = recordingSpawner();
      const open = (context: ClaudeThreadContext) => () =>
        lhc.createQuery(prompt, queryOptions(spawnClaudeCodeProcess), context, LAUNCH);

      assert.throws(
        open(thread("thread-stock", null)),
        "Claude LHC cannot open thread thread-stock, because it has no engine binding.",
      );
      assert.throws(
        open(thread("thread-invalid", { ...binding(40_000, 20_000), compact: null })),
        "Claude LHC cannot open thread thread-invalid, because its engine binding has no compact policy.",
      );
      assert.lengthOf(recorded.queries, 0);
    }),
  );

  it.effect("forks in a sidecar with the instance's env and real CLI and keeps the cursor", () =>
    Effect.gen(function* () {
      const recorded = recordingClient();
      const lhc = yield* seam(recorded.client);
      const environment = QUERY_ENV;
      const fork = yield* lhc.forkSession({
        sessionId: "native-session",
        options: { dir: "/repo", upToMessageId: FORK_HEAD },
        environment,
        providerSessionId: ProviderSessionId.make("session"),
        thread: thread("thread-fork", binding(40_000, 20_000)),
      });
      assert.deepEqual(recorded.forks, [
        [
          "native-session",
          {
            dir: "/repo",
            upToMessageId: FORK_HEAD,
            env: environment,
            pathToClaudeCodeExecutable: CLI,
            lhc: {
              home: LHC_HOME,
              spawn: { command: RUNTIME.node, args: [RUNTIME.sidecar], env: environment },
            },
          },
        ],
      ]);
      assert.deepEqual(fork.result, { sessionId: "fork-session", headMessageId: FORK_HEAD });
      assert.equal(yield* fork.inheritedHead, FORK_HEAD);
    }),
  );

  it.effect("fails a fork with the store's reason", () =>
    Effect.gen(function* () {
      const lhc = yield* seam(recordingClient({ failFork: true }).client);
      const error = yield* lhc
        .forkSession({
          sessionId: "native-session",
          options: {},
          environment: INSTANCE_ENV,
          providerSessionId: ProviderSessionId.make("session"),
          thread: thread("thread-fork", binding(40_000, 20_000)),
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ClaudeAgentSdkQueryRunnerError");
      assert.equal(error.method, "forkSession");
      assert.include(String(error.cause), "store locked");
    }),
  );

  it.effect("looks up a subagent's launch in a sidecar with the instance's env and real CLI", () =>
    Effect.gen(function* () {
      const recorded = recordingClient();
      const lhc = yield* seam(recorded.client);
      const lookup = (dir: string | null) =>
        lhc.subagentLaunchToolUseId({
          sessionId: "native-session",
          agentId: "agent-1",
          dir,
          providerSessionId: ProviderSessionId.make("session"),
          thread: thread("thread-a", binding(40_000, 20_000)),
        });
      assert.equal(yield* lookup("/repo"), "toolu_launch");
      assert.equal(yield* lookup(null), "toolu_launch");
      const store = {
        env: INSTANCE_ENV,
        pathToClaudeCodeExecutable: CLI,
        lhc: {
          home: LHC_HOME,
          spawn: { command: RUNTIME.node, args: [RUNTIME.sidecar], env: INSTANCE_ENV },
        },
      };
      assert.deepEqual(recorded.lookups, [
        ["native-session", "agent-1", { dir: "/repo", limit: 1, ...store }],
        ["native-session", "agent-1", { limit: 1, ...store }],
      ]);
    }),
  );

  it.effect("fails every open, fork and lookup with the runtime's problem", () =>
    Effect.gen(function* () {
      const recorded = recordingClient();
      const problem = new ClaudeLhcRuntimeProblem({
        detail: "LHC runtime not staged for linux-x64",
      });
      const lhc = yield* seam(recorded.client, Result.fail(problem));
      const { spawnClaudeCodeProcess } = recordingSpawner();
      assert.isUndefined(lhc.program(queryOptions(spawnClaudeCodeProcess)));
      assert.throws(
        () =>
          lhc.createQuery(
            prompt,
            queryOptions(spawnClaudeCodeProcess),
            thread("thread-a", binding(40_000, 20_000)),
            undefined,
          ),
        "LHC runtime not staged for linux-x64",
      );
      const fork = yield* lhc
        .forkSession({
          sessionId: "native-session",
          options: {},
          environment: INSTANCE_ENV,
          providerSessionId: ProviderSessionId.make("session"),
          thread: thread("thread-a", binding(40_000, 20_000)),
        })
        .pipe(Effect.flip);
      assert.strictEqual(fork.cause, problem);
      const lookup = yield* lhc
        .subagentLaunchToolUseId({
          sessionId: "native-session",
          agentId: "agent-1",
          dir: null,
          providerSessionId: ProviderSessionId.make("session"),
          thread: thread("thread-a", binding(40_000, 20_000)),
        })
        .pipe(Effect.flip);
      assert.strictEqual(lookup.cause, problem);
      assert.lengthOf(recorded.queries, 0);
      assert.lengthOf(recorded.forks, 0);
      assert.lengthOf(recorded.lookups, 0);
    }),
  );
});
