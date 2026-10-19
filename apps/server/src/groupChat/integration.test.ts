import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  CommandId,
  EventId,
  type GroupChatGroupId,
  type GroupChatMemberId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ThreadWorkflowActor,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadWorkflow from "../threadWorkflow/layer.ts";
import { ThreadWorkflowService } from "../threadWorkflow/ThreadWorkflowService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import type { GroupChatEngine } from "./engine.ts";
import * as GroupChat from "./layer.ts";
import type { DeliveryRow, GroupChatStore } from "./store.ts";
import { dispatchIds, GroupChatThreadPort, GROUP_CHAT_MESSAGE_PREFIX } from "./threadPort.ts";
import * as ThreadPort from "./threadPort.ts";

const user: ThreadWorkflowActor = { _tag: "user", clientSessionId: "pane" };
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by group chat tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const layerProviderInstances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
  listInstances: Effect.succeed([providerInstance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

interface Gates {
  thread: Deferred.Deferred<void> | null;
  sent: Deferred.Deferred<void> | null;
  afterSend: Deferred.Deferred<void> | null;
  beforeCancel: Deferred.Deferred<void> | null;
}
const gates: Gates = { thread: null, sent: null, afterSend: null, beforeCancel: null };

const layerGatedPort = Layer.effect(
  GroupChatThreadPort,
  Effect.map(GroupChatThreadPort, (port) =>
    GroupChatThreadPort.of({
      ...port,
      thread: (threadId) =>
        (gates.thread === null ? Effect.void : Deferred.await(gates.thread)).pipe(
          Effect.andThen(port.thread(threadId)),
        ),
      send: (input) =>
        port.send(input).pipe(
          Effect.tap(() =>
            gates.sent === null ? Effect.void : Deferred.succeed(gates.sent, undefined),
          ),
          Effect.tap(() =>
            gates.afterSend === null ? Effect.void : Deferred.await(gates.afterSend),
          ),
        ),
      cancelQueued: (input) =>
        (gates.beforeCancel === null ? Effect.void : Deferred.await(gates.beforeCancel)).pipe(
          Effect.andThen(port.cancelQueued(input)),
        ),
    }),
  ),
).pipe(Layer.provide(ThreadPort.layer));

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-group-chat-integration-",
});

const makeLayerTest = () => {
  const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
    Layer.provide(
      VcsDriverRegistry.layer.pipe(
        Layer.provide(VcsProcess.layer),
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatformTest),
      ),
    ),
  );
  const layerSettings = ServerSettings.layerTest({ threadWorkflowsEnabled: true });
  const layerStubs = Layer.mergeAll(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
    }),
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
    McpSessionRegistryTestkit.layer,
    McpProviderSessions.layer,
    layerCheckpointStoreTest,
    layerProviderInstances,
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  );
  const layerWorkflow = ThreadWorkflow.layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    Layer.provide(layerSettings),
    Layer.provide(ProjectionStore.layer),
    Layer.provide(ThreadCommandExecutor.layer),
  );
  const layerGraph = Layer.mergeAll(
    RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
    RuntimeLayer.layerProjectService,
    RuntimeLayer.layerEventSink,
    ThreadCommandExecutor.layer,
    ProjectionStore.layer,
  ).pipe(
    Layer.provideMerge(layerWorkflow),
    Layer.provide(layerStubs),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(layerServerConfig),
    Layer.provideMerge(layerSettings),
    Layer.provideMerge(layerPlatformTest),
  );
  const layerIdentity = ServerEnvironment.layerIdentity.pipe(Layer.provide(layerGraph));
  const layerPort = layerGatedPort.pipe(Layer.provide(layerGraph), Layer.provide(layerIdentity));
  const layerModule = GroupChat.layer.pipe(
    Layer.provide(layerPort),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    Layer.provide(layerGraph),
  );
  const layerStart = Layer.effectDiscard(
    Effect.flatMap(GroupChat.GroupChat, (groupChat) =>
      Effect.flatMap(groupChat.engine, (engine) => engine.start),
    ),
  ).pipe(Layer.provide(layerModule));
  return Layer.mergeAll(layerGraph, layerIdentity, layerPort, layerModule, layerStart);
};

const id = (value: string) => CommandId.make(value);

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectService.ProjectService, (projects) =>
    projects.create({
      commandId: id(`${projectId}-create`),
      projectId,
      title: projectId,
      workspaceRoot: `/work/${projectId}`,
    }),
  );

