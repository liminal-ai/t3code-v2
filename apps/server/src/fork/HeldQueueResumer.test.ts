import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ServerSettings as ServerSettingsShape,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRuntimeRecoveryService from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  HeldQueueResumer,
  layer as resumerLayer,
  RECONCILE_COMMAND_PREFIX,
  resumeCommandId,
} from "./HeldQueueResumer.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" } satisfies ModelSelection;
const projectId = ProjectId.make("project:held-queue");
const projectOff = ProjectId.make("project:held-queue-off");

interface StartedTurn {
  readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
}

const makeAdapter = (cwd: string) => {
  const started: Array<StartedTurn> = [];
  const control = { failNextStart: false };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:codex:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              if (control.failNextStart) {
                control.failNextStart = false;
                return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver,
                  threadId: turn.threadId,
                  providerThreadId: turn.providerThread.id,
                  runId: turn.runId,
                });
              }
              started.push({ turn, events });
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              });
            }),
          steerTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  return { adapter, started, control };
};

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-held-queue-" });
const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerTest = (
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  settings: Partial<ServerSettingsShape> = {},
) => {
  const providerInstance = {
    instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
    displayName: "Codex test",
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter: adapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  } satisfies ProviderInstance;
  const layerProviderInstances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (id) => Effect.succeed(id === instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
  const layerCore = Layer.mergeAll(
    RuntimeLayer.layer,
    RuntimeLayer.layerEventSink,
    ProjectionStore.layer,
    EffectOutbox.layer,
    ThreadCommandExecutor.layer,
  );
  return Layer.mergeAll(layerCore, resumerLayer.pipe(Layer.provide(layerCore))).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(
      ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true, ...settings }),
    ),
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provide(layerCheckpointStoreTest),
    Layer.provide(layerServerConfig),
    Layer.provide(layerProviderInstances),
    Layer.provide(
      Layer.mock(GitWorkflow.GitWorkflowService)({
        pruneWorktrees: () => Effect.void,
        createWorktree: () => Effect.succeed({} as never),
      }),
    ),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
    Layer.provide(layerPlatformTest),
  );
};

const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.streamDomainEvents.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    ),
  );

const runStatus = (runId: RunId, status: OrchestrationV2Run["status"]) =>
  watch(
    (event) =>
      event.type === "run.updated" && event.payload.id === runId && event.payload.status === status,
  );

const nextTurnRunning = (active: OrchestrationV2Run) =>
  watch(
    (event) =>
      event.type === "provider-turn.updated" &&
      event.payload.status === "running" &&
      event.payload.runAttemptId !== active.activeAttemptId,
  );

const runsOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId).pipe(Effect.map((projection) => projection.runs)),
  );

const dispatch = (command: Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0]) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) => orchestrator.dispatch(command));

const drain = Effect.flatMap(EffectWorker.OrchestrationEffectWorkerV2, (worker) => worker.drain());

const scan = Effect.flatMap(HeldQueueResumer, (resumer) => resumer.scan);

