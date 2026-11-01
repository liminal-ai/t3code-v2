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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  const control = { failStarts: 0 };
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
              if (control.failStarts > 0) {
                control.failStarts -= 1;
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

/** A crash: no shutdown steps, so the startup pass cuts the turn and writes the continuation itself. */
const crashAndRestartOneSecondLater = Effect.gen(function* () {
  const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
  yield* TestClock.adjust("1 second");
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

const finishContinuation = (threadId: ThreadId, sourceId: RunId, started: Array<StartedTurn>) =>
  Effect.gen(function* () {
    const continuation = continuationOf(yield* runsOf(threadId), sourceId)!;
    const settled = yield* runStatus(continuation.id, "waiting");
    const completed = yield* runStatus(continuation.id, "completed");
    yield* finishTurn(started.find((entry) => entry.turn.runId === continuation.id)!);
    yield* Fiber.join(settled);
    yield* drain;
    yield* Fiber.join(completed);
  });

/** The run's turn ends while a native subagent it awaits still runs, so the run settles as waiting. */
const settleBehindAwaitedWork = (
  threadId: ThreadId,
  run: OrchestrationV2Run,
  started: Array<StartedTurn>,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const projection = yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.getThreadProjection(threadId),
    );
    const turn = projection.providerTurns.find(
      (candidate) => candidate.runAttemptId === run.activeAttemptId,
    )!;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:${threadId}:subagent:${run.ordinal}`),
          type: "turn-item.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:${threadId}:subagent:${run.ordinal}`),
            threadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            nativeItemRef: { driver, nativeId: `agent-${run.ordinal}`, strength: "strong" },
            parentItemId: null,
            ordinal: 100,
            status: "running",
            title: "Sleeper",
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "subagent",
            subagentId: NodeId.make(`node:${threadId}:subagent:${run.ordinal}`),
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
    const settled = yield* runStatus(run.id, "waiting");
    yield* finishTurn(started.find((entry) => entry.turn.runId === run.id)!);
    yield* Fiber.join(settled);
  });

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
    readonly control: { failStarts: number };
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
    ({ cwd, started }) =>
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
        yield* finishContinuation(on, onThread.active.id, started);
        yield* Fiber.join(scanning);
        yield* drain;
        const onRuns = yield* runsOf(on);
        assert.equal(continuationOf(onRuns, onThread.active.id)?.status, "completed");
        const resumed = onRuns.find((run) => run.id === onThread.queued[0]!.id);
        assert.deepEqual([resumed?.status, resumed?.queueHeld], ["running", false]);
        const offRuns = yield* runsOf(off);
        assert.isUndefined(continuationOf(offRuns, offThread.active.id));
        const stillHeld = offRuns.find((run) => run.id === offThread.queued[0]!.id);
        assert.deepEqual([stillHeld?.status, stillHeld?.queueHeld], ["queued", true]);
      }),
    { projectSettingsOverrides: { [projectOff]: { continueThreadsAfterServerUpdate: false } } },
  ),
);

it.effect("keeps the queued message held until the continuation ends", () =>
  withHarness("ordering", ({ cwd, started }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ordering");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      const running = yield* runsOf(threadId);
      assert.equal(continuationOf(running, active.id)?.status, "running");
      const waiting = running.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([waiting?.status, waiting?.queueHeld], ["queued", true]);
      assert.deepEqual(yield* resumeCommandIds(threadId), []);
      yield* finishContinuation(threadId, active.id, started);
      yield* Fiber.join(scanning);
      yield* drain;
      const after = yield* runsOf(threadId);
      assert.equal(continuationOf(after, active.id)?.status, "completed");
      assert.equal(after.find((run) => run.id === queued[0]!.id)?.status, "running");
    }),
  ),
);

it.effect("resumes past a cancelled run that never started and is newer than the cut turn", () =>
  withHarness("newer-cancelled", ({ cwd, started }) =>
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
      yield* finishContinuation(threadId, active.id, started);
      yield* Fiber.join(scanning);
      yield* drain;
      const runs = yield* runsOf(threadId);
      assert.equal(continuationOf(runs, active.id)?.status, "completed");
      const resumed = runs.find((run) => run.id === first!.id);
      assert.deepEqual([resumed?.status, resumed?.queueHeld], ["running", false]);
    }),
  ),
);

it.effect("resumes behind the continuation after a crash, where the startup pass writes it", () =>
  withHarness("crash", ({ cwd, started }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:crash");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* crashAndRestartOneSecondLater;
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* finishContinuation(threadId, active.id, started);
      yield* Fiber.join(scanning);
      yield* drain;
      const runs = yield* runsOf(threadId);
      assert.equal(continuationOf(runs, active.id)?.status, "completed");
      const resumed = runs.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([resumed?.status, resumed?.queueHeld], ["running", false]);
    }),
  ),
);

