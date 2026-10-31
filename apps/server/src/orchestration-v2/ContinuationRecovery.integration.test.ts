import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  ContextHandoffId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2EngineBinding,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
} from "../provider/ClaudeModelCatalog.ts";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const settings = Schema.decodeSync(ClaudeSettings)({});
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
const contextWindow = resolveClaudeCatalogContextWindowTokens(
  BUNDLED_CLAUDE_MODEL_CATALOG,
  modelSelection,
)!;
const routes = ["uncertain_history_delivery", "resume_failed", "handoff_budget_exhausted"] as const;
const settledRunStatuses = new Set<OrchestrationV2Run["status"]>([
  "waiting",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function makeQueryRunner(inputTokens: () => number) {
  const state = { allocations: 0, resumes: [] as Array<string | undefined>, frames: 0 };
  const queryRunner: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape = {
    allocateSessionId: Effect.sync(() => `native-${++state.allocations}`),
    open: ({ options }) =>
      Effect.gen(function* () {
        const nativeId = options.resume ?? options.sessionId;
        state.resumes.push(options.resume);
        const messages = yield* Queue.unbounded<SDKMessage, Cause.Done>();
        return {
          messages: Stream.fromQueue(messages),
          offer: (_message, onQueued) =>
            Effect.suspend(() => {
              onQueued?.();
              const uuid = `frame-${++state.frames}`;
              return Queue.offerAll(messages, [
                frame({
                  type: "assistant",
                  uuid: `${uuid}-assistant`,
                  session_id: nativeId,
                  parent_tool_use_id: null,
                  message: {
                    id: `${uuid}-message`,
                    role: "assistant",
                    type: "message",
                    model: modelSelection.model,
                    content: [{ type: "text", text: "Done." }],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: { input_tokens: inputTokens(), output_tokens: 1 },
                  },
                }),
                frame({
                  type: "result",
                  subtype: "success",
                  uuid: `${uuid}-result`,
                  session_id: nativeId,
                  is_error: false,
                  num_turns: 1,
                  result: "Done.",
                  stop_reason: "end_turn",
                  terminal_reason: "completed",
                  permission_denials: [],
                  duration_ms: 1,
                  duration_api_ms: 1,
                  total_cost_usd: 0,
                  usage: { input_tokens: inputTokens(), output_tokens: 1 },
                  modelUsage: {},
                }),
              ]);
            }).pipe(Effect.asVoid),
          setModel: () => Effect.void,
          applyFlagSettings: () => Effect.void,
          setPermissionMode: () => Effect.void,
          backgroundTasks: () => Effect.succeed(false),
          stopTask: () => Effect.void,
          interrupt: Effect.void,
          close: Queue.end(messages),
        };
      }),
    forkSession: () => Effect.die("continuation recovery never forks"),
    subagentLaunchToolUseId: () => Effect.succeed(null),
    assertComplete: Effect.void,
  };
  return { state, queryRunner };
}

const binding: OrchestrationV2EngineBinding = {
  providerInstanceId: instanceId,
  engine: "claude-lhc",
  continuationKey: "claude:home:/homes/lhc",
  claudeHome: "/homes/lhc",
  compact: null,
  nativeContinuation: "required",
  compaction: "provider",
};

function boundAdapter(
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  faults: { failNextResume: boolean },
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    ...adapter,
    openSession: (input) =>
      adapter.openSession(input).pipe(
        Effect.map((session): ProviderAdapter.ProviderAdapterV2SessionRuntime => ({
          ...session,
          ensureThread: (request) =>
            session.ensureThread(request).pipe(
              Effect.map((row) => ({
                ...row,
                nativeMetadata: { ...row.nativeMetadata, engineBinding: binding },
              })),
            ),
          resumeThread: (request) => {
            if (!faults.failNextResume) return session.resumeThread(request);
            return Effect.fail(
              new ProviderAdapter.ProviderAdapterResumeThreadError({
                driver: session.driver,
                providerSessionId: input.providerSessionId,
                providerThreadId: request.providerThread.id,
                cause: new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: session.driver,
                  detail: `Claude session ${request.providerThread.nativeThreadRef?.nativeId} has no conversation to resume.`,
                }),
              }),
            );
          },
        })),
      ),
  };
}

const cases = routes.flatMap((route) => [
  { route, bound: false, name: `recovers ${route} on an unbound row in a fresh native session` },
  { route, bound: true, name: `refuses ${route} on a bound row and keeps its native ref` },
]);