const busyThread = (input: {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly projectId?: ProjectId;
  readonly queued?: number;
}) =>
  Effect.gen(function* () {
    const { threadId, cwd } = input;
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: input.projectId ?? projectId,
      title: "Held queue",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* watch(
      (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
    );
    for (const index of Array.from({ length: 1 + (input.queued ?? 1) }, (_, i) => i)) {
      yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${threadId}:message:${index}`),
        threadId,
        messageId: MessageId.make(`${threadId}:message:${index}`),
        text: index === 0 ? "Keep working" : `Queued ${index}`,
        attachments: [],
        modelSelection,
        dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
    }
    yield* drain;
    yield* Fiber.join(running);
    const runs = yield* runsOf(threadId);
    const active = runs.find((run) => run.status === "running")!;
    const queued = runs.filter((run) => run.status === "queued");
    assert.equal(queued.length, input.queued ?? 1);
    return { active, queued };
  });

/** The server's shutdown steps and its startup pass, a second later, so each pass keys its own reconcile. */
const restartOneSecondLater = Effect.gen(function* () {
  const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  yield* TestClock.adjust("1 second");
  yield* recovery.prepareForShutdown.pipe(Effect.ensuring(sessions.shutdown));
  yield* recovery.reconcile("shutdown");
  yield* recovery.reconcile("startup");
});

const finishTurn = (started: StartedTurn, status: "completed" | "interrupted" = "completed") =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const { turn, events } = started;
    const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
    yield* Queue.offer(events, {
      type: "provider_turn.updated",
      driver,
      providerTurn: {
        id: providerTurnId,
        providerThreadId: turn.providerThread.id,
        nodeId: turn.rootNodeId,
        runAttemptId: turn.attemptId,
        nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
        ordinal: turn.providerTurnOrdinal,
        status,
        startedAt: now,
        completedAt: now,
      },
    });
    yield* Queue.offer(events, {
      type: "turn.terminal",
      driver,
      providerThreadId: turn.providerThread.id,
      providerTurnId,
      runOrdinal: turn.runOrdinal,
      status,
      failure: null,
      threadDisposition: "reusable",
    });
  });

const holdCommandId = (threadId: ThreadId, runId: RunId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly command_id: string | null }>`
      SELECT command_id FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
        AND event_type = 'run.updated'
        AND json_extract(payload_json, '$.id') = ${runId}
        AND json_extract(payload_json, '$.queueHeld') IS 1
      ORDER BY sequence ASC LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]?.command_id ?? null)),
  );

const resumeCommandIds = (threadId: ThreadId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly command_id: string }>`
      SELECT DISTINCT command_id FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
        AND command_id LIKE 'command:fork-held-queue-resume:%'
      ORDER BY command_id
    `.pipe(Effect.map((rows) => rows.map((row) => row.command_id))),
  );

const continuationOf = (runs: ReadonlyArray<OrchestrationV2Run>, sourceId: RunId) =>
  runs.find((run) => run.restartContinuationOfRunId === sourceId);