it.effect(
  "resumes behind the continuation of a second restart that cut the first continuation",
  () =>
    withHarness("restart-during-continuation", ({ cwd, started }) =>
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
        yield* finishContinuation(threadId, first.id, started);
        yield* Fiber.join(scanning);
        yield* drain;
        const runs = yield* runsOf(threadId);
        assert.equal(runs.find((run) => run.id === first.id)?.status, "cancelled");
        assert.equal(continuationOf(runs, first.id)?.status, "completed");
        const resumed = runs.find((run) => run.id === queued[0]!.id);
        assert.deepEqual([resumed?.status, resumed?.queueHeld], ["running", false]);
      }),
    ),
);

it.effect.each(["while its effect is pending", "after its effect settled"] as const)(
  "resumes behind a wake continuation whose source the restart did not cancel, %s",
  (timing) =>
    withHarness(
      `wake-${timing === "while its effect is pending" ? "pending" : "settled"}`,
      ({ cwd, started }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(
            `thread:wake-${timing === "while its effect is pending" ? "pending" : "settled"}`,
          );
          const { active, queued } = yield* busyThread({ threadId, cwd });
          yield* settleBehindAwaitedWork(threadId, active, started);
          yield* restartOneSecondLater;
          const held = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
          assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
          const scanning =
            timing === "while its effect is pending"
              ? yield* scan.pipe(Effect.forkScoped)
              : yield* drain.pipe(Effect.andThen(scan.pipe(Effect.forkScoped)));
          yield* drain;
          yield* finishContinuation(threadId, active.id, started);
          yield* Fiber.join(scanning);
          yield* drain;
          const runs = yield* runsOf(threadId);
          assert.equal(runs.find((run) => run.id === active.id)?.status, "completed");
          assert.equal(continuationOf(runs, active.id)?.status, "completed");
          const resumed = runs.find((run) => run.id === queued[0]!.id);
          assert.deepEqual([resumed?.status, resumed?.queueHeld], ["running", false]);
        }),
    ),
);

it.effect("leaves the hold when core declines a wake past its chain cap", () =>
  withHarness("chain-cap", ({ cwd, started }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:chain-cap");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      let source = active;
      for (const _ of [1, 2, 3]) {
        yield* restartOneSecondLater;
        const continuationTurn = yield* nextTurnRunning(source);
        yield* drain;
        yield* Fiber.join(continuationTurn);
        source = continuationOf(yield* runsOf(threadId), source.id)!;
      }
      yield* settleBehindAwaitedWork(threadId, source, started);
      yield* restartOneSecondLater;
      yield* drain;
      const runs = yield* runsOf(threadId);
      assert.include(["waiting", "completed"], runs.find((run) => run.id === source.id)?.status);
      assert.isUndefined(continuationOf(runs, source.id));
      yield* scan;
      const held = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
      assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
      assert.deepEqual(yield* resumeCommandIds(threadId), []);
    }),
  ),
);

