// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and its leftover child are real processes.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2EngineBinding,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { AgentScope, type AgentScopeShape } from "@t3tools/shared/AgentScope";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import * as PortScanner from "../../preview/PortScanner.ts";
import {
  ClaudeAgentSdkQueryRunner,
  type ClaudeAgentSdkQueryOpenInput,
  type ClaudeAgentSdkSessionForkInput,
  type ClaudeAgentSdkSubagentLookupInput,
  type ClaudeQuerySeam,
  type ClaudeThreadContext,
  layerQueryRunner,
  makeClaudeAgentSdkQueryRunner,
  spawnClaudeProcessGroup,
} from "./ClaudeAdapterV2.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const FORK_SESSION_ID = "11111111-1111-4111-8111-111111111111";

const stockThread = (appThreadId: ThreadId): ClaudeThreadContext => ({
  appThreadId,
  engineBinding: null,
});

const writeClaudeSession = Effect.fnUntraced(function* (configDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = path.join(configDir, "projects", "-repo");
  const entry = (uuid: string, parentUuid: string | null, message: unknown) => ({
    type: parentUuid === null ? "user" : "assistant",
    uuid,
    parentUuid,
    sessionId: FORK_SESSION_ID,
    cwd: "/repo",
    isSidechain: false,
    timestamp: "2026-10-01T00:00:00.000Z",
    message,
  });
  yield* fileSystem.makeDirectory(projectDir, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(projectDir, `${FORK_SESSION_ID}.jsonl`),
    [
      entry("aaaaaaaa-0000-4000-8000-000000000001", null, { role: "user", content: "hello" }),
      entry("aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000001", {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  return projectDir;
});

const forkRunnerLayer = layerQueryRunner.pipe(
  Layer.provide(PortScanner.layerTest),
  Layer.provide(Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined })),
);

it.effect("forks a session stored under the instance's own CLAUDE_CONFIG_DIR", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-claude-fork-config-",
      });
      const projectDir = yield* writeClaudeSession(configDir);
      const hostConfigDir = process.env.CLAUDE_CONFIG_DIR;
      const inProcessFork = vi.spyOn(ClaudeSdk, "forkSession");
      yield* Effect.addFinalizer(() => Effect.sync(() => inProcessFork.mockRestore()));

      const runner = yield* ClaudeAgentSdkQueryRunner;
      const forked = yield* runner.forkSession({
        sessionId: FORK_SESSION_ID,
        options: { dir: "/repo" },
        environment: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        threadId: ThreadId.make("thread-fork-config-dir"),
        providerSessionId: ProviderSessionId.make("session-fork-config-dir"),
        thread: stockThread(ThreadId.make("thread-fork-config-dir")),
      });

      assert.notEqual(forked.sessionId, FORK_SESSION_ID);
      const transcript = yield* fileSystem.readFileString(
        path.join(projectDir, `${forked.sessionId}.jsonl`),
      );
      assert.include(transcript, '"content":"hello"');
      assert.include(transcript, '"text":"hi"');
      const inheritedHead = transcript
        .trim()
        .split("\n")
        .findLast((line) => line.includes('"type":"assistant"'))
        ?.match(/"uuid"\s*:\s*"([^"]+)"/)?.[1];
      assert.isString(inheritedHead);
      assert.equal(forked.headMessageId, inheritedHead);
      assert.equal(process.env.CLAUDE_CONFIG_DIR, hostConfigDir);
      assert.equal(inProcessFork.mock.calls.length, 0);
    }).pipe(Effect.provide(forkRunnerLayer)),
  ).pipe(Effect.provide(NodeServices.layer)),
);
const realQueryRunner = layerQueryRunner.pipe(
  Layer.provide(PortScanner.layerTest),
  Layer.provide(
    Layer.succeed(ProviderEventLoggers, {
      native: undefined,
      canonical: undefined,
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const resumedMcpQueryInput = {
  threadId: ThreadId.make("thread-restart-registration"),
  providerSessionId: ProviderSessionId.make("session-restart-registration"),
  thread: stockThread(ThreadId.make("thread-restart-registration")),
  options: {
    resume: FORK_SESSION_ID,
    model: "claude-sonnet-4-6",
    tools: [],
    permissionMode: "default",
    mcpServers: {
      "t3-code": {
        type: "http",
        url: "http://localhost:3773/mcp",
        headers: { Authorization: "Bearer test-mcp-credential" },
      },
    },
  },
} satisfies ClaudeAgentSdkQueryOpenInput;

const lhcBinding = {
  providerInstanceId: ProviderInstanceId.make("claude_lhc"),
  engine: "claude-lhc",
  continuationKey: "claude-lhc:home:/lhc/claude-home",
  claudeHome: "/lhc/claude-home",
  compact: { trigger: 700_000, target: 140_000 },
  nativeContinuation: "required",
  compaction: "provider",
} satisfies OrchestrationV2EngineBinding;

const scopeWrapper = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}) => ["-c", "scope", "t3-agent", input.command, ...input.args];

it.effect(
  "sends every open, fork and subagent lookup of an overriding seam through it with the thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sdkQuery = vi.spyOn(ClaudeSdk, "query");
        const sdkFork = vi.spyOn(ClaudeSdk, "forkSession");
        const sdkSubagentMessages = vi.spyOn(ClaudeSdk, "getSubagentMessages");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sdkQuery.mockRestore();
            sdkFork.mockRestore();
            sdkSubagentMessages.mockRestore();
          }),
        );
        const program = { command: "/opt/lhc/node", args: ["/opt/lhc/sidecar.mjs"] };
        const wrapped: Array<Parameters<AgentScopeShape["wrap"]>[0]> = [];
        const queries: Array<Parameters<ClaudeQuerySeam["createQuery"]>> = [];
        const forks: Array<ClaudeAgentSdkSessionForkInput> = [];
        const lookups: Array<ClaudeAgentSdkSubagentLookupInput> = [];
        const setMcpServers = vi.fn(async () => ({ added: ["t3-code"], removed: [], errors: {} }));
        const runner = yield* makeClaudeAgentSdkQueryRunner({
          program: () => program,
          createQuery: (...call) => {
            queries.push(call);
            return {
              setMcpServers,
              close: vi.fn(),
              [Symbol.asyncDispose]: async () => {},
            } as unknown as ClaudeSdk.Query;
          },
          forkSession: (input) =>
            Effect.sync(() => {
              forks.push(input);
              return { sessionId: "forked-lhc-session" };
            }),
          subagentLaunchToolUseId: (input) =>
            Effect.sync(() => {
              lookups.push(input);
              return "toolu-launch";
            }),
        }).pipe(
          Effect.provideService(ProviderEventLoggers, { native: undefined, canonical: undefined }),
          Effect.provide(PortScanner.layerTest),
          Effect.provideService(AgentScope, {
            ...AgentScope.defaultValue(),
            wrap: (input) => {
              wrapped.push(input);
              return Effect.succeed({
                command: "/bin/sh",
                args: scopeWrapper(input),
                unit: "t3code-claude-seam.scope",
              });
            },
          }),
        );
        const threadId = ThreadId.make("thread-lhc-seam");
        const providerSessionId = ProviderSessionId.make("session-lhc-seam");
        const thread = {
          appThreadId: threadId,
          engineBinding: lhcBinding,
        } satisfies ClaudeThreadContext;

        const session = yield* runner.open({
          ...resumedMcpQueryInput,
          threadId,
          providerSessionId,
          thread,
          options: {
            ...resumedMcpQueryInput.options,
            pathToClaudeCodeExecutable: "/usr/local/bin/claude",
          },
        });
        yield* Effect.addFinalizer(() => session.close.pipe(Effect.orDie));
        const forked = yield* runner.forkSession({
          sessionId: FORK_SESSION_ID,
          options: { dir: "/repo" },
          environment: process.env,
          threadId,
          providerSessionId,
          thread,
        });
        const launchToolUseId = yield* runner.subagentLaunchToolUseId({
          sessionId: FORK_SESSION_ID,
          agentId: "agent-lhc-seam",
          dir: "/repo",
          threadId,
          providerSessionId,
          thread,
        });

        assert.deepEqual(
          wrapped.map(({ command, args, name, threadId }) => ({ command, args, name, threadId })),
          [{ ...program, name: "claude", threadId }],
        );
        assert.equal(queries.length, 1);
        const [, options, queryThread, launch] = queries[0]!;
        assert.deepEqual(queryThread, thread);
        assert.deepEqual(launch, { command: "/bin/sh", args: scopeWrapper(program) });
        assert.equal(options.pathToClaudeCodeExecutable, "/usr/local/bin/claude");
        assert.isUndefined(options.executableArgs);
        assert.isUndefined(options.mcpServers);
        assert.isFunction(options.spawnClaudeCodeProcess);
        assert.deepEqual(setMcpServers.mock.calls, [[resumedMcpQueryInput.options.mcpServers]]);
        assert.equal(forked.sessionId, "forked-lhc-session");
        assert.deepEqual(
          forks.map((input) => input.thread),
          [thread],
        );
        assert.equal(launchToolUseId, "toolu-launch");
        assert.deepEqual(
          lookups.map((input) => input.thread),
          [thread],
        );
        assert.equal(sdkQuery.mock.calls.length, 0);
        assert.equal(sdkFork.mock.calls.length, 0);
        assert.equal(sdkSubagentMessages.mock.calls.length, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["exits", "hangs"] as const)(
  "settles close only after the CLI it started exits or is killed: %s",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = new NodeEvents.EventEmitter();
        const stdin = new NodeStream.PassThrough();
        const stdout = new NodeStream.PassThrough();
        const child = {
          stdin,
          stdout,
          killed: false,
          exitCode: null,
          kill: vi.fn(() => true),
          on: events.on.bind(events),
          once: events.once.bind(events),
          off: events.off.bind(events),
        } satisfies ClaudeSdk.SpawnedProcess;
        const signal = yield* Effect.abortSignal;
        const closeQuery = vi.fn();
        const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
          options?.spawnClaudeCodeProcess?.({ command: "claude", args: [], env: {}, signal });
          return {
            close: closeQuery,
            [Symbol.asyncDispose]: async () => {},
          } as unknown as ClaudeSdk.Query;
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            querySpy.mockRestore();
            stdin.destroy();
            stdout.destroy();
          }),
        );
        const runner = yield* ClaudeAgentSdkQueryRunner;
        const { mcpServers: _mcpServers, ...options } = resumedMcpQueryInput.options;
        const session = yield* runner.open({
          ...resumedMcpQueryInput,
          options: { ...options, spawnClaudeCodeProcess: () => child },
        });

        const closing = yield* session.close.pipe(Effect.forkChild);
        yield* TestClock.adjust("9 seconds");
        assert.equal(closeQuery.mock.calls.length, 1);
        assert.isUndefined(closing.pollUnsafe());
        if (outcome === "exits") events.emit("exit", 0, null);
        else yield* TestClock.adjust("1 second");
        yield* Fiber.join(closing);
        assert.deepEqual(child.kill.mock.calls, outcome === "exits" ? [] : [["SIGKILL"]]);
      }).pipe(Effect.provide(realQueryRunner)),
    ),
);