const recordPendingRequest = (
  threadId: ThreadId,
  run: OrchestrationV2Run,
  request: { readonly kind: "user_input" | "command"; readonly answeredBy: "live" | "message" },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const turn = projection.providerTurns.find(
      (candidate) => candidate.runAttemptId === run.activeAttemptId,
    );
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:${threadId}:${request.kind}:${run.ordinal}`),
          type: "runtime-request.updated",
          threadId,
          nodeId: run.rootNodeId!,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(`request:${threadId}:${request.kind}:${run.ordinal}`),
            nodeId: run.rootNodeId!,
            providerTurnId: request.answeredBy === "live" ? turn!.id : null,
            nativeRequestRef: null,
            kind: request.kind,
            status: "pending",
            responseCapability:
              request.answeredBy === "live"
                ? { type: "live", providerSessionId: projection.providerSessions[0]!.id }
                : { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        },
      ],
    });
  });

const askSecret = (threadId: ThreadId, run: OrchestrationV2Run) =>
  dispatch({
    type: "secret_request.record",
    commandId: CommandId.make(`${threadId}:secret:${run.ordinal}`),
    threadId,
    runId: run.id,
    nodeId: run.rootNodeId!,
    turnItemId: TurnItemId.make(`${threadId}:secret:${run.ordinal}`),
    label: "Test token",
    reason: "Held queue test",
    secretStatus: "pending",
  });

type Harness = Layer.Success<ReturnType<typeof layerTest>>;

const withHarness = <A, E>(
  name: string,
  body: (harness: {
    readonly cwd: string;
    readonly started: Array<StartedTurn>;
    readonly control: { failNextStart: boolean };
  }) => Effect.Effect<A, E, Harness | Scope.Scope>,
  settings: Partial<ServerSettingsShape> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`held-queue-${name}`);
      const { adapter, started, control } = makeAdapter(cwd);
      return yield* body({ cwd, started, control }).pipe(
        Effect.provide(layerTest(adapter, settings).pipe(Layer.orDie)),
      );
    }),
  );

it.effect("resumes a restart-held queue only when the setting is on", () =>
  withHarness(
    "setting",
    ({ cwd }) =>
      Effect.gen(function* () {
        const on = ThreadId.make("thread:setting-on");
        const off = ThreadId.make("thread:setting-off");
        const onThread = yield* busyThread({ threadId: on, cwd });
        const offThread = yield* busyThread({ threadId: off, cwd, projectId: projectOff });
        yield* restartOneSecondLater;
        for (const [threadId, queued] of [
          [on, onThread.queued],
          [off, offThread.queued],
        ] as const) {
          const held = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
          assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
        }
        const scanning = yield* scan.pipe(Effect.forkScoped);
        yield* drain;
        yield* Fiber.join(scanning);
        const onRuns = yield* runsOf(on);
        const continuation = continuationOf(onRuns, onThread.active.id);
        assert.isDefined(continuation, "the cut turn continued");
        assert.equal(continuation?.status, "running");
        const resumed = onRuns.find((run) => run.id === onThread.queued[0]!.id);
        assert.deepEqual([resumed?.status, resumed?.queueHeld], ["queued", false]);
        const offRuns = yield* runsOf(off);
        assert.isUndefined(continuationOf(offRuns, offThread.active.id));
        const stillHeld = offRuns.find((run) => run.id === offThread.queued[0]!.id);
        assert.deepEqual([stillHeld?.status, stillHeld?.queueHeld], ["queued", true]);
      }),
    { projectSettingsOverrides: { [projectOff]: { continueThreadsAfterServerUpdate: false } } },
  ),
);

it.effect("keeps the queued message behind the continuation while its effect is pending", () =>
  withHarness("ordering", ({ cwd, started }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ordering");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* Fiber.join(scanning);
      const afterResume = yield* runsOf(threadId);
      const continuation = continuationOf(afterResume, active.id)!;
      assert.equal(continuation.status, "running");
      const waiting = afterResume.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([waiting?.status, waiting?.queueHeld], ["queued", false]);
      const continued = started.find(
        (entry) => entry.turn.attemptId === continuation.activeAttemptId,
      )!;
      const settled = yield* runStatus(continuation.id, "waiting");
      const queuedStarting = yield* runStatus(queued[0]!.id, "starting");
      const queuedRunning = yield* runStatus(queued[0]!.id, "running");
      yield* finishTurn(continued);
      yield* Fiber.join(settled);
      yield* drain;
      yield* Fiber.join(queuedStarting);
      yield* drain;
      yield* Fiber.join(queuedRunning);
      const afterContinuation = yield* runsOf(threadId);
      assert.equal(
        afterContinuation.find((run) => run.id === continuation.id)?.status,
        "completed",
      );
      assert.equal(afterContinuation.find((run) => run.id === queued[0]!.id)?.status, "running");
    }),
  ),
);

it.effect(
  "takes the source from the continuation effect when a cancelled run that never started is newer",
  () =>
    withHarness("newer-cancelled", ({ cwd }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:newer-cancelled");
        const { active, queued } = yield* busyThread({ threadId, cwd, queued: 2 });
        const [first, second] = queued;
        yield* dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`${threadId}:cancel`),
          threadId,
          runId: second!.id,
        });
        assert.isTrue(
          (yield* runsOf(threadId)).some(
            (run) => run.id === second!.id && run.status === "cancelled" && run.startedAt === null,
          ),
        );
        yield* restartOneSecondLater;
        const scanning = yield* scan.pipe(Effect.forkScoped);
        yield* drain;
        yield* Fiber.join(scanning);
        const runs = yield* runsOf(threadId);
        assert.equal(continuationOf(runs, active.id)?.status, "running");
        const resumed = runs.find((run) => run.id === first!.id);
        assert.deepEqual([resumed?.status, resumed?.queueHeld], ["queued", false]);
      }),
    ),
);

it.effect("awaits the continuation of a second restart that cut the first continuation", () =>
  withHarness("restart-during-continuation", ({ cwd }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:restart-during-continuation");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      // The first server's scan never got to resume: it was still waiting when the next restart came.
      const continuationTurn = yield* nextTurnRunning(active);
      yield* drain;
      yield* Fiber.join(continuationTurn);
      const first = continuationOf(yield* runsOf(threadId), active.id)!;
      assert.equal(first.status, "running");
      yield* restartOneSecondLater;
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* Fiber.join(scanning);
      const runs = yield* runsOf(threadId);
      assert.equal(runs.find((run) => run.id === first.id)?.status, "cancelled");
      assert.equal(continuationOf(runs, first.id)?.status, "running");
      const resumed = runs.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([resumed?.status, resumed?.queueHeld], ["queued", false]);
    }),
  ),
);

it.effect("awaits a wake continuation whose source the restart did not cancel", () =>
  withHarness("wake", ({ cwd, started }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:wake");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const projection = yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
        orchestrator.getThreadProjection(threadId),
      );
      const turn = projection.providerTurns[0]!;
      // A native subagent the turn awaits, still running when the turn itself settles.
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:${threadId}:subagent`),
            type: "turn-item.updated",
            threadId,
            runId: active.id,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`turn-item:${threadId}:subagent`),
              threadId,
              runId: active.id,
              nodeId: active.rootNodeId,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              nativeItemRef: { driver, nativeId: "agent-1", strength: "strong" },
              parentItemId: null,
              ordinal: 100,
              status: "running",
              title: "Sleeper",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "subagent",
              subagentId: NodeId.make(`node:${threadId}:subagent`),
              origin: "provider_native",
              driver,
              providerInstanceId: instanceId,
              childThreadId: null,
              prompt: "Sleep",
              result: null,
            },
          },
        ],
      });
      const settled = yield* runStatus(active.id, "waiting");
      yield* finishTurn(started.find((entry) => entry.turn.runId === active.id)!);
      yield* Fiber.join(settled);
      yield* restartOneSecondLater;
      const held = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
      assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* Fiber.join(scanning);
      const runs = yield* runsOf(threadId);
      assert.equal(runs.find((run) => run.id === active.id)?.status, "completed");
      assert.equal(continuationOf(runs, active.id)?.status, "running");
      const resumed = runs.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([resumed?.status, resumed?.queueHeld], ["queued", false]);
    }),
  ),
);