it.effect("resumes behind a continuation still pending from an earlier restart", () =>
  withHarness("pending-from-earlier", ({ cwd, started }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:pending-from-earlier");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      // The next restart came before the worker ran the first one's continuation.
      yield* restartOneSecondLater;
      const scanning = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* finishContinuation(threadId, active.id, started);
      yield* Fiber.join(scanning);
      yield* drain;
      const runs = yield* runsOf(threadId);
      assert.equal(continuationOf(runs, active.id)?.status, "completed");
      const resumed = runs.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([resumed?.status, resumed?.queueHeld], ["running", false]);
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
      const interrupted = yield* runStatus(later.id, "interrupted");
      yield* finishTurn(
        started.find((entry) => entry.turn.runId === later.id)!,
        "interrupted",
      );
      yield* Fiber.join(interrupted);
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
  withHarness("reorder", ({ cwd, started }) =>
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
      yield* finishContinuation(threadId, active.id, started);
      yield* Fiber.join(scanning);
      yield* drain;
      const runs = yield* runsOf(threadId);
      const byId = (id: RunId) => runs.find((run) => run.id === id);
      assert.deepEqual([byId(second!.id)?.status, byId(second!.id)?.queueHeld], ["running", false]);
      assert.deepEqual([byId(first!.id)?.status, byId(first!.id)?.queueHeld], ["queued", false]);
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

it.effect("leaves the hold when the continuation and its start retries fail", () =>
  withHarness("failed-continuation", ({ cwd, control }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:failed-continuation");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      const startRetryDelays = ["1 minute", "3 minutes"] as const;
      control.failStarts = 1 + startRetryDelays.length;
      yield* drain;
      const continuation = continuationOf(yield* runsOf(threadId), active.id);
      assert.equal(continuation?.status, "failed");
      const scanning = yield* scan.pipe(Effect.forkScoped);
      for (const delay of startRetryDelays) {
        yield* TestClock.adjust(delay);
        yield* drain;
      }
      yield* Fiber.join(scanning);
      assert.equal(control.failStarts, 0);
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
  withHarness("twice", ({ cwd, started }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:twice");
      const { active, queued } = yield* busyThread({ threadId, cwd, queued: 2 });
      const [first, second] = queued;
      yield* restartOneSecondLater;
      const firstScan = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* finishContinuation(threadId, active.id, started);
      yield* Fiber.join(firstScan);
      yield* drain;
      assert.equal(
        (yield* runsOf(threadId)).find((run) => run.id === first!.id)?.status,
        "running",
      );
      yield* restartOneSecondLater;
      const reheld = (yield* runsOf(threadId)).find((run) => run.id === second!.id);
      assert.deepEqual([reheld?.status, reheld?.queueHeld], ["queued", true]);
      const secondScan = yield* scan.pipe(Effect.forkScoped);
      yield* drain;
      yield* finishContinuation(threadId, first!.id, started);
      yield* Fiber.join(secondScan);
      yield* drain;
      const runs = yield* runsOf(threadId);
      assert.equal(continuationOf(runs, first!.id)?.status, "completed");
      const resumed = runs.find((run) => run.id === second!.id);
      assert.deepEqual([resumed?.status, resumed?.queueHeld], ["running", false]);
      assert.lengthOf(yield* resumeCommandIds(threadId), 2);
    }),
  ),
);

it.effect("uses one command id across a rebuilt layer", () =>
  withHarness("rebuilt", ({ cwd, started }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:rebuilt");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      yield* restartOneSecondLater;
      const reconcileCommandId = yield* holdCommandId(threadId, queued[0]!.id);
      const first = yield* scan.pipe(Effect.forkScoped);
      const second = yield* scan.pipe(Effect.provide(Layer.fresh(resumerLayer)), Effect.forkScoped);
      yield* drain;
      yield* finishContinuation(threadId, active.id, started);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* drain;
      const runs = yield* runsOf(threadId);
      assert.equal(continuationOf(runs, active.id)?.status, "completed");
      const resumed = runs.find((run) => run.id === queued[0]!.id);
      assert.deepEqual([resumed?.status, resumed?.queueHeld], ["running", false]);
      const expected = resumeCommandId({
        threadId,
        headRunId: queued[0]!.id,
        reconcileCommandId: CommandId.make(reconcileCommandId!),
      });
      assert.deepEqual(yield* resumeCommandIds(threadId), [expected]);
      assert.lengthOf(
        started.filter((entry) => entry.turn.runId === queued[0]!.id),
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

it.effect.each(["before a scan", "across another restart"] as const)(
  "leaves the hold after an idle Stop on a completed continuation, %s",
  (timing) =>
    withHarness(
      `idle-stop-${timing === "before a scan" ? "scan" : "restart"}`,
      ({ cwd, started }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(
            `thread:idle-stop-${timing === "before a scan" ? "scan" : "restart"}`,
          );
          const { active, queued } = yield* busyThread({ threadId, cwd });
          yield* restartOneSecondLater;
          yield* drain;
          yield* finishContinuation(threadId, active.id, started);
          yield* dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`${threadId}:stop`),
            threadId,
          });
          yield* drain;
          if (timing === "across another restart") {
            yield* restartOneSecondLater;
            yield* drain;
          }
          const projection = yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
            orchestrator.getThreadProjection(threadId),
          );
          const continuation = continuationOf(projection.runs, active.id)!;
          assert.equal(continuation.status, "completed");
          assert.isTrue(
            projection.turnItems.some(
              (item) => item.type === "run_interrupt_request" && item.runId === continuation.id,
            ),
          );
          yield* scan;
          yield* drain;
          const held = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
          assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
          assert.deepEqual(yield* resumeCommandIds(threadId), []);
        }),
    ),
);

it.effect("leaves the hold after the outbox pruned core's refusal of a wake", () =>
  withHarness("pruned-refusal", ({ cwd, started }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:pruned-refusal");
      const { active, queued } = yield* busyThread({ threadId, cwd });
      let source = active;
      for (const _ of [1, 2, 3]) {
        yield* restartOneSecondLater;
        const continuationTurn = yield* nextTurnRunning(source);
        yield* drain;
        yield* Fiber.join(continuationTurn);
        source = continuationOf(yield* runsOf(threadId), source.id)!;
      }
      yield* settleBehindAwaitedWork(threadId, source, started);
      yield* restartOneSecondLater;
      yield* drain;
      assert.isUndefined(continuationOf(yield* runsOf(threadId), source.id));
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const refusal = `effect:restart-continuation:${source.id}`;
      assert.isTrue(Option.isSome(yield* outbox.get(refusal)));
      yield* TestClock.adjust(
        Duration.sum(EffectOutbox.SETTLED_EFFECT_RETENTION, Duration.millis(1)),
      );
      assert.isAbove(yield* outbox.pruneSettled, 0);
      assert.isTrue(Option.isNone(yield* outbox.get(refusal)));
      yield* restartOneSecondLater;
      yield* drain;
      yield* scan;
      yield* drain;
      const held = (yield* runsOf(threadId)).find((run) => run.id === queued[0]!.id);
      assert.deepEqual([held?.status, held?.queueHeld], ["queued", true]);
      assert.deepEqual(yield* resumeCommandIds(threadId), []);
    }),
  ),
);

it.effect.each(["a reorder", "a newer sibling"] as const)(
  "keeps a hold older than the outbox retention, after %s",
  (refresh) =>
    withHarness(`old-hold-${refresh === "a reorder" ? "reorder" : "sibling"}`, ({ cwd, started }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(
          `thread:old-hold-${refresh === "a reorder" ? "reorder" : "sibling"}`,
        );
        const { active, queued } = yield* busyThread({
          threadId,
          cwd,
          queued: refresh === "a reorder" ? 2 : 1,
        });
        yield* restartOneSecondLater;
        yield* drain;
        yield* TestClock.adjust(EffectOutbox.SETTLED_EFFECT_RETENTION);
        if (refresh === "a reorder") {
          yield* dispatch({
            type: "queued-run.reorder",
            commandId: CommandId.make(`${threadId}:reorder`),
            threadId,
            runId: queued[1]!.id,
            beforeRunId: queued[0]!.id,
          });
        } else {
          yield* dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:sibling`),
            threadId,
            messageId: MessageId.make(`${threadId}:sibling`),
            text: "One more",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "queue_after_active" },
            // A user's own send releases the queue upstream (Orchestrator.ts message.dispatch),
            // so the sibling comes from an agent, whose send leaves the hold in place.
            createdBy: "agent",
            creationSource: "mcp",
          });
        }
        const scanning = yield* scan.pipe(Effect.forkScoped);
        yield* finishContinuation(threadId, active.id, started);
        yield* Fiber.join(scanning);
        yield* drain;
        const userRuns = (yield* runsOf(threadId)).filter((run) =>
          queued.some((held) => held.id === run.id),
        );
        assert.lengthOf(userRuns, queued.length);
        assert.isTrue(userRuns.every((run) => run.status === "queued" && run.queueHeld === true));
        assert.deepEqual(yield* resumeCommandIds(threadId), []);
      }),
    ),
);

it.effect(
  "a message the user sends after a restart releases the queue once, with no fork resume",
  () =>
    withHarness("user-send", ({ cwd, started }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:user-send");
        const { active, queued } = yield* busyThread({ threadId, cwd });
        yield* restartOneSecondLater;
        const scanning = yield* scan.pipe(Effect.forkScoped);
        yield* drain;
        const messageId = MessageId.make(`${threadId}:after-restart`);
        yield* dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:after-restart`),
          threadId,
          messageId,
          text: "Back now",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const sent = (yield* runsOf(threadId)).find((run) => run.userMessageId === messageId)!;
        const order = [queued[0]!.id, sent.id];
        for (const run of (yield* runsOf(threadId)).filter((run) => order.includes(run.id)))
          assert.deepEqual([run.status, run.queueHeld === true], ["queued", false]);

        const firstRunning = yield* runStatus(order[0]!, "running");
        yield* finishContinuation(threadId, active.id, started);
        for (const [index, runId] of order.entries()) {
          if (index === 0) yield* Fiber.join(firstRunning);
          const nextRunning =
            index + 1 < order.length ? yield* runStatus(order[index + 1]!, "running") : undefined;
          const settled = yield* runStatus(runId, "waiting");
          const completed = yield* runStatus(runId, "completed");
          yield* finishTurn(started.find((entry) => entry.turn.runId === runId)!);
          yield* Fiber.join(settled);
          yield* drain;
          yield* Fiber.join(completed);
          if (nextRunning !== undefined) yield* Fiber.join(nextRunning);
        }
        yield* Fiber.join(scanning);
        yield* drain;

        assert.deepEqual(yield* resumeCommandIds(threadId), []);
        const runs = yield* runsOf(threadId);
        for (const runId of order)
          assert.equal(runs.find((run) => run.id === runId)?.status, "completed");
        assert.equal(started.filter((entry) => order.includes(entry.turn.runId)).length, 2);
      }),
    ),
);