// Captured from trunk 6ee78589e6's runner with this input, so stock Claude's SDK options stay identical.
const TRUNK_STOCK_QUERY_OPTIONS = {
  scoped: {
    sessionId: "native-thread-stock-options",
    model: "claude-sonnet-4-6",
    tools: { type: "preset", preset: "claude_code" },
    permissionMode: "default",
    cwd: "/repo",
    env: { PATH: "/usr/bin", T3CODE_THREAD_ID: "thread-stock-options" },
    executableArgs: ["-c", "scope", "t3-agent", "/usr/local/bin/claude", "--no-warnings"],
    extraArgs: { "debug-to-stderr": null },
    settings: { showThinkingSummaries: true },
    canUseTool: "[function]",
    pathToClaudeCodeExecutable: "/bin/sh",
    spawnClaudeCodeProcess: "[function]",
  },
  script: {
    sessionId: "native-thread-stock-options",
    model: "claude-sonnet-4-6",
    tools: { type: "preset", preset: "claude_code" },
    permissionMode: "default",
    cwd: "/repo",
    env: { PATH: "/usr/bin", T3CODE_THREAD_ID: "thread-stock-options" },
    executableArgs: ["--no-warnings"],
    extraArgs: { "debug-to-stderr": null },
    settings: { showThinkingSummaries: true },
    canUseTool: "[function]",
    pathToClaudeCodeExecutable: "/opt/claude/cli.js",
    spawnClaudeCodeProcess: "[function]",
  },
} as const;