it.effect("awaits a continuation still pending from an earlier restart", () =>
  withHarness("pending-from-earlier", ({ cwd }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:pending-from-earlier");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      // The next restart came before the worker ran the first one's continuation.
      yield* restartOneSecondLater;
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* Fiber.join(scanning);
      const runs = yield* runsOf(threadId);
      assert.equal(continuationOf(runs, active.id)?.status, "running");
      const resumed = runs.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([resumed?.status, resumed?.queueHeld], ["queued", false]);
    }),
  ),
);

it.effect.each(["approval", "secret"] as const)(
  "leaves the hold when the latest restart cut a turn waiting on a %s, after an older continuation completed",
  (blocker) =>
    withHarness(`older-continuation-${blocker}`, ({ cwd, started }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`thread:older-continuation-${blocker}`);
        const { active, queued } = yield* busyThread({ threadId, cwd });
        yield* restartOneSecondLater;
        const continuationTurn = yield* nextTurnRunning(active);
        yield* drain;
        yield* Fiber.join(continuationTurn);
        const continuation = continuationOf(yield* runsOf(threadId), active.id)!;
        const settled = yield* runStatus(continuation.id, "waiting");
        const done = yield* runStatus(continuation.id, "completed");
        yield* finishTurn(started.find((entry) => entry.turn.runId === continuation.id)!);
        yield* Fiber.join(settled);
        yield* drain;
        yield* Fiber.join(done);
        const laterTurn = yield* nextTurnRunning(continuation);
        yield* dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:later`),
          threadId,
          messageId: MessageId.make(`${threadId}:later`),
          text: "One more thing",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* drain;
        yield* Fiber.join(laterTurn);
        const later = (yield* runsOf(threadId)).find((run) => run.status === "running")!;
        yield* blocker === "approval"
          ? recordPendingRequest(threadId, later, { kind: "command", answeredBy: "live" })
          : askSecret(threadId, later);
        yield* restartOneSecondLater;
        const scanning = yield* scan.pipe(Effect.forkScoped);
        yield* drain;
        yield* Fiber.join(scanning);
        const runs = yield* runsOf(threadId);
        assert.equal(runs.find((run) => run.id === later.id)?.status, "cancelled");
        assert.isUndefined(continuationOf(runs, later.id));
        const held = runs.find((run) => run.id === queued[0]!.id);
        assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
        assert.deepEqual(yield* resumeCommandIds(threadId), []);
      }),
    ),
);

it.effect("leaves the queue held after a Stop on a later turn", () =>
  withHarness("later-stop", ({ cwd, started }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:later-stop");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      const continuationTurn = yield* nextTurnRunning(active);
      yield* drain;
      yield* Fiber.join(continuationTurn);
      const continuation = continuationOf(yield* runsOf(threadId), active.id)!;
      const settled = yield* runStatus(continuation.id, "waiting");
      const done = yield* runStatus(continuation.id, "completed");
      yield* finishTurn(started.find((entry) => entry.turn.runId === continuation.id)!);
      yield* Fiber.join(settled);
      yield* drain;
      yield* Fiber.join(done);
      const laterTurn = yield* nextTurnRunning(continuation);
      yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${threadId}:later`),
        threadId,
        messageId: MessageId.make(`${threadId}:later`),
        text: "One more thing",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* drain;
      yield* Fiber.join(laterTurn);
      const later = (yield* runsOf(threadId)).find((run) => run.status === "running")!;
      yield* dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${threadId}:stop-later`),
        threadId,
        runId: later.id,
        holdQueue: true,
      });
      yield* scan;
      const held = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
      assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
      assert.deepEqual(yield* resumeCommandIds(threadId), []);
    }),
  ),
);

it.effect("leaves a Stop-held queue held across a restart", () =>
  withHarness("stop", ({ cwd }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:stop");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${threadId}:stop`),
        threadId,
        runId: active.id,
        holdQueue: true,
      });
      const stopped = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
      assert.equal(stopped?.queueHeld, true);
      yield* restartOneSecondLater;
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* Fiber.join(scanning);
      const runs = yield* runsOf(threadId);
      assert.isUndefined(continuationOf(runs, active.id));
      const held = runs.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
    }),
  ),
);