const createThread = (threadId: ThreadId, projectId: ProjectId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: id(`${threadId}-create`),
      threadId,
      projectId,
      title: `${threadId} thread`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  );

const operatorTurn = (threadId: ThreadId, key: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: id(`${threadId}-${key}`),
      threadId,
      messageId: MessageId.make(`${threadId}-${key}`),
      text: `operator ${key}`,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
    }),
  );

const runOf = (threadId: ThreadId, runId: RunId) =>
  Effect.map(
    Effect.flatMap(Orchestrator.OrchestratorV2, (o) => o.getThreadProjection(threadId)),
    ({ runs }) => runs.find((run) => run.id === runId)!,
  );

const startRun = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const run = yield* runOf(threadId, runId);
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:${runId}:start`),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: { ...run, status: "running", startedAt: now, queuePosition: null },
        },
      ],
    });
  });

const endRun = (
  threadId: ThreadId,
  runId: RunId,
  status: "completed" | "interrupted" | "cancelled",
  text: string | null,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const run = yield* runOf(threadId, runId);
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        ...(text === null
          ? []
          : [
              {
                id: EventId.make(`event:${runId}:reply`),
                type: "message.updated" as const,
                threadId,
                runId,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`${runId}:reply`),
                  threadId,
                  runId,
                  nodeId: null,
                  role: "assistant" as const,
                  text,
                  attachments: [],
                  streaming: false,
                  createdBy: "agent" as const,
                  creationSource: "provider" as const,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ]),
        {
          id: EventId.make(`event:${runId}:${status}`),
          type: "run.updated" as const,
          threadId,
          runId,
          occurredAt: now,
          payload: { ...run, status, startedAt: run.startedAt ?? now, completedAt: now },
        },
      ],
    });
  });

interface App {
  readonly engine: GroupChatEngine["Service"];
  readonly store: GroupChatStore;
  readonly until: <A, E, R>(
    read: Effect.Effect<A, E, R>,
    predicate: (value: A) => boolean,
  ) => Effect.Effect<A, never, R>;
}

const openApp = Effect.gen(function* () {
  const groupChat = yield* GroupChat.GroupChat;
  const engine = yield* groupChat.engine.pipe(Effect.orDie);
  const store = yield* groupChat.store.pipe(Effect.orDie);
  const subscription = yield* PubSub.subscribe(store.changes);
  const until: App["until"] = (read, predicate) =>
    Effect.gen(function* () {
      for (;;) {
        const value = yield* read.pipe(Effect.orDie);
        if (predicate(value)) return value;
        yield* PubSub.take(subscription);
      }
    });
  return { engine, store, until } satisfies App;
});

const createGroup = (app: App, name: string, threads: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make(`${name}-project`);
    yield* createProject(projectId);
    for (const threadId of threads) yield* createThread(threadId, projectId);
    const created = yield* app.engine
      .dispatch({ _tag: "group.create", title: name, threadIds: threads })
      .pipe(Effect.orDie);
    const group = created._tag === "group" ? created.group : assert.fail("group");
    const members = yield* app.store.members(group.id, true).pipe(Effect.orDie);
    return {
      group,
      projectId,
      member: (threadId: ThreadId) => members.find((m) => m.thread.threadId === threadId)!,
    };
  });

const send = (
  app: App,
  groupId: GroupChatGroupId,
  text: string,
  recipients: ReadonlyArray<GroupChatMemberId>,
) =>
  app.engine.dispatch({ _tag: "message.send", groupId, text, recipients }).pipe(
    Effect.orDie,
    Effect.map((r) => (r._tag === "message" ? r.message : assert.fail("message"))),
  );

const latest = (app: App, memberId: GroupChatMemberId) =>
  Effect.map(app.store.deliveriesOfMember(memberId), (rows) => rows.at(-1) ?? null);

const awaitDelivery = (
  app: App,
  memberId: GroupChatMemberId,
  predicate: (d: DeliveryRow) => boolean,
) =>
  Effect.map(
    app.until(latest(app, memberId), (d) => d !== null && predicate(d)),
    (d) => d!,
  );

const startEnvelope = (app: App, threadId: ThreadId, memberId: GroupChatMemberId) =>
  Effect.gen(function* () {
    const accepted = yield* awaitDelivery(
      app,
      memberId,
      (d) => d.dispatch === "accepted" && d.runId !== null,
    );
    yield* startRun(threadId, accepted.runId!);
    return yield* awaitDelivery(app, memberId, (d) => d.state === "running");
  });

const threadMessages = (threadId: ThreadId) =>
  Effect.map(
    Effect.flatMap(Orchestrator.OrchestratorV2, (o) => o.getThreadProjection(threadId)),
    (projection) => projection,
  );

it.layer(makeLayerTest())("group chat on the orchestration graph", (it) => {
  it.effect("send creates the envelope user message with the derived ids", () =>
    Effect.gen(function* () {
      const app = yield* openApp;
      const threadId = ThreadId.make("gc-ids-thread");
      const { group, member } = yield* createGroup(app, "gc-ids", [threadId]);
      const message = yield* send(app, group.id, "hello", [member(threadId).id]);
      const running = yield* startEnvelope(app, threadId, member(threadId).id);
      const ids = dispatchIds({
        groupMessageId: message.id,
        memberId: member(threadId).id,
        attempt: 1,
      });
      assert.strictEqual(running.messageId, ids.messageId);
      const projection = yield* threadMessages(threadId);
      const stored = projection.messages.find((m) => m.id === ids.messageId)!;
      assert.isDefined(stored);
      assert.strictEqual(stored.createdBy, "agent");
      assert.strictEqual(stored.creationSource, "server");
      assert.strictEqual(stored.runId, running.runId);
      assert.include(stored.text, "<<GROUP CHAT ENVELOPE");
      assert.isTrue(ids.messageId.startsWith(GROUP_CHAT_MESSAGE_PREFIX));
      const run = projection.runs.find((r) => r.id === running.runId)!;
      assert.strictEqual(run.userMessageId, ids.messageId);
      assert.strictEqual((yield* app.store.member(member(threadId).id))!.seenSeq, 1);
      yield* endRun(threadId, running.runId!, "completed", "hi there");
      const replied = yield* awaitDelivery(app, member(threadId).id, (d) => d.state === "replied");
      const reply = (yield* app.store.message(replied.replyMessageId!))!;
      assert.strictEqual(reply.text, "hi there");
    }),
  );

  it.effect(
    "a send to a busy thread is queued, never steered, and the seen mark moves only when its run starts",
    () =>
      Effect.gen(function* () {
        const app = yield* openApp;
        const threadId = ThreadId.make("gc-busy-thread");
        const { group, member } = yield* createGroup(app, "gc-busy", [threadId]);
        yield* operatorTurn(threadId, "turn");
        yield* send(app, group.id, "while busy", [member(threadId).id]);
        const queued = yield* awaitDelivery(
          app,
          member(threadId).id,
          (d) => d.wait?._tag === "busy_with_own_run",
        );
        assert.strictEqual(queued.state, "queued");
        const projection = yield* threadMessages(threadId);
        const envelope = projection.runs.find((r) => r.id === queued.runId)!;
        assert.strictEqual(envelope.status, "queued");
        const operator = projection.runs.find((r) => r.userMessageId === `${threadId}-turn`)!;
        assert.deepStrictEqual(queued.wait, { _tag: "busy_with_own_run", runId: operator.id });
        assert.notStrictEqual(envelope.id, operator.id, "its own run, not the operator's");
        assert.strictEqual((yield* app.store.member(member(threadId).id))!.seenSeq, 0);
        yield* endRun(threadId, operator.id, "completed", "operator reply");
        yield* startRun(threadId, envelope.id);
        yield* awaitDelivery(app, member(threadId).id, (d) => d.state === "running");
        assert.strictEqual((yield* app.store.member(member(threadId).id))!.seenSeq, 1);
      }),
  );

  it.effect("a repeat dispatch with the same ids replays the receipt", () =>
    Effect.gen(function* () {
      const app = yield* openApp;
      const port = yield* GroupChatThreadPort;
      const threadId = ThreadId.make("gc-replay-thread");
      const { projectId } = yield* createGroup(app, "gc-replay", [threadId]);
      const ids = dispatchIds({ groupMessageId: "msg_replay", memberId: "mem_replay", attempt: 1 });
      const first = yield* port.send({ threadId, projectId, text: "once", ...ids });
      const second = yield* port.send({ threadId, projectId, text: "once", ...ids });
      assert.strictEqual(first.runId, second.runId);
      const projection = yield* threadMessages(threadId);
      assert.strictEqual(projection.messages.filter((m) => m.id === ids.messageId).length, 1);
    }),
  );

  it.effect("a rejected command id is never reused", () =>
    Effect.gen(function* () {
      const app = yield* openApp;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("gc-archived-thread");
      const { group, member } = yield* createGroup(app, "gc-archived", [threadId]);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: id(`${threadId}-archive`),
        threadId,
      });
      yield* send(app, group.id, "to an archived thread", [member(threadId).id]);
      const failed = yield* awaitDelivery(app, member(threadId).id, (d) => d.state === "failed");
      assert.strictEqual(failed.dispatch, "rejected");
      assert.match(failed.error!, /archived/);
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: id(`${threadId}-unarchive`),
        threadId,
      });
      yield* app.engine
        .dispatch({ _tag: "delivery.retry", deliveryId: failed.id })
        .pipe(Effect.orDie);
      const running = yield* startEnvelope(app, threadId, member(threadId).id);
      assert.strictEqual(running.attempt, 2);
      const first = dispatchIds({
        groupMessageId: failed.triggerMessageId,
        memberId: failed.memberId,
        attempt: 1,
      });
      const second = dispatchIds({
        groupMessageId: failed.triggerMessageId,
        memberId: failed.memberId,
        attempt: 2,
      });
      assert.strictEqual(running.messageId, second.messageId);
      const projection = yield* threadMessages(threadId);
      assert.isUndefined(projection.messages.find((m) => m.id === first.messageId));
      assert.isDefined(projection.messages.find((m) => m.id === second.messageId));
    }),
  );

  it.effect("a send to a deleted member thread fails for good", () =>
    Effect.gen(function* () {
      const app = yield* openApp;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("gc-deleted-thread");
      const { group, member } = yield* createGroup(app, "gc-deleted", [threadId]);
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: id(`${threadId}-delete`),
        threadId,
      });
      yield* send(app, group.id, "to a deleted thread", [member(threadId).id]);
      const failed = yield* awaitDelivery(app, member(threadId).id, (d) => d.state === "failed");
      assert.strictEqual(failed.dispatch, "rejected");
      assert.strictEqual(failed.error, "the member's thread no longer exists");
      assert.strictEqual(failed.attempt, 1);
    }),
  );

  it.effect("waiting on a restarted run returns its continuation", () =>
    Effect.gen(function* () {
      const app = yield* openApp;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("gc-restart-thread");
      const { group, member } = yield* createGroup(app, "gc-restart", [threadId]);
      yield* send(app, group.id, "survive a restart", [member(threadId).id]);
      const running = yield* startEnvelope(app, threadId, member(threadId).id);
      const original = yield* runOf(threadId, running.runId!);
      const now = yield* DateTime.now;
      // Recovery cuts the run and admits its continuation in one commit, so the engine never
      // sees the cut without the run that replaces it.
      const continuationId = RunId.make(`${original.id}:continuation`);
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:${original.id}:cut`),
            type: "run.updated",
            threadId,
            runId: original.id,
            occurredAt: now,
            payload: { ...original, status: "cancelled", completedAt: now },
          },
          {
            id: EventId.make(`event:${continuationId}:created`),
            type: "run.created",
            threadId,
            runId: continuationId,
            occurredAt: now,
            payload: {
              ...original,
              id: continuationId,
              ordinal: original.ordinal + 1,
              status: "running",
              startedAt: now,
              completedAt: null,
              restartContinuationOfRunId: original.id,
            },
          },
        ],
      });
      const continued = yield* awaitDelivery(
        app,
        member(threadId).id,
        (d) => d.runId !== original.id,
      );
      const continuation = yield* runOf(threadId, continued.runId!);
      assert.strictEqual(continuation.restartContinuationOfRunId, original.id);
      assert.strictEqual(
        continued.state,
        "running",
        "the seen mark moved once; the continuation keeps it",
      );
      yield* startRun(threadId, continuation.id);
      yield* endRun(threadId, continuation.id, "completed", "after the restart");
      const replied = yield* awaitDelivery(app, member(threadId).id, (d) => d.state === "replied");
      assert.strictEqual(replied.runId, continuation.id);
      assert.strictEqual(
        (yield* app.store.message(replied.replyMessageId!))!.text,
        "after the restart",
      );
      assert.strictEqual(
        (yield* threadMessages(threadId)).messages.filter((m) =>
          m.id.startsWith(GROUP_CHAT_MESSAGE_PREFIX),
        ).length,
        1,
        "the thread holds exactly one envelope",
      );
    }),
  );

  it.effect("settling a thread with an open workflow returns the hook's sentence", () =>
    Effect.gen(function* () {
      const app = yield* openApp;
      const workflows = yield* ThreadWorkflowService;
      const threadId = ThreadId.make("gc-settle-thread");
      const { member } = yield* createGroup(app, "gc-settle", [threadId]);
      yield* workflows.apply(user, threadId, { _tag: "start", templateId: "open-ended" as never });
      const refused = yield* app.engine
        .dispatch({ _tag: "member.thread.settle", memberId: member(threadId).id })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "GroupChatThreadRefused");
      assert.match(
        (refused as { reason: string }).reason,
        /^Thread gc-settle-thread .*open workflow "Open-ended" \(w1, 3 of 3 steps open\)/,
      );
      yield* workflows.apply(user, threadId, {
        _tag: "close",
        instanceId: "w1" as never,
        outcome: "abandoned",
        reason: "test",
      });
      yield* app.engine
        .dispatch({ _tag: "member.thread.settle", memberId: member(threadId).id })
        .pipe(Effect.orDie);
      assert.strictEqual((yield* threadMessages(threadId)).thread.settledOverride, "settled");
      yield* app.engine
        .dispatch({ _tag: "member.thread.unsettle", memberId: member(threadId).id })
        .pipe(Effect.orDie);
      assert.strictEqual((yield* threadMessages(threadId)).thread.settledOverride, "active");
    }),
  );

  it.effect("Stop during an in-flight dispatch lets it finish and shows the reply late", () =>
    Effect.gen(function* () {
      const app = yield* openApp;
      const a = ThreadId.make("gc-inflight-a");
      const b = ThreadId.make("gc-inflight-b");
      const { group, member } = yield* createGroup(app, "gc-inflight", [a, b]);
      const gate = yield* Deferred.make<void>();
      const sent = yield* Deferred.make<void>();
      gates.afterSend = gate;
      gates.sent = sent;
      const started = yield* app.engine
        .dispatch({
          _tag: "discussion.start",
          groupId: group.id,
          participants: [member(a).id, member(b).id],
          topic: "t",
          maxRounds: 2,
        })
        .pipe(Effect.orDie);
      const discussion =
        started._tag === "discussion" ? started.discussion : assert.fail("discussion");
      yield* Deferred.await(sent);
      assert.strictEqual(
        (yield* latest(app, member(a).id).pipe(Effect.orDie))!.dispatch,
        "sending",
      );
      yield* app.engine
        .dispatch({ _tag: "discussion.stop", discussionId: discussion.id })
        .pipe(Effect.orDie);
      gates.afterSend = null;
      gates.sent = null;
      yield* Deferred.succeed(gate, undefined);
      const running = yield* startEnvelope(app, a, member(a).id);
      assert.strictEqual(running.withdrawn, "discussion stopped");
      yield* endRun(a, running.runId!, "completed", "late view");
      const replied = yield* awaitDelivery(app, member(a).id, (d) => d.state === "replied");
      assert.isTrue((yield* app.store.message(replied.replyMessageId!))!.late);
    }),
  );

  it.effect(
    "a crash after the dispatch commits but before the engine records it is found at boot by the derived id",
    () =>
      Effect.gen(function* () {
        const app = yield* openApp;
        const a = ThreadId.make("gc-crash-a");
        const { group, member } = yield* createGroup(app, "gc-crash", [a]);
        const gate = yield* Deferred.make<void>();
        const sent = yield* Deferred.make<void>();
        gates.afterSend = gate;
        gates.sent = sent;
        yield* send(app, group.id, "then crash", [member(a).id]);
        yield* Deferred.await(sent);
        const sending = (yield* latest(app, member(a).id).pipe(Effect.orDie))!;
        assert.strictEqual(sending.dispatch, "sending");
        assert.isTrue((yield* threadMessages(a)).messages.some((m) => m.id === sending.messageId));
        gates.afterSend = null;
        gates.sent = null;

        const config = yield* ServerConfig.ServerConfig;
        const port = yield* GroupChatThreadPort;
        const rebooted = yield* Effect.flatMap(
          Layer.build(
            Layer.fresh(GroupChat.layer).pipe(
              Layer.provide(Layer.succeed(GroupChatThreadPort, port)),
              Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
              Layer.provide(NodeServices.layer),
            ),
          ),
          (context) => Effect.succeed(Context.get(context, GroupChat.GroupChat)),
        ).pipe(Effect.orDie);
        const engine = yield* rebooted.engine.pipe(Effect.orDie);
        const store = yield* rebooted.store.pipe(Effect.orDie);
        const subscription = yield* PubSub.subscribe(store.changes);
        yield* engine.start;
        const accepted = yield* Effect.gen(function* () {
          for (;;) {
            const row = yield* store.delivery(sending.id).pipe(Effect.orDie);
            if (row?.dispatch === "accepted" && row.runId !== null) return row;
            yield* PubSub.take(subscription);
          }
        });
        yield* startRun(a, accepted.runId!);
        const found = yield* Effect.gen(function* () {
          for (;;) {
            const row = yield* store.delivery(sending.id).pipe(Effect.orDie);
            if (row?.state === "running") return row;
            yield* PubSub.take(subscription);
          }
        });
        assert.strictEqual(found.dispatch, "accepted");
        yield* endRun(a, found.runId!, "completed", "found after the crash");
        const replied = yield* Effect.gen(function* () {
          for (;;) {
            const row = yield* store.delivery(sending.id).pipe(Effect.orDie);
            if (row?.state === "replied") return row;
            yield* PubSub.take(subscription);
          }
        });
        const reply = (yield* store.message(replied.replyMessageId!).pipe(Effect.orDie))!;
        assert.strictEqual(reply.text, "found after the crash");
        assert.isFalse(reply.late, "nobody withdrew it, so the reply is on time");
        assert.strictEqual(
          (yield* threadMessages(a)).messages.filter((m) =>
            m.id.startsWith(GROUP_CHAT_MESSAGE_PREFIX),
          ).length,
          1,
          "never sent twice",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("Stop while the pre-send step runs sends nothing", () =>
    Effect.gen(function* () {
      const app = yield* openApp;
      const a = ThreadId.make("gc-presend-a");
      const b = ThreadId.make("gc-presend-b");
      const { group, member } = yield* createGroup(app, "gc-presend", [a, b]);
      const gate = yield* Deferred.make<void>();
      gates.thread = gate;
      const started = yield* app.engine
        .dispatch({
          _tag: "discussion.start",
          groupId: group.id,
          participants: [member(a).id, member(b).id],
          topic: "t",
          maxRounds: 2,
        })
        .pipe(Effect.orDie);
      const discussion =
        started._tag === "discussion" ? started.discussion : assert.fail("discussion");
      yield* awaitDelivery(app, member(a).id, (d) => d.state === "pending" && d.wait === null);
      yield* app.engine
        .dispatch({ _tag: "discussion.stop", discussionId: discussion.id })
        .pipe(Effect.orDie);
      gates.thread = null;
      yield* Deferred.succeed(gate, undefined);
      yield* awaitDelivery(app, member(a).id, (d) => d.state === "cancelled");
      yield* awaitDelivery(app, member(b).id, (d) => d.state === "cancelled");
      for (const threadId of [a, b]) {
        assert.isEmpty(
          (yield* threadMessages(threadId)).messages.filter((m) =>
            m.id.startsWith(GROUP_CHAT_MESSAGE_PREFIX),
          ),
        );
      }
    }),
  );

  it.effect(
    "the queued envelope starts while its cancel is in flight, and its reply shows late",
    () =>
      Effect.gen(function* () {
        const app = yield* openApp;
        const a = ThreadId.make("gc-race-a");
        const { group, member } = yield* createGroup(app, "gc-race", [a]);
        yield* operatorTurn(a, "turn");
        yield* send(app, group.id, "race me", [member(a).id]);
        const queued = yield* awaitDelivery(app, member(a).id, (d) => d.state === "queued");
        const gate = yield* Deferred.make<void>();
        gates.beforeCancel = gate;
        yield* app.engine
          .dispatch({ _tag: "delivery.stop", deliveryId: queued.id })
          .pipe(Effect.orDie, Effect.forkChild);
        yield* awaitDelivery(app, member(a).id, (d) => d.withdrawn === "stopped by operator");
        const operator = (yield* threadMessages(a)).runs.find(
          (r) => r.userMessageId === `${a}-turn`,
        )!;
        yield* endRun(a, operator.id, "completed", "operator done");
        yield* startRun(a, queued.runId!);
        yield* awaitDelivery(app, member(a).id, (d) => d.state === "running");
        gates.beforeCancel = null;
        yield* Deferred.succeed(gate, undefined);
        yield* endRun(a, queued.runId!, "completed", "ran anyway");
        const replied = yield* awaitDelivery(app, member(a).id, (d) => d.state === "replied");
        assert.isTrue((yield* app.store.message(replied.replyMessageId!))!.late);
        assert.strictEqual(
          (yield* runOf(a, queued.runId!)).status,
          "completed",
          "the cancel refused a started run",
        );
      }),
  );
});