it.effect.each(["scoped", "script"] as const)(
  "hands the SDK the same %s stock query options as trunk",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(
          () =>
            ({
              setMcpServers: async () => ({ added: ["t3-code"], removed: [], errors: {} }),
              close: vi.fn(),
              [Symbol.asyncDispose]: async () => {},
            }) as unknown as ClaudeSdk.Query,
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
        const threadId = ThreadId.make("thread-stock-options");
        const session = yield* Effect.gen(function* () {
          const runner = yield* ClaudeAgentSdkQueryRunner;
          return yield* runner.open({
            threadId,
            providerSessionId: ProviderSessionId.make("session-stock-options"),
            thread: stockThread(threadId),
            options: {
              sessionId: "native-thread-stock-options",
              model: "claude-sonnet-4-6",
              tools: { type: "preset", preset: "claude_code" },
              permissionMode: "default",
              cwd: "/repo",
              env: { PATH: "/usr/bin" },
              executableArgs: ["--no-warnings"],
              extraArgs: { "debug-to-stderr": null },
              settings: { showThinkingSummaries: true },
              canUseTool: async () => ({ behavior: "deny", message: "test" }),
              mcpServers: resumedMcpQueryInput.options.mcpServers,
              pathToClaudeCodeExecutable:
                kind === "scoped" ? "/usr/local/bin/claude" : "/opt/claude/cli.js",
            },
          });
        }).pipe(
          Effect.provide(
            realQueryRunner.pipe(
              Layer.provide(
                Layer.succeed(AgentScope, {
                  ...AgentScope.defaultValue(),
                  wrap: (input) =>
                    Effect.succeed({
                      command: "/bin/sh",
                      args: scopeWrapper(input),
                      unit: "t3code-claude-options.scope",
                    }),
                }),
              ),
            ),
          ),
        );
        yield* Effect.addFinalizer(() => session.close.pipe(Effect.orDie));

        assert.equal(querySpy.mock.calls.length, 1);
        assert.equal(
          JSON.stringify(querySpy.mock.calls[0]![0].options, (_key, value: unknown) =>
            typeof value === "function" ? "[function]" : value,
          ),
          JSON.stringify(TRUNK_STOCK_QUERY_OPTIONS[kind]),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reopens a stalled MCP registration before delivering the resumed prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const disposalStarted = Promise.withResolvers<void>();
      const finishDisposal = Promise.withResolvers<void>();
      const prompts: AsyncIterable<ClaudeSdk.SDKUserMessage>[] = [];
      const firstClose = vi.fn();
      const secondClose = vi.fn();
      const firstRegistration = vi.fn(() => {
        registrationStarted.resolve();
        return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
      });
      const secondRegistration = vi.fn(async () => ({
        added: ["t3-code"],
        removed: [],
        errors: {},
      }));
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ prompt }) => {
        assert.notTypeOf(prompt, "string");
        if (typeof prompt === "string") throw new Error("Expected streaming input");
        prompts.push(prompt);
        return {
          setMcpServers: prompts.length === 1 ? firstRegistration : secondRegistration,
          close: prompts.length === 1 ? firstClose : secondClose,
          [Symbol.asyncDispose]: async () => {
            firstClose();
            disposalStarted.resolve();
            await finishDisposal.promise;
          },
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner.open(resumedMcpQueryInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");
      yield* Effect.promise(() => disposalStarted.promise);
      assert.equal(querySpy.mock.calls.length, 1);
      finishDisposal.resolve();
      const session = yield* Fiber.join(opening);
      yield* Effect.addFinalizer(() => session.close.pipe(Effect.orDie));

      assert.equal(firstClose.mock.calls.length, 1);
      assert.equal(secondClose.mock.calls.length, 0);
      assert.equal(querySpy.mock.calls.length, 2);
      for (const [call] of querySpy.mock.calls) {
        assert.equal(call.options?.resume, FORK_SESSION_ID);
        assert.isUndefined(call.options?.mcpServers);
      }
      assert.deepEqual(secondRegistration.mock.calls, [[resumedMcpQueryInput.options.mcpServers]]);
      const message = {
        type: "user",
        message: { role: "user", content: "Continue where you left off." },
        parent_tool_use_id: null,
        session_id: FORK_SESSION_ID,
      } satisfies ClaudeSdk.SDKUserMessage;
      yield* session.offer(message);
      assert.isTrue((yield* Effect.promise(() => prompts[0]![Symbol.asyncIterator]().next())).done);
      const delivered = yield* Effect.promise(() => prompts[1]![Symbol.asyncIterator]().next());
      assert.deepEqual(delivered.value, message);
      assert.isFalse(delivered.done);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect.each([true, false])("only retries after confirmed process exit: %s", (exits) =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const cleanupProgress = Promise.withResolvers<"kill" | "retry">();
      const events = new NodeEvents.EventEmitter();
      const stdin = new NodeStream.PassThrough();
      const stdout = new NodeStream.PassThrough();
      const child = {
        stdin,
        stdout,
        killed: false,
        exitCode: null,
        kill: vi.fn(() => {
          cleanupProgress.resolve("kill");
          return true;
        }),
        on: events.on.bind(events),
        once: events.once.bind(events),
        off: events.off.bind(events),
      } satisfies ClaudeSdk.SpawnedProcess;
      const signal = yield* Effect.abortSignal;
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
        const first = querySpy.mock.calls.length === 1;
        if (first) {
          options?.spawnClaudeCodeProcess?.({ command: "claude", args: [], env: {}, signal });
        } else {
          cleanupProgress.resolve("retry");
        }
        return {
          setMcpServers: () => {
            registrationStarted.resolve();
            return first
              ? new Promise<ClaudeSdk.McpSetServersResult>(() => {})
              : Promise.resolve({ added: ["t3-code"], removed: [], errors: {} });
          },
          close: vi.fn(),
          [Symbol.asyncDispose]: disposed,
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          querySpy.mockRestore();
          stdin.destroy();
          stdout.destroy();
        }),
      );
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner
        .open({
          ...resumedMcpQueryInput,
          options: { ...resumedMcpQueryInput.options, spawnClaudeCodeProcess: () => child },
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");

      assert.equal(yield* Effect.promise(() => cleanupProgress.promise), "kill");
      assert.equal(querySpy.mock.calls.length, 1);
      assert.deepEqual(child.kill.mock.calls, [["SIGKILL"]]);
      if (exits) events.emit("exit", null, "SIGKILL");
      else yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(opening);
      assert.equal(Exit.isSuccess(result), exits);
      if (Exit.isSuccess(result)) yield* result.value.close;
      assert.equal(querySpy.mock.calls.length, exits ? 2 : 1);
      assert.equal(disposed.mock.calls.length, 1);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect("stops retrying MCP registration after two timeouts and reports the cause", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstRegistration = Promise.withResolvers<void>();
      const secondRegistration = Promise.withResolvers<void>();
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(() => {
        const started = querySpy.mock.calls.length === 1 ? firstRegistration : secondRegistration;
        return {
          setMcpServers: () => {
            started.resolve();
            return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
          },
          [Symbol.asyncDispose]: disposed,
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner
        .open(resumedMcpQueryInput)
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => firstRegistration.promise);
      yield* TestClock.adjust("90 seconds");
      yield* Effect.promise(() => secondRegistration.promise);
      yield* TestClock.adjust("90 seconds");
      const result = yield* Fiber.join(opening);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.equal(querySpy.mock.calls.length, 2);
      assert.equal(disposed.mock.calls.length, 2);
      assert.equal(
        makeProviderFailure({
          cause: { _tag: "ProviderAdapterTurnStartError", cause: result.failure },
        }).message,
        "Claude timed out while registering its MCP tools. Retry the turn; if it keeps failing, check Claude and the server logs.",
      );
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect("cancels a stalled registration without retrying or retaining its prompt queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            setMcpServers: () => {
              registrationStarted.resolve();
              return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
            },
            [Symbol.asyncDispose]: disposed,
          }) as unknown as ClaudeSdk.Query,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner.open(resumedMcpQueryInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* Fiber.interrupt(opening);

      assert.equal(querySpy.mock.calls.length, 1);
      assert.equal(disposed.mock.calls.length, 1);
      const prompt = querySpy.mock.calls[0]![0].prompt;
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      assert.isTrue((yield* Effect.promise(() => prompt[Symbol.asyncIterator]().next())).done);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect("does not reuse a fresh session ID after MCP registration times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            setMcpServers: () => {
              registrationStarted.resolve();
              return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
            },
            [Symbol.asyncDispose]: disposed,
          }) as unknown as ClaudeSdk.Query,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const { resume, ...options } = resumedMcpQueryInput.options;
      const opening = yield* runner
        .open({
          ...resumedMcpQueryInput,
          options: { ...options, sessionId: resume },
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");
      const result = yield* Fiber.join(opening);

      assert.equal(result._tag, "Failure");
      assert.equal(querySpy.mock.calls.length, 1);
      assert.equal(disposed.mock.calls.length, 1);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

function fakeClaudeCli(script: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-"));
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return cli;
}

const openFakeCli = (cli: string) =>
  Effect.gen(function* () {
    const runner = yield* ClaudeAgentSdkQueryRunner;
    return yield* runner.open({
      threadId: ThreadId.make("thread-fake-cli"),
      providerSessionId: ProviderSessionId.make("session-fake-cli"),
      thread: stockThread(ThreadId.make("thread-fake-cli")),
      options: {
        sessionId: "native-session-fake-cli",
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        pathToClaudeCodeExecutable: cli,
      },
    });
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI process", () => {
  // The leftover child holds a FIFO open; its death produces EOF without polling.
  it.effect("stops what the CLI left running when the session closes", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          'sleep 600 > "$dir/alive" &',
          'echo $! > "$dir/leftover.pid"',
          "cat > /dev/null",
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(Number(NodeFS.readFileSync(NodePath.join(dir, "leftover.pid"), "utf8")));
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const leftoverStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const leftoverStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();

      const stopped = yield* Deferred.make<string>();
      const session = yield* openFakeCli(cli).pipe(
        Effect.provide(
          realQueryRunner.pipe(
            Layer.provide(
              Layer.succeed(AgentScope, {
                ...AgentScope.defaultValue(),
                wrap: ({ command, args }) =>
                  Effect.succeed({ command, args, unit: "t3code-claude-test.scope" }),
                stop: (unit) => Deferred.succeed(stopped, unit).pipe(Effect.asVoid),
              }),
            ),
          ),
        ),
      );
      yield* Effect.promise(() => leftoverStarted);
      yield* session.close;
      yield* Effect.promise(() => leftoverStopped);
      assert.strictEqual(yield* Deferred.await(stopped), "t3code-claude-test.scope");
    }),
  );

  it.effect("supervises a seam's program like the CLI and waits for its exit on close", () => {
    let runningAgents = 0;
    return Effect.gen(function* () {
      const program = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          'sleep 600 > "$dir/alive" &',
          'echo $! > "$dir/leftover.pid"',
          "cat > /dev/null",
        ].join("\n"),
      );
      const dir = NodePath.dirname(program);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(Number(NodeFS.readFileSync(NodePath.join(dir, "leftover.pid"), "utf8")));
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const leftoverStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const leftoverStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();
      const signal = yield* Effect.abortSignal;
      const stopped = yield* Deferred.make<string>();
      const wrapped: Array<string> = [];

      const seamRunner = yield* makeClaudeAgentSdkQueryRunner({
        program: () => ({ command: program, args: [] }),
        createQuery: (_prompt, options, _thread, launch) => {
          if (launch === undefined) throw new Error("Expected a supervised launch");
          const child = options.spawnClaudeCodeProcess({
            command: launch.command,
            args: [...launch.args],
            env: options.env ?? {},
            signal,
          });
          return {
            close: () => child.stdin.end(),
            [Symbol.asyncDispose]: async () => {},
          } as unknown as ClaudeSdk.Query;
        },
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.die("unused"),
      }).pipe(
        Effect.provideService(ProviderEventLoggers, { native: undefined, canonical: undefined }),
        Effect.provide(
          Layer.mock(PortScanner.PortDiscovery)({
            trackAgent: () => {
              runningAgents += 1;
              return () => {
                runningAgents -= 1;
              };
            },
          }),
        ),
        Effect.provideService(AgentScope, {
          ...AgentScope.defaultValue(),
          wrap: ({ command, args }) => {
            wrapped.push(command);
            return Effect.succeed({ command, args, unit: "t3code-claude-seam.scope" });
          },
          stop: (unit) => Deferred.succeed(stopped, unit).pipe(Effect.asVoid),
        }),
      );
      const session = yield* seamRunner.open({
        threadId: ThreadId.make("thread-seam-program"),
        providerSessionId: ProviderSessionId.make("session-seam-program"),
        thread: stockThread(ThreadId.make("thread-seam-program")),
        options: {
          sessionId: "native-session-seam-program",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
          pathToClaudeCodeExecutable: "/usr/local/bin/claude",
        },
      });
      yield* Effect.promise(() => leftoverStarted);
      assert.deepEqual(wrapped, [program]);
      assert.equal(runningAgents, 1);

      yield* session.close;
      assert.equal(runningAgents, 0);
      yield* Effect.promise(() => leftoverStopped);
      assert.strictEqual(yield* Deferred.await(stopped), "t3code-claude-seam.scope");
    }).pipe(Effect.provide(NodeServices.layer));
  });

  // The CLI keeps running its turn after its pipes close, so a server that
  // crashed would leave it working next to the session it resumes.
  it.effect("stops the CLI when the server that started it goes away", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(['dir=$(dirname "$0")', 'sleep 600 > "$dir/alive"'].join("\n"));
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      const child = spawnClaudeProcessGroup({
        command: cli,
        args: [],
        cwd: dir,
        env: process.env,
        // @effect-diagnostics-next-line abortControllerInEffect:off - This crash fixture closes pipes itself; aborting on test teardown raises an unrelated process error.
        signal: new AbortController().signal,
      }) as NodeChildProcess.ChildProcess;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            signalProcessGroup(child.pid ?? 0, "SIGKILL");
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const turnStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const turnStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();
      yield* Effect.promise(() => turnStarted);

      // A dying server's descriptors close; the kernel would do this for it.
      for (const pipe of child.stdio) pipe?.destroy();
      yield* Effect.promise(() => turnStopped);
    }),
  );

  it.effect("marks the CLI's jobs with its thread and counts it as an agent until it exits", () => {
    let runningAgents = 0;
    let releaseAgent!: () => void;
    const agentReleased = new Promise<void>((resolve) => (releaseAgent = resolve));
    const runner = layerQueryRunner.pipe(
      Layer.provide(
        Layer.mock(PortScanner.PortDiscovery)({
          trackAgent: () => {
            runningAgents += 1;
            return () => {
              runningAgents -= 1;
              releaseAgent();
            };
          },
        }),
      ),
      Layer.provide(
        Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
      ),
      Layer.provide(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          `printf '%s' "$${PortScanner.AGENT_THREAD_ENV}" > "$dir/thread"`,
          "cat > /dev/null",
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "thread")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      const threadRead = new Promise<string>((resolve) => {
        let thread = "";
        NodeFS.createReadStream(NodePath.join(dir, "thread"), "utf8")
          .on("data", (chunk) => (thread += chunk))
          .once("end", () => resolve(thread));
      });

      const session = yield* openFakeCli(cli);
      assert.equal(yield* Effect.promise(() => threadRead), "thread-fake-cli");
      assert.equal(runningAgents, 1);
      yield* session.close;
      yield* Effect.promise(() => agentReleased);
      assert.equal(runningAgents, 0);
    }).pipe(Effect.provide(runner));
  });
});