it.effect("keeps the restart class after the held queue is reordered", () =>
  withHarness("reorder", ({ cwd }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:reorder");
      const { active, queued } = yield* busyThread({ threadId, cwd, queued: 2 });
      const [first, second] = queued;
      yield* restartOneSecondLater;
      yield* dispatch({
        type: "queued-run.reorder",
        commandId: CommandId.make(`${threadId}:reorder`),
        threadId,
        runId: second!.id,
        beforeRunId: first!.id,
      });
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* Fiber.join(scanning);
      const runs = yield* runsOf(threadId);
      assert.equal(continuationOf(runs, active.id)?.status, "running");
      assert.deepEqual(
        runs
          .filter((run) => run.status === "queued")
          .sort((left, right) => left.queuePosition! - right.queuePosition!)
          .map((run) => [run.id, run.queueHeld]),
        [
          [second!.id, false],
          [first!.id, false],
        ],
      );
      const reconcileCommandId = yield* holdCommandId(threadId, first!.id);
      assert.deepEqual(yield* resumeCommandIds(threadId), [
        resumeCommandId({
          threadId,
          headRunId: second!.id,
          reconcileCommandId: CommandId.make(reconcileCommandId!),
        }),
      ]);
    }),
  ),
);

it.effect("leaves a queue held by a provider failure", () =>
  withHarness("failure", ({ cwd }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:failure");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      yield* sink.writeWithEffects({
        events: [
          {
            id: EventId.make(`event:${threadId}:failure-hold`),
            type: "run.updated",
            threadId,
            runId: queued[0]!.id,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: { ...queued[0]!, queueHeld: true },
          },
        ],
        effects: [],
      });
      yield* restartOneSecondLater;
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* Fiber.join(scanning);
      const runs = yield* runsOf(threadId);
      assert.equal(continuationOf(runs, active.id)?.status, "running");
      const held = runs.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
    }),
  ),
);