it.effect.each(cases)("$name", ({ route, bound }) => {
  const warnings: Array<string> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(JSON.stringify(message));
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* checkpointWorkspace(`continuation-${route}-${bound}`);
      const configDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-continuation-claude-",
      });
      let inputTokens = 1;
      const runner = makeQueryRunner(() => inputTokens);
      const faults = { failNextResume: false };
      const stock = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId,
        settings,
        environment: { CLAUDE_CONFIG_DIR: configDir },
        attachmentsDir: cwd,
        fileSystem,
        path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: runner.queryRunner,
        ...(bound
          ? {
              engineBinding: {
                engine: binding.engine,
                continuationKey: binding.continuationKey,
                claudeHome: binding.claudeHome,
                compact: binding.compact,
                nativeContinuation: binding.nativeContinuation,
                compaction: binding.compaction,
              },
            }
          : {}),
      });
      const adapter = bound ? boundAdapter(stock, faults) : stock;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`thread:continuation-${route}`);
        const settled = (ordinal: number) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event: OrchestrationV2DomainEvent) =>
                event.type === "run.updated" &&
                event.payload.ordinal === ordinal &&
                settledRunStatuses.has(event.payload.status),
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const dispatch = (ordinal: number) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`send-${ordinal}`),
            threadId,
            messageId: MessageId.make(`message-${ordinal}`),
            text: `Turn ${ordinal}`,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        const drainThroughRetryBackoff = <E>(ordinal: number, settledRun: Fiber.Fiber<void, E>) =>
          Effect.gen(function* () {
            yield* worker.drain();
            for (let attempt = 0; attempt < 10; attempt++) {
              if ((yield* run(ordinal)).status !== "starting") break;
              yield* TestClock.adjust("1 second");
              yield* worker.drain();
            }
            yield* Fiber.join(settledRun);
            yield* worker.drain();
          });
        const run = (ordinal: number) =>
          orchestrator
            .getThreadProjection(threadId)
            .pipe(Effect.map((projection) => projection.runs.find((r) => r.ordinal === ordinal)!));
        const writeHandoff = (handoff: Partial<OrchestrationV2ContextHandoff>) =>
          Effect.gen(function* () {
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const row = projection.providerThreads[0]!;
            const now = yield* DateTime.now;
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`handoff-${route}`),
                  type: "context-handoff.updated",
                  threadId,
                  occurredAt: now,
                  payload: {
                    id: ContextHandoffId.make(`handoff-${route}`),
                    threadId,
                    targetRunId: projection.runs[0]!.id,
                    fromProviderThreadIds: [row.id],
                    toProviderThreadId: row.id,
                    coveredRunOrdinals: { from: 1, to: 1 },
                    strategy: "full_thread_summary",
                    status: "ready",
                    summaryMessageId: null,
                    summaryText: "",
                    history: { messages: [], coverage: "Earlier work.", omittedItems: 0 },
                    createdByProviderInstanceId: instanceId,
                    createdAt: now,
                    updatedAt: now,
                    ...handoff,
                  },
                },
              ],
            });
          });

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:continuation"),
          title: "Continuation recovery",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        if (route === "handoff_budget_exhausted") inputTokens = Math.ceil(contextWindow * 0.9);
        const first = yield* settled(1);
        yield* dispatch(1);
        yield* drainThroughRetryBackoff(1, first);
        assert.equal((yield* run(1)).status, "completed");
        const before = (yield* orchestrator.getThreadProjection(threadId)).providerThreads;
        assert.equal(before.length, 1);
        const row = before[0]!;
        assert.equal(row.nativeThreadRef?.nativeId, "native-1");
        assert.deepEqual(row.nativeMetadata?.engineBinding, bound ? binding : undefined);
        assert.equal(runner.state.allocations, 1);

        if (route === "resume_failed") {
          yield* sessions.release({
            providerSessionId: row.providerSessionId!,
            reason: "idle_timeout",
          });
          if (bound) {
            faults.failNextResume = true;
          } else {
            const projectDir = path.join(configDir, "projects", "continuation");
            yield* fileSystem.makeDirectory(projectDir, { recursive: true });
            yield* fileSystem.writeFileString(
              path.join(projectDir, "native-1.jsonl"),
              `${JSON.stringify({ type: "summary" })}\n`,
            );
          }
        }
        if (route === "uncertain_history_delivery") {
          yield* writeHandoff({
            delivery: { nativeThreadId: "native-1", status: "pending", itemIds: [] },
          });
        }
        const second = yield* settled(2);
        yield* dispatch(2);
        if (route === "handoff_budget_exhausted") {
          yield* writeHandoff({ targetRunId: (yield* run(2)).id });
        }
        yield* drainThroughRetryBackoff(2, second);

        const after = yield* orchestrator.getThreadProjection(threadId);
        const secondRun = after.runs.find((candidate) => candidate.ordinal === 2)!;
        const failure = after.turnItems.find(
          (item) => item.runId === secondRun.id && item.type === "error",
        );
        const logged = (line: string) =>
          warnings.some((warning) => warning.includes(line) && warning.includes(route));
        if (!bound) {
          assert.equal(secondRun.status, "completed");
          assert.isTrue(logged("Recovering provider context in a fresh native session"));
          assert.isFalse(logged("Refused to replace a native session"));
          assert.equal(runner.state.allocations, 2);
          assert.equal(after.providerThreads.length, 1);
          assert.equal(after.providerThreads[0]!.id, row.id);
          assert.equal(after.providerThreads[0]!.nativeThreadRef?.nativeId, "native-2");
          return;
        }
        assert.equal(secondRun.status, "failed");
        assert.include(failure?.type === "error" ? failure.failure.message : "", `(${route})`);
        assert.isTrue(logged("Refused to replace a native session that must continue"));
        assert.isFalse(logged("Recovering provider context in a fresh native session"));
        assert.equal(runner.state.allocations, 1);
        assert.equal(after.providerThreads.length, 1);
        assert.equal(after.providerThreads[0]!.id, row.id);
        assert.equal(after.providerThreads[0]!.nativeThreadRef?.nativeId, "native-1");
        assert.deepEqual(after.providerThreads[0]!.nativeMetadata?.engineBinding, binding);

        if (route !== "resume_failed") return;
        faults.failNextResume = false;
        const opens = runner.state.resumes.length;
        const third = yield* settled(3);
        yield* dispatch(3);
        yield* drainThroughRetryBackoff(3, third);
        assert.equal((yield* run(3)).status, "completed");
        assert.deepEqual(runner.state.resumes.slice(opens), ["native-1"]);
        assert.equal(runner.state.allocations, 1);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `continuation-${route}-${bound}` },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    ),
  );
});
