import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecoveryService from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  approvalNote,
  approvalWakeMessageId,
  DelegatedRequestTimeout,
  layer as timeoutLayer,
  QUESTION_NOTE,
} from "./DelegatedRequestTimeout.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const projectId = ProjectId.make("project:delegated-request");
const sessionId = ProviderSessionId.make("session:delegated-request");

const layerDatabase = SqlitePersistence.layerMemory;
const layerCore = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "delegated-request-timeout" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerRecovery = ProviderRuntimeRecoveryService.layer.pipe(
  Layer.provide(Layer.mergeAll(IdAllocator.layer, ServerSettings.layerTest())),
);
const layerTest = (env: Record<string, string> = {}) =>
  Layer.mergeAll(timeoutLayer, layerRecovery).pipe(
    Layer.provideMerge(layerCore),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

const PROMPT = 'S=/scratch/replay; for d in target; do F=$S/$d/sub; rm -rf -- "$F"; done';
const REASON =
  "Dangerous rm operation detected. This command sets $F from `$S/$d/sub`. Use a literal absolute path instead.";

type Capability = "live" | "message";

/** A parent thread mid-turn that delegated one task; the child has a live provider session. */
const delegatedChild = (name: string, completionWake: "always" | "settled_only" = "always") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make(`thread:${name}-parent`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${name}-parent`),
      threadId: parentThreadId,
      projectId,
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`start:${name}-parent`),
      threadId: parentThreadId,
      messageId: MessageId.make(`message:${name}-parent`),
      text: "Delegate the cleanup",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* projections.getThreadProjection(parentThreadId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${name}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Remove the target directory",
      completionWake,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const task = (yield* projections.getThreadProjection(parentThreadId)).subagents[0]!;
    const childThreadId = task.childThreadId!;
    const childRun = (yield* projections.getThreadRecords(childThreadId, ["runs"])).runs[0]!;
    yield* attachSession(childThreadId);
    return { parentThreadId, parentRun, task, childThreadId, childRun };
  });

const attachSession = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`session:${threadId}`),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
  });

/**
 * The events a provider writes for one request: Claude's order, request then prompt item. Each
 * comes back so a test can hand it to the module the way the event stream would.
 */
const raise = (input: {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run | null;
  readonly id: string;
  readonly kind: "command" | "user_input";
  readonly capability?: Capability;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const requestId = RuntimeRequestId.make(`request:${input.id}`);
    const nodeId = NodeId.make(`node:${input.id}`);
    const runId = input.run?.id ?? null;
    const base = {
      threadId: input.threadId,
      ...(runId === null ? {} : { runId }),
      nodeId,
      occurredAt: now,
    };
    const request: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: input.kind,
      status: "pending",
      responseCapability:
        (input.capability ?? "live") === "message"
          ? { type: "message" }
          : {
              type: "live",
              providerSessionId: sessionId,
              ...(input.kind === "command" ? { supportsFeedback: true } : {}),
            },
      createdAt: now,
      resolvedAt: null,
    };
    const itemBase = {
      id: TurnItemId.make(`item:${input.id}`),
      threadId: input.threadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 100,
      status: "waiting" as const,
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      requestId,
    };
    const requestEvent = {
      ...base,
      id: EventId.make(`event:${input.id}:request`),
      type: "runtime-request.updated",
      payload: request,
    } satisfies OrchestrationV2DomainEvent;
    const itemEvent = {
      ...base,
      id: EventId.make(`event:${input.id}:item`),
      type: "turn-item.updated",
      payload:
        input.kind === "command"
          ? {
              ...itemBase,
              type: "approval_request" as const,
              requestKind: "command" as const,
              prompt: PROMPT,
              reason: REASON,
              fullAccessOverride: "provider_check" as const,
            }
          : {
              ...itemBase,
              type: "user_input_request" as const,
              questions: [
                {
                  id: "path",
                  header: "Path",
                  question: "Which directory should I remove?",
                  options: [],
                },
              ],
            },
    } satisfies OrchestrationV2DomainEvent;
    yield* eventSink.write({
      commandId: CommandId.make(`seed:${input.id}`),
      events: [
        {
          ...base,
          id: EventId.make(`event:${input.id}:node`),
          type: "node.updated",
          payload: {
            id: nodeId,
            threadId: input.threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: input.kind === "command" ? "approval_request" : "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        requestEvent,
        itemEvent,
      ],
    });
    return { requestId, requestEvent, itemEvent };
  });

const handle = (event: OrchestrationV2DomainEvent) =>
  Effect.flatMap(DelegatedRequestTimeout, (service) => service.handle(event));

const sweep = Effect.flatMap(DelegatedRequestTimeout, (service) => service.sweep);

const requestOf = (threadId: ThreadId, requestId: RuntimeRequestId) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    projections.getRuntimeRequest(threadId, requestId),
  );

/** The resolve event the engine publishes, read back from what the command wrote. */
const resolvedEvent = (threadId: ThreadId, requestId: RuntimeRequestId) =>
  Effect.map(
    requestOf(threadId, requestId),
    (request) =>
      ({
        id: EventId.make(`event:${requestId}:resolved`),
        type: "runtime-request.updated",
        threadId,
        occurredAt: request!.resolvedAt!,
        payload: request!,
      }) satisfies OrchestrationV2DomainEvent,
  );

const wakesOn = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    projections
      .getThreadProjection(threadId)
      .pipe(
        Effect.map((projection) =>
          projection.messages.filter(
            (message) => message.notification?.source.kind === "delegated_task",
          ),
        ),
      ),
  );

/** What each provider was sent: the respond effects queued for the thread, oldest first. */
const respondEffects = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const rows = yield* sql<{ readonly command_id: CommandId }>`
      SELECT command_id FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND effect_type = 'runtime-request.respond'
      ORDER BY created_at ASC, effect_id ASC
    `;
    const effects = yield* Effect.forEach(rows, (row) => outbox.listByCommandId(row.command_id));
    return effects
      .flat()
      .flatMap((effect) =>
        effect.request.type === "runtime-request.respond" ? [effect.request] : [],
      );
  });

/** Lets the timer that a clock jump woke finish its dispatch. */
const settle = Effect.repeat(Effect.yieldNow, { times: 50 });

const advance = (duration: Duration.Input) =>
  TestClock.adjust(duration).pipe(Effect.andThen(settle));

it.effect(
  "wakes the parent once when its delegated task hits a permission prompt, and declines it with the note at ten minutes",
  () =>
    Effect.gen(function* () {
      const { parentThreadId, task, childThreadId, childRun } = yield* delegatedChild("decline");
      const { requestId, requestEvent, itemEvent } = yield* raise({
        threadId: childThreadId,
        run: childRun,
        id: "decline",
        kind: "command",
      });
      for (const event of [requestEvent, itemEvent, requestEvent, itemEvent]) yield* handle(event);

      const wakes = yield* wakesOn(parentThreadId);
      assert.equal(wakes.length, 1);
      const wake = wakes[0]!;
      assert.include(wake.text, `Delegated task ${task.id} is blocked on a permission prompt`);
      assert.include(wake.text, PROMPT);
      assert.include(wake.text, REASON);
      assert.include(wake.text, "An agent cannot approve or decline it");
      assert.include(wake.text, `The user can answer it in thread ${childThreadId}.`);
      assert.include(wake.text, "1970-01-01T00:10:00.000Z");
      assert.deepEqual(wake.notification, {
        source: { kind: "delegated_task", taskIds: [task.id], childThreadId },
        outcome: "updated",
        summary: 'Delegated task "Remove the target directory" needs approval',
      });

      yield* advance("9 minutes");
      assert.equal((yield* requestOf(childThreadId, requestId))?.status, "pending");

      yield* advance("1 minute");
      const declined = yield* requestOf(childThreadId, requestId);
      assert.equal(declined?.status, "resolved");
      assert.equal(declined?.decision, "decline");
      const note = approvalNote(REASON);
      assert.include(note, "No human is available");
      assert.include(note, "waiting 10 minutes");
      assert.include(note, `"${REASON}"`);
      assert.include(note, "stop and say in your final message what you needed");
      assert.deepEqual(yield* respondEffects(childThreadId), [
        {
          type: "runtime-request.respond",
          providerSessionId: sessionId,
          requestId,
          decision: "decline",
          feedback: note,
        },
      ]);

      // The resolve event cancels the wake still queued behind the parent's turn.
      const wakeRunOf = Effect.map(
        Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
          projections.getThreadRecords(parentThreadId, ["runs"]),
        ),
        ({ runs }) =>
          runs.find(
            (run) => run.userMessageId === approvalWakeMessageId(parentThreadId, requestId),
          ),
      );
      assert.equal((yield* wakeRunOf)?.status, "queued");
      yield* handle(yield* resolvedEvent(childThreadId, requestId));
      assert.equal((yield* wakeRunOf)?.status, "cancelled");

      yield* sweep;
      yield* advance("10 minutes");
      assert.equal((yield* respondEffects(childThreadId)).length, 1);
    }).pipe(Effect.provide(layerTest())),
);

it.effect("sends nothing when the user answers before the deadline", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { childThreadId, childRun } = yield* delegatedChild("answered");
    const { requestId, requestEvent, itemEvent } = yield* raise({
      threadId: childThreadId,
      run: childRun,
      id: "answered",
      kind: "command",
    });
    yield* handle(requestEvent);
    yield* handle(itemEvent);
    yield* advance("4 minutes");
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("user-approves"),
      threadId: childThreadId,
      requestId,
      decision: "accept",
    });
    yield* handle(yield* resolvedEvent(childThreadId, requestId));
    yield* advance("10 minutes");
    yield* sweep;
    yield* advance("10 minutes");
    assert.equal((yield* requestOf(childThreadId, requestId))?.decision, "accept");
    assert.deepEqual(
      (yield* respondEffects(childThreadId)).map((effect) => effect.decision),
      ["accept"],
    );
  }).pipe(Effect.provide(layerTest())),
);

it.effect(
  "lets a blocking delegate_task wait report the approval itself, and still declines it",
  () =>
    Effect.gen(function* () {
      const { parentThreadId, childThreadId, childRun } = yield* delegatedChild(
        "waiting",
        "settled_only",
      );
      const { requestId, requestEvent, itemEvent } = yield* raise({
        threadId: childThreadId,
        run: childRun,
        id: "waiting",
        kind: "command",
      });
      yield* handle(requestEvent);
      yield* handle(itemEvent);
      assert.deepEqual(yield* wakesOn(parentThreadId), []);
      yield* advance("10 minutes");
      assert.equal((yield* requestOf(childThreadId, requestId))?.decision, "decline");
    }).pipe(Effect.provide(layerTest())),
);

it.effect("after a restart, answers an overdue delegated question with the note as its reply", () =>
  Effect.gen(function* () {
    const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { childThreadId, childRun } = yield* delegatedChild("restart");
    const { requestId } = yield* raise({
      threadId: childThreadId,
      run: childRun,
      id: "restart",
      kind: "user_input",
    });
    yield* TestClock.adjust("25 minutes");
    yield* recovery.reconcile("startup");
    const recovered = yield* requestOf(childThreadId, requestId);
    assert.equal(recovered?.status, "pending");
    assert.equal(recovered?.responseCapability.type, "message");

    yield* sweep;
    yield* settle;
    const answered = yield* requestOf(childThreadId, requestId);
    assert.equal(answered?.status, "resolved");
    assert.deepEqual(answered?.answers, { path: QUESTION_NOTE });
    const { messages } = yield* projections.getThreadRecords(childThreadId, ["messages"]);
    assert.equal(messages.at(-1)?.role, "user");
    assert.equal(messages.at(-1)?.text, `Which directory should I remove?\n${QUESTION_NOTE}`);
    assert.include(QUESTION_NOTE, "No human is available");
    assert.include(QUESTION_NOTE, "waiting 10 minutes");
  }).pipe(Effect.provide(layerTest())),
);

it.effect("answers a live delegated question at the deadline", () =>
  Effect.gen(function* () {
    const { childThreadId, childRun } = yield* delegatedChild("live-question");
    const { requestId, requestEvent } = yield* raise({
      threadId: childThreadId,
      run: childRun,
      id: "live-question",
      kind: "user_input",
    });
    yield* handle(requestEvent);
    yield* advance("10 minutes");
    assert.deepEqual(yield* respondEffects(childThreadId), [
      {
        type: "runtime-request.respond",
        providerSessionId: sessionId,
        requestId,
        answers: { path: QUESTION_NOTE },
      },
    ]);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("declines a linked environment's delegated child, whose parent is elsewhere", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:linked-child");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:linked-child"),
      threadId,
      projectId,
      title: "Linked child",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "agent",
      creationSource: "mcp",
      linkOrigin: { sessionId: "session:peer", label: "Laptop", access: "full-access" },
      delegatedFrom: {
        environmentId: EnvironmentId.make("environment:laptop"),
        threadId: ThreadId.make("thread:laptop-parent"),
        title: "Parent on the laptop",
      },
    });
    yield* attachSession(threadId);
    const { requestId, requestEvent, itemEvent } = yield* raise({
      threadId,
      run: null,
      id: "linked",
      kind: "command",
    });
    yield* handle(requestEvent);
    yield* handle(itemEvent);
    yield* advance("10 minutes");
    assert.equal((yield* requestOf(threadId, requestId))?.decision, "decline");
  }).pipe(Effect.provide(layerTest())),
);

it.effect("leaves a top-level thread's and a fork's prompts and questions to their user", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:top-level");
    const forkId = ThreadId.make("thread:top-level-fork");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:top-level"),
      threadId,
      projectId,
      title: "Mine",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start:top-level"),
      threadId,
      messageId: MessageId.make("message:top-level"),
      text: "Tidy up",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* projections.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make("event:top-level-run-completed"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork:top-level"),
      sourceThreadId: threadId,
      targetThreadId: forkId,
      sourcePoint: { type: "run", runId: run.id },
      createdBy: "user",
      creationSource: "web",
    });
    assert.equal((yield* projections.getThread(forkId)).lineage.parentThreadId, threadId);
    const raised = [];
    for (const thread of [threadId, forkId]) {
      yield* attachSession(thread);
      raised.push(
        yield* raise({ threadId: thread, run: null, id: `${thread}:a`, kind: "command" }),
      );
      raised.push(
        yield* raise({
          threadId: thread,
          run: null,
          id: `${thread}:q`,
          kind: "user_input",
          capability: "message",
        }),
      );
    }
    for (const { requestEvent, itemEvent } of raised) {
      yield* handle(requestEvent);
      yield* handle(itemEvent);
    }
    yield* advance("30 minutes");
    yield* sweep;
    yield* advance("30 minutes");
    for (const { requestEvent } of raised) {
      assert.equal(
        (yield* requestOf(requestEvent.threadId, requestEvent.payload.id))?.status,
        "pending",
      );
    }
    assert.deepEqual(yield* wakesOn(threadId), []);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("follows the event stream from start: a prompt raised later wakes the parent", () =>
  Effect.gen(function* () {
    const { parentThreadId, childThreadId, childRun } = yield* delegatedChild("stream");
    const service = yield* DelegatedRequestTimeout;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* service.start();
        yield* settle;
        const { requestId } = yield* raise({
          threadId: childThreadId,
          run: childRun,
          id: "stream",
          kind: "command",
        });
        yield* settle;
        assert.equal((yield* wakesOn(parentThreadId)).length, 1);
        yield* advance("10 minutes");
        assert.equal((yield* requestOf(childThreadId, requestId))?.decision, "decline");
      }),
    );
  }).pipe(Effect.provide(layerTest())),
);

it.effect.each([
  { env: {}, status: "resolved" },
  { env: { T3CODE_DELEGATED_REQUEST_TIMEOUT: "off" }, status: "pending" },
] as const)(
  "with env $env, start's first sweep leaves an overdue question $status",
  ({ env, status }) =>
    Effect.gen(function* () {
      const { childThreadId, childRun } = yield* delegatedChild("switch");
      const { requestId } = yield* raise({
        threadId: childThreadId,
        run: childRun,
        id: "switch",
        kind: "user_input",
        capability: "message",
      });
      yield* TestClock.adjust("11 minutes");
      const service = yield* DelegatedRequestTimeout;
      yield* Effect.scoped(service.start().pipe(Effect.andThen(advance("1 second"))));
      assert.equal((yield* requestOf(childThreadId, requestId))?.status, status);
    }).pipe(Effect.provide(layerTest(env))),
);