it.effect("leaves a queue held behind a missing worktree", () =>
  withHarness("worktree", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:worktree");
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId,
        title: "Held queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${threadId}:message:0`),
        threadId,
        messageId: MessageId.make(`${threadId}:message:0`),
        text: "Work in a new worktree",
        attachments: [],
        modelSelection,
        dispatchMode: {
          type: "defer_start",
          workspaceStrategy: { type: "worktree", baseRef: "main" },
        },
        createdBy: "user",
        creationSource: "web",
      });
      const preparing = (yield* runsOf(threadId)).find((run) => run.status === "preparing")!;
      yield* dispatch({
        type: "prepared-run.fail",
        commandId: CommandId.make(`${threadId}:prepare-failed`),
        threadId,
        runId: preparing.id,
        failure: {
          class: "provider_error",
          message: "git worktree add failed",
          code: null,
          retryable: null,
        },
      });
      yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${threadId}:message:1`),
        threadId,
        messageId: MessageId.make(`${threadId}:message:1`),
        text: "Queued behind the missing worktree",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const bornHeld = (yield* runsOf(threadId)).find((run) => run.status === "queued");
      assert.equal(bornHeld?.queueHeld, true);
      yield* restartOneSecondLater;
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* Fiber.join(scanning);
      const held = (yield* runsOf(threadId)).find((run) => run.id === bornHeld!.id);
      assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
      assert.deepEqual(yield* resumeCommandIds(threadId), []);
    }),
  ),
);

it.effect("leaves the hold when the continuation fails before the scan reads it", () =>
  withHarness("failed-continuation", ({ cwd, control }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:failed-continuation");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      control.failNextStart = true;
      yield* drain;
      const continuation = continuationOf(yield* runsOf(threadId), active.id);
      assert.equal(continuation?.status, "failed");
      yield* scan;
      const held = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
      assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
      assert.deepEqual(yield* resumeCommandIds(threadId), []);
    }),
  ),
);

it.effect("leaves the hold when core declines the continuation", () =>
  withHarness("declined", ({ cwd }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:declined");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${threadId}:interrupt`),
        threadId,
        runId: active.id,
      });
      assert.notEqual(
        (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id)?.queueHeld,
        true,
      );
      yield* restartOneSecondLater;
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* Fiber.join(scanning);
      const runs = yield* runsOf(threadId);
      assert.isUndefined(continuationOf(runs, active.id));
      const held = runs.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
    }),
  ),
);

it.effect("leaves the hold when a pending secret made core decline before it wrote an effect", () =>
  withHarness("secret-declined", ({ cwd }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:secret-declined");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* askSecret(threadId, active);
      yield* restartOneSecondLater;
      yield* drain;
      assert.isUndefined(continuationOf(yield* runsOf(threadId), active.id));
      yield* scan;
      yield* drain;
      const held = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
      assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
      assert.deepEqual(yield* resumeCommandIds(threadId), []);
    }),
  ),
);

it.effect(
  "leaves the hold when core declined an unanswered live question before it wrote an effect",
  () =>
    withHarness("question-declined", ({ cwd }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:question-declined");
        const { active, queued } = yield* busyThread({ threadId, cwd });
        yield* recordPendingRequest(threadId, active, { kind: "user_input", answeredBy: "live" });
        yield* restartOneSecondLater;
        yield* drain;
        assert.isUndefined(continuationOf(yield* runsOf(threadId), active.id));
        yield* scan;
        yield* drain;
        const held = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
        assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
        assert.deepEqual(yield* resumeCommandIds(threadId), []);
      }),
    ),
);

