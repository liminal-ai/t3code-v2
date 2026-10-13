// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- a local HTTP server stands in for T3's MCP endpoint.
import * as NodeHttp from "node:http";

import type { AgentOptions, RunResult } from "@cursor/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { CursorSettings } from "../settings.ts";
import { CursorProviderCapabilitiesV2, makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

const instanceId = ProviderInstanceId.make("cursor-cloud");
const threadId = ThreadId.make("cursor-cloud-thread");
const modelSelection = { instanceId, model: "composer-2.5" };
const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

interface FakeCloud {
  readonly opened: Array<AgentOptions>;
  readonly sent: Array<{ readonly message: string; readonly options: unknown }>;
  readonly attached: Array<string>;
  readonly cancelled: Array<string>;
}

type FakeRun = Pick<CursorAgentSdk.CursorAgentSdkRun, "wait" | "cancel">;

const finished = (runId: string, extra: Partial<RunResult> = {}): RunResult => ({
  id: runId,
  status: "finished",
  durationMs: 1,
  ...extra,
});

const setup = Effect.fn("setup")(function* (
  run: (runId: string, fake: FakeCloud) => FakeRun,
  runsOn: "local" | "cloud" = "cloud",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-cloud-adapter-" });
  const fake: FakeCloud = { opened: [], sent: [], attached: [], cancelled: [] };
  const toRun = (runId: string): CursorAgentSdk.CursorAgentSdkRun => {
    const made = run(runId, fake);
    return {
      runId,
      agentId: "bc-cloud-agent",
      wait: made.wait,
      cancel: Effect.sync(() => void fake.cancelled.push(runId)).pipe(Effect.andThen(made.cancel)),
    };
  };
  const adapter = yield* makeCursorAdapterV2({
    instanceId,
    settings: yield* decodeCursorSettings({ runtime: runsOn }),
    environment: { HOME: workspace },
  }).pipe(
    Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
      assertComplete: Effect.void,
      open: (input) =>
        Effect.sync(() => {
          fake.opened.push(input.options);
          return {
            agentId: "bc-cloud-agent",
            listMessages: Effect.succeed([]),
            close: Effect.void,
            attach: (runId) =>
              Effect.sync(() => {
                fake.attached.push(runId);
                return toRun(runId);
              }),
            send: (sendInput) =>
              Effect.sync(() => {
                fake.sent.push({
                  message:
                    typeof sendInput.message === "string"
                      ? sendInput.message
                      : sendInput.message.text,
                  options: sendInput.options,
                });
                return toRun(`cloud-run-${fake.sent.length}`);
              }),
          };
        }),
    }),
  );
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: workspace,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("cursor-cloud-session"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const startTurn = (input: {
    readonly runId: string;
    readonly providerThread?: OrchestrationV2ProviderThread;
    readonly text?: string;
    readonly attachments?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
    readonly restartContinuationOfRunId?: string;
  }) =>
    runtime.startTurn({
      threadId,
      providerThread: input.providerThread ?? providerThread,
      modelSelection,
      runtimePolicy,
      runId: RunId.make(input.runId),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      ...(input.restartContinuationOfRunId === undefined
        ? {}
        : { restartContinuationOfRunId: RunId.make(input.restartContinuationOfRunId) }),
      attemptId: RunAttemptId.make(`${input.runId}-attempt`),
      rootNodeId: NodeId.make(`${input.runId}-root`),
      appThread: {
        id: threadId,
        projectId: ProjectId.make("cursor-cloud-project"),
        createdBy: "user",
        creationSource: "web",
        title: "Cursor Cloud",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      message: {
        messageId: MessageId.make(`${input.runId}-message`),
        createdBy: "user",
        creationSource: "web",
        text: input.text ?? "Do the work.",
        attachments: input.attachments ?? [],
      },
    });
  const eventsUntilTerminal = runtime.events.pipe(
    Stream.takeUntil((event) => event.type === "turn.terminal"),
    Stream.runCollect,
  );
  return { adapter, runtime, providerThread, startTurn, eventsUntilTerminal, fake };
});

/** Stands in for T3's MCP endpoint and records each JSON-RPC request. */
const makeFakeMcpEndpoint = (status = 200) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const requests: Array<{ readonly authorization: string | undefined; readonly body: any }> =
        [];
      const server = NodeHttp.createServer((request, response) => {
        let raw = "";
        request.on("data", (chunk) => (raw += chunk));
        request.on("end", () => {
          const body = JSON.parse(raw);
          requests.push({ authorization: request.headers.authorization, body });
          if (status !== 200) {
            response.writeHead(status).end();
            return;
          }
          if (body.id === undefined) {
            response.writeHead(202).end();
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result:
                body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { content: [] },
            }),
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { readonly port: number };
      return { server, requests, endpoint: `http://127.0.0.1:${address.port}/mcp` };
    }),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

/** Gives the thread a T3 MCP session, as the server does for every provider thread. */
const registerMcpSession = (endpoint: string) =>
  McpProviderSessions.McpProviderSessions.pipe(
    Effect.flatMap((mcpSessions) =>
      mcpSessions.set({
        environmentId: EnvironmentId.make("environment"),
        threadId,
        providerSessionId: "cursor-cloud-session",
        providerInstanceId: instanceId,
        endpoint,
        authorizationHeader: "Bearer thread-credential",
        browserToolsAvailable: true,
      }),
    ),
  );

const withPullRequest = (runId: string): RunResult =>
  finished(runId, {
    result: "Opened a pull request.",
    git: {
      branches: [
        {
          repoUrl: "https://github.com/liminal-ai/t3code-v2",
          branch: "cursor/cloud-work",
          prUrl: "https://github.com/liminal-ai/t3code-v2/pull/7",
        },
      ],
    },
  });

const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

describe("CursorAdapterV2 on Cursor Cloud", () => {
  it.effect("runs a turn on a cloud VM without local tools, paths or checkpoints", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const fileSystem = yield* FileSystem.FileSystem;
      const mcp = yield* makeFakeMcpEndpoint();
      yield* registerMcpSession(mcp.endpoint);
      const pasted = {
        type: "file" as const,
        id: "pasted-brief",
        name: "brief.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        source: { _tag: "pasted-text" as const },
      };
      const binary = {
        type: "file" as const,
        id: "tool-binary",
        name: "tool.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 4,
      };
      yield* fileSystem.writeFileString(host.resolveAttachmentPath(pasted)!, "pasted brief");
      const { adapter, startTurn, eventsUntilTerminal, fake } = yield* setup((runId) => ({
        wait: Effect.succeed(withPullRequest(runId)),
        cancel: Effect.void,
      }));

      yield* startTurn({ runId: "t3-run-1", attachments: [pasted, binary] });
      const events = yield* eventsUntilTerminal;

      const capabilities = yield* adapter.getCapabilities();
      assert.isFalse(capabilities.turns.supportsSteeringByInterruptRestart);
      assert.isFalse(capabilities.checkpointing.appCanCheckpointFilesystem);
      assert.equal(capabilities.runtimePolicy.enforcement, "client-boundary");

      const created = fake.opened[0]!;
      assert.isUndefined(created.local);
      assert.isUndefined(created.mcpServers);
      assert.deepStrictEqual(created.cloud, {
        repos: [],
        autoCreatePR: false,
        openAsCursorGithubApp: true,
        metadata: { t3ThreadId: threadId },
      });

      const sent = fake.sent[0]!;
      assert.isTrue(sent.message.startsWith("<cursor_cloud_environment>"));
      assert.include(sent.message, "no repository checked out");
      assert.include(sent.message, '[Attached file "brief.txt" follows inline.]\npasted brief');
      assert.include(sent.message, '[Attached file "tool.bin" was not sent');
      assert.notInclude(sent.message, host.paths.attachmentsDir);
      assert.include(sent.message, "through the Cursor Cloud harness");
      assert.isUndefined((sent.options as { readonly mcpServers?: unknown }).mcpServers);

      const heads = events.flatMap((event) =>
        event.type === "provider_thread.updated"
          ? [event.providerThread.nativeConversationHeadRef]
          : [],
      );
      assert.isAbove(heads.length, 1);
      for (const head of heads) {
        assert.deepStrictEqual(head, {
          driver: CursorAgentSdk.CURSOR_PROVIDER,
          nativeId: "cloud-run-1",
          strength: "strong",
          fingerprint: "t3-run-1",
        });
      }
      const terminal = events.at(-1);
      assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");

      const linked = mcp.requests.filter((request) => request.body.method === "tools/call");
      assert.deepStrictEqual(
        linked.map((request) => request.body.params),
        [
          {
            name: "link_pull_request",
            arguments: { url: "https://github.com/liminal-ai/t3code-v2/pull/7" },
          },
        ],
      );
      assert.equal(linked[0]?.authorization, "Bearer thread-credential");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("completes the turn when linking its pull request fails", () =>
    Effect.gen(function* () {
      const mcp = yield* makeFakeMcpEndpoint(500);
      yield* registerMcpSession(mcp.endpoint);
      const { startTurn, eventsUntilTerminal } = yield* setup((runId) => ({
        wait: Effect.succeed(withPullRequest(runId)),
        cancel: Effect.void,
      }));

      yield* startTurn({ runId: "t3-run-link-fails" });
      const events = yield* eventsUntilTerminal;

      assert.isAbove(mcp.requests.length, 0);
      const terminal = events.at(-1);
      assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps a local instance on this machine's tools, paths and checkpoints", () =>
    Effect.gen(function* () {
      const mcp = yield* makeFakeMcpEndpoint();
      yield* registerMcpSession(mcp.endpoint);
      const { adapter, providerThread, startTurn, eventsUntilTerminal, fake } = yield* setup(
        (runId) => ({ wait: Effect.succeed(withPullRequest(runId)), cancel: Effect.void }),
        "local",
      );

      yield* startTurn({
        runId: "t3-run-local",
        providerThread: {
          ...providerThread,
          firstRunOrdinal: 1,
          nativeConversationHeadRef: {
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeId: "local-run-cut",
            strength: "strong",
            fingerprint: "t3-run-cut",
          },
        },
        restartContinuationOfRunId: "t3-run-cut",
      });
      const events = yield* eventsUntilTerminal;

      assert.deepStrictEqual(yield* adapter.getCapabilities(), CursorProviderCapabilitiesV2);
      const opened = fake.opened[0]!;
      assert.isUndefined(opened.cloud);
      assert.isDefined(opened.local);
      assert.isDefined(opened.mcpServers);
      assert.deepStrictEqual(fake.attached, []);
      const sent = fake.sent[0]!;
      assert.isFalse(sent.message.startsWith("<cursor_cloud_environment>"));
      assert.include(sent.message, "through the Cursor harness");
      assert.isDefined((sent.options as { readonly mcpServers?: unknown }).mcpServers);
      assert.deepStrictEqual(
        mcp.requests.filter((request) => request.body.method === "tools/call"),
        [],
      );
      const head = events.findLast((event) => event.type === "provider_thread.updated");
      assert.equal(
        head?.type === "provider_thread.updated"
          ? head.providerThread.nativeConversationHeadRef?.nativeId
          : undefined,
        "local-run-cut",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect.each([
    { name: "follows the cloud run T3 cut", continues: "t3-run-cut", adopts: true },
    {
      name: "sends a message when the cut run had no cloud run",
      continues: "t3-run-other",
      adopts: false,
    },
  ])("after a T3 restart: $name", ({ continues, adopts }) =>
    Effect.gen(function* () {
      const { providerThread, startTurn, eventsUntilTerminal, fake } = yield* setup((runId) => ({
        wait: Effect.succeed(finished(runId, { result: "Finished while T3 was away." })),
        cancel: Effect.void,
      }));
      const persisted: OrchestrationV2ProviderThread = {
        ...providerThread,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        nativeConversationHeadRef: {
          driver: CursorAgentSdk.CURSOR_PROVIDER,
          nativeId: "cloud-run-cut",
          strength: "strong",
          fingerprint: "t3-run-cut",
        },
      };

      yield* startTurn({
        runId: "t3-run-continue",
        providerThread: persisted,
        text: "Continue where you left off.",
        restartContinuationOfRunId: continues,
      });
      const events = yield* eventsUntilTerminal;

      if (adopts) {
        assert.deepStrictEqual(fake.attached, ["cloud-run-cut"]);
        assert.deepStrictEqual(fake.sent, []);
      } else {
        assert.deepStrictEqual(fake.attached, []);
        assert.equal(fake.sent[0]?.message.startsWith("Continue where you left off."), true);
      }
      const replies = events.flatMap((event) =>
        event.type === "message.updated" && event.message.role === "assistant"
          ? [event.message.text]
          : [],
      );
      assert.include(replies, "Finished while T3 was away.");
      const head = events.findLast((event) => event.type === "provider_thread.updated");
      assert.deepStrictEqual(
        head?.type === "provider_thread.updated"
          ? head.providerThread.nativeConversationHeadRef
          : undefined,
        {
          driver: CursorAgentSdk.CURSOR_PROVIDER,
          nativeId: adopts ? "cloud-run-cut" : "cloud-run-1",
          strength: "strong",
          fingerprint: "t3-run-continue",
        },
      );
      const terminal = events.at(-1);
      assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("ends a stopped turn once Cursor reports the cloud run cancelled", () =>
    Effect.gen(function* () {
      const remoteStopped = yield* Deferred.make<void>();
      const { runtime, providerThread, startTurn, fake } = yield* setup((runId) => ({
        // Cursor's stream reports the terminal status only after the cancel.
        wait: Deferred.await(remoteStopped).pipe(
          Effect.as({ ...finished(runId), status: "cancelled" as const }),
        ),
        cancel: Deferred.succeed(remoteStopped, undefined).pipe(Effect.asVoid),
      }));

      yield* startTurn({ runId: "t3-run-stop" });
      const running = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "provider_turn.updated"),
        Stream.runHead,
      );
      assert.equal(running._tag, "Some");
      const providerTurnId =
        running._tag === "Some" && running.value.type === "provider_turn.updated"
          ? running.value.providerTurn.id
          : undefined;

      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      const terminal = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );

      assert.deepStrictEqual(fake.cancelled, ["cloud-run-1"]);
      assert.equal(
        terminal._tag === "Some" && terminal.value.type === "turn.terminal"
          ? terminal.value.status
          : undefined,
        "interrupted",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect.each([
    { runtime: "cloud", wait: "31 seconds", status: "failed" },
    { runtime: "local", wait: "11 seconds", status: "interrupted" },
  ] as const)("a stop Cursor never confirms on $runtime ends $status", (expected) =>
    Effect.gen(function* () {
      const { runtime, providerThread, startTurn } = yield* setup(
        () => ({ wait: Effect.never, cancel: Effect.void }),
        expected.runtime,
      );

      yield* startTurn({ runId: "t3-run-unconfirmed" });
      const running = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "provider_turn.updated"),
        Stream.runHead,
      );
      const providerTurnId =
        running._tag === "Some" && running.value.type === "provider_turn.updated"
          ? running.value.providerTurn.id
          : undefined;

      const interrupt = yield* Effect.forkChild(
        runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! }),
      );
      yield* TestClock.adjust(expected.wait);
      yield* Fiber.join(interrupt);
      const terminal = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );

      assert.isTrue(terminal._tag === "Some" && terminal.value.type === "turn.terminal");
      if (terminal._tag === "Some" && terminal.value.type === "turn.terminal") {
        assert.equal(terminal.value.status, expected.status);
        if (terminal.value.status === "failed") {
          assert.include(
            terminal.value.failure?.message ?? "",
            "Cursor has not confirmed that cloud run cloud-run-1 stopped.",
          );
        }
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