it.effect(
  "leaves the hold when an older continuation completed and the thread now waits on an answer",
  () =>
    withHarness("answer-pending", ({ cwd, started }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:answer-pending");
        const { active, queued } = yield* busyThread({ threadId, cwd });
        yield* restartOneSecondLater;
        const continuationTurn = yield* nextTurnRunning(active);
        yield* drain;
        yield* Fiber.join(continuationTurn);
        const continuation = continuationOf(yield* runsOf(threadId), active.id)!;
        const settled = yield* runStatus(continuation.id, "waiting");
        const done = yield* runStatus(continuation.id, "completed");
        yield* finishTurn(started.find((entry) => entry.turn.runId === continuation.id)!);
        yield* Fiber.join(settled);
        yield* drain;
        yield* Fiber.join(done);
        yield* recordPendingRequest(threadId, continuation, {
          kind: "user_input",
          answeredBy: "message",
        });
        yield* restartOneSecondLater;
        yield* drain;
        const shell = yield* Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
          projections.getThreadShell(threadId),
        );
        assert.isNotNull(shell?.pendingRuntimeRequest);
        yield* scan;
        const held = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
        assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
        assert.deepEqual(yield* resumeCommandIds(threadId), []);
      }),
    ),
);

it.effect("leaves the hold when a Stop lands while the continuation is still being admitted", () =>
  withHarness("stop-while-admitting", ({ cwd }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:stop-while-admitting");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`${threadId}:stop`),
        threadId,
      });
      yield* drain;
      yield* Fiber.join(scanning);
      const runs = yield* runsOf(threadId);
      assert.isUndefined(continuationOf(runs, active.id));
      const held = runs.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
      assert.deepEqual(yield* resumeCommandIds(threadId), []);
    }),
  ),
);

it.effect("resumes again after a second restart under a new id", () =>
  withHarness("twice", ({ cwd }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:twice");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      const continuationTurn = yield* nextTurnRunning(active);
      const first = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* Fiber.join(first);
      yield* Fiber.join(continuationTurn);
      const continuation = continuationOf(yield* runsOf(threadId), active.id)!;
      assert.equal(continuation.status, "running");
      yield* restartOneSecondLater;
      const reheld = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
      assert.deepEqual([reheld?.status, reheld?.queueHeld], ["queued", true]);
      const second = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* Fiber.join(second);
      const runs = yield* runsOf(threadId);
      assert.equal(continuationOf(runs, continuation.id)?.status, "running");
      const resumed = runs.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([resumed?.status, resumed?.queueHeld], ["queued", false]);
      assert.lengthOf(yield* resumeCommandIds(threadId), 2);
    }),
  ),
);

it.effect("uses one command id across a rebuilt layer", () =>
  withHarness("rebuilt", ({ cwd }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:rebuilt");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      const reconcileCommandId = yield* holdCommandId(threadId, queued[0]!.id);
      const first = yield* scan.pipe(Effect.forkScoped);
      const second = yield* scan.pipe(Effect.provide(Layer.fresh(resumerLayer)), Effect.forkScoped);
      yield* drain;
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      const runs = yield* runsOf(threadId);
      assert.equal(continuationOf(runs, active.id)?.status, "running");
      const resumed = runs.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([resumed?.status, resumed?.queueHeld], ["queued", false]);
      const expected = resumeCommandId({
        threadId,
        headRunId: queued[0]!.id,
        reconcileCommandId: CommandId.make(reconcileCommandId!),
      });
      assert.deepEqual(yield* resumeCommandIds(threadId), [expected]);
      const sink = yield* EventSink.EventSinkV2;
      const releases = yield* sink.readByCommandId({ commandId: expected }).pipe(
        Stream.runCollect,
        Effect.map((chunk) => [...chunk]),
      );
      assert.lengthOf(
        releases.filter(
          (stored) =>
            stored.event.type === "run.updated" && stored.event.payload.id === queued[0]!.id,
        ),
        1,
      );
    }),
  ),
);

it.effect("the reconcile command id still starts with command:runtime-reconcile:", () =>
  withHarness("prefix", ({ cwd }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:prefix");
      const { queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      const commandId = yield* holdCommandId(threadId, queued[0]!.id);
      assert.isNotNull(commandId);
      assert.isTrue(commandId!.startsWith(RECONCILE_COMMAND_PREFIX), commandId!);
    }),
  ),
);
