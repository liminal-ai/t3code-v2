import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2EngineBinding,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  engineContinuationKey,
  type ProviderEngineBindingTemplate,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { runOrchestratorV2Scenario } from "./testkit/OrchestratorScenario.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const DRIVER = ProviderDriverKind.make("claudeAgent");
const LHC = ProviderInstanceId.make("claude-lhc-a");
const STOCK = ProviderInstanceId.make("claude-stock");
const LHC_OTHER = ProviderInstanceId.make("claude-lhc-b");
const projectId = ProjectId.make("project:engine-binding");

const HOME = "/home/test/.claude-lhc";
const COMPACT = { trigger: 700_000, target: 140_000 };

const lhcTemplate = (
  claudeHome = HOME,
  compact: ProviderEngineBindingTemplate["compact"] = COMPACT,
): ProviderEngineBindingTemplate => ({
  engine: "claude-lhc",
  continuationKey: engineContinuationKey({ engine: "claude-lhc", claudeHome }),
  claudeHome,
  compact,
  nativeContinuation: "required",
  compaction: "provider",
});

const bound = (
  providerInstanceId: ProviderInstanceId,
  template: ProviderEngineBindingTemplate,
): OrchestrationV2EngineBinding => ({ ...template, providerInstanceId });

const selection = (
  instanceId: ProviderInstanceId,
  model = "claude-sonnet-4-6",
): ModelSelection => ({
  instanceId,
  model,
});

interface HeldTurn {
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

interface Instances {
  readonly templates: Ref.Ref<
    ReadonlyMap<ProviderInstanceId, ProviderEngineBindingTemplate | null>
  >;
  readonly holdNextTurn: Ref.Ref<HeldTurn | null>;
}

const makeInstances = (
  initial: ReadonlyArray<readonly [ProviderInstanceId, ProviderEngineBindingTemplate | null]>,
) =>
  Effect.gen(function* () {
    return {
      templates: yield* Ref.make<
        ReadonlyMap<ProviderInstanceId, ProviderEngineBindingTemplate | null>
      >(new Map(initial)),
      holdNextTurn: yield* Ref.make<HeldTurn | null>(null),
    } satisfies Instances;
  });

const setTemplate = (
  instances: Instances,
  instanceId: ProviderInstanceId,
  template: ProviderEngineBindingTemplate | null,
) => Ref.update(instances.templates, (current) => new Map(current).set(instanceId, template));

const deleteInstance = (instances: Instances, instanceId: ProviderInstanceId) =>
  Ref.update(instances.templates, (current) => {
    const next = new Map(current);
    next.delete(instanceId);
    return next;
  });

const unimplemented = (detail: string) =>
  Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver: DRIVER, detail }));

// Writes the instance's binding into each new row, as the Claude adapter's ensureThread will.
const makeAdapter = (
  instances: Instances,
  instanceId: ProviderInstanceId,
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId,
  driver: DRIVER,
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (sessionInput) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const rowCount = yield* Ref.make(0);
      const now = yield* DateTime.now;
      const providerSession: OrchestrationV2ProviderSession = {
        id: sessionInput.providerSessionId,
        driver: DRIVER,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
        model: sessionInput.modelSelection.model,
        capabilities: ClaudeProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId,
        driver: DRIVER,
        providerSessionId: sessionInput.providerSessionId,
        providerSession,
        events: Stream.fromPubSub(events),
        ensureThread: (threadInput) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            const ordinal = yield* Ref.updateAndGet(rowCount, (count) => count + 1);
            const nativeId = `${instanceId}:${sessionInput.providerSessionId}:${ordinal}`;
            const template = (yield* Ref.get(instances.templates)).get(instanceId) ?? null;
            return {
              id: ProviderThreadId.make(`provider-thread:${nativeId}`),
              driver: DRIVER,
              providerInstanceId: instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver: DRIVER, nativeId, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              contextUsage: null,
              forkedFrom: null,
              nativeMetadata:
                template === null ? null : { engineBinding: bound(instanceId, template) },
              createdAt,
              updatedAt: createdAt,
            } satisfies OrchestrationV2ProviderThread;
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            const hold = yield* Ref.getAndSet(instances.holdNextTurn, null);
            if (hold !== null) {
              yield* Deferred.succeed(hold.started, undefined);
              yield* Deferred.await(hold.release);
            }
            const eventTime = yield* DateTime.now;
            const key = `${turnInput.threadId}:${turnInput.runOrdinal}`;
            const providerTurnId = ProviderTurnId.make(`provider-turn:${key}`);
            const providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
              {
                type: "provider_turn.updated",
                driver: DRIVER,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turnInput.providerThread.id,
                  nodeId: turnInput.rootNodeId,
                  runAttemptId: turnInput.attemptId,
                  nativeTurnRef: {
                    driver: DRIVER,
                    nativeId: `native-turn:${key}`,
                    strength: "strong",
                  },
                  ordinal: turnInput.runOrdinal,
                  status: "completed",
                  startedAt: eventTime,
                  completedAt: eventTime,
                },
              },
              {
                type: "turn_item.updated",
                driver: DRIVER,
                turnItem: {
                  id: TurnItemId.make(`turn-item:${key}:assistant`),
                  threadId: turnInput.threadId,
                  runId: turnInput.runId,
                  nodeId: turnInput.rootNodeId,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: turnInput.runOrdinal * 100 + 1,
                  status: "completed",
                  title: null,
                  startedAt: eventTime,
                  completedAt: eventTime,
                  updatedAt: eventTime,
                  type: "assistant_message",
                  messageId: MessageId.make(`message:${key}:assistant`),
                  text: `Reply to run ${turnInput.runOrdinal}`,
                  streaming: false,
                },
              },
              {
                type: "turn.terminal",
                driver: DRIVER,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                runOrdinal: turnInput.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              },
            ];
            for (const event of providerEvents) yield* PubSub.publish(events, event);
          }),
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => unimplemented("readThreadSnapshot is unused"),
        rollbackThread: () => unimplemented("rollbackThread is unused"),
        forkThread: () => unimplemented("forkThread is unused"),
      };
      return runtime;
    }),
});

// The real registry reads each live instance's template, so its boundary check runs too.
const layerRegistry = (instances: Instances, failMetadata: Ref.Ref<boolean>) => {
  const adapters = new Map(
    [LHC, STOCK, LHC_OTHER].map((id) => [id, makeAdapter(instances, id)] as const),
  );
  const instanceFor = (
    instanceId: ProviderInstanceId,
    template: ProviderEngineBindingTemplate | null,
  ) =>
    ({
      instanceId,
      driverKind: DRIVER,
      continuationIdentity: {
        driverKind: DRIVER,
        continuationKey: template?.continuationKey ?? `claude:instance:${instanceId}`,
      },
      ...(template === null ? {} : { engineBinding: template }),
      displayName: String(instanceId),
      enabled: true,
      snapshot: {} as ProviderInstance["snapshot"],
      orchestrationAdapter: {
        ...adapters.get(instanceId)!,
        getCapabilities: () =>
          Ref.get(failMetadata).pipe(
            Effect.flatMap((fail) =>
              fail
                ? unimplemented("capabilities are unavailable")
                : Effect.succeed(ClaudeProviderCapabilitiesV2),
            ),
          ),
      },
      textGeneration: {} as ProviderInstance["textGeneration"],
    }) satisfies ProviderInstance;
  const live = Ref.get(instances.templates).pipe(
    Effect.map((templates) =>
      Array.from(templates, ([instanceId, template]) => instanceFor(instanceId, template)),
    ),
  );
  return ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) =>
          live.pipe(
            Effect.map((all) => all.find((instance) => instance.instanceId === instanceId)),
          ),
        listInstances: live,
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
  );
};

interface Runtime {
  readonly cwd: string;
  readonly dbPath: string;
  readonly instances: Instances;
  readonly failMetadata: Ref.Ref<boolean>;
}

const makeRuntime = (
  name: string,
  initial: ReadonlyArray<readonly [ProviderInstanceId, ProviderEngineBindingTemplate | null]>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* checkpointWorkspace(`engine-binding-${name}`);
    const dir = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ prefix: "t3-engine-binding-" }),
      (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
    );
    return {
      cwd,
      dbPath: path.join(dir, "state.sqlite"),
      instances: yield* makeInstances(initial),
      failMetadata: yield* Ref.make(false),
    } satisfies Runtime;
  });

// Each call is a fresh orchestrator runtime over the same database file, as after a restart.
const layerRuntime = (runtime: Runtime) => {
  const layerDatabase = SqlitePersistence.layerFromPath(runtime.dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const layerStores = Layer.mergeAll(
    layerDatabase,
    EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
    ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  );
  return Layer.mergeAll(
    ProjectionMaintenance.layer.pipe(Layer.provide(layerStores)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "engine-binding", runtimePolicyOverride: { cwd: runtime.cwd } },
      layerRegistry(runtime.instances, runtime.failMetadata),
      { databaseLayer: layerDatabase },
    ),
  );
};

// Each send waits for its thread to go idle, so no turn outlives the runtime that started it.
const run = (runtime: Runtime, commands: ReadonlyArray<OrchestrationV2Command>) =>
  runOrchestratorV2Scenario({
    name: "engine-binding",
    commands,
    steps: commands.flatMap((command) => [
      { type: "dispatch" as const, command, await: true },
      ...(command.type === "message.dispatch"
        ? [{ type: "await_thread_idle" as const, threadId: command.threadId }]
        : []),
    ]),
  }).pipe(Effect.provide(layerRuntime(runtime)));

/** Restarts the runtime, rebuilds every projection from the stored events, and reads them. */
const reload = (runtime: Runtime, threadIds: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const shells = (yield* orchestrator.getShellSnapshot()).threads;
    return yield* Effect.forEach(threadIds, (threadId) =>
      Effect.gen(function* () {
        const latest = yield* orchestrator.getThreadEventSequence(threadId);
        return {
          projection: yield* orchestrator.getThreadProjection(threadId),
          shell: shells.find((shell) => shell.id === threadId),
          storedEvents: Array.from(
            yield* Stream.runCollect(
              orchestrator
                .streamStoredEventsFrom({ threadId })
                .pipe(Stream.takeUntil((stored) => stored.sequence >= latest)),
            ),
          ),
        };
      }),
    );
  }).pipe(Effect.provide(layerRuntime(runtime)));

const create = (threadId: ThreadId, instanceId: ProviderInstanceId, cwd: string) =>
  ({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:${threadId}:create`),
    threadId,
    projectId,
    title: "Engine binding",
    modelSelection: selection(instanceId),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
  }) satisfies OrchestrationV2Command;

const send = (
  threadId: ThreadId,
  label: string,
  modelSelection: ModelSelection,
  dispatchMode: "start_immediately" | "queue_after_active" = "start_immediately",
) =>
  ({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:${threadId}:${label}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}:${label}`),
    text: `Prompt ${label}`,
    attachments: [],
    modelSelection,
    dispatchMode: { type: dispatchMode },
  }) satisfies OrchestrationV2Command;

const setSelection = (threadId: ThreadId, label: string, modelSelection: ModelSelection) =>
  ({
    type: "thread.model-selection.set",
    commandId: CommandId.make(`command:${threadId}:${label}`),
    threadId,
    modelSelection,
  }) satisfies OrchestrationV2Command;

const fork = (sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
  ({
    type: "thread.fork",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:${targetThreadId}:fork`),
    sourceThreadId,
    targetThreadId,
    sourcePoint: { type: "latest_stable" },
  }) satisfies OrchestrationV2Command;

const rowOf = (projection: OrchestrationV2ThreadProjection, runOrdinal: number) => {
  const providerThreadId = projection.runs.find(
    (run) => run.ordinal === runOrdinal,
  )?.providerThreadId;
  return projection.providerThreads.find((row) => row.id === providerThreadId);
};

const awaitIdle = (threadId: ThreadId) =>
  runOrchestratorV2Scenario({
    name: "engine-binding:idle",
    commands: [],
    steps: [{ type: "await_thread_idle", threadId }],
    projectionThreadIds: [threadId],
  });

describe("engine binding seed", () => {
  it.live("seeds a new thread from its instance's template and keeps it across a reload", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime("new-thread", [[LHC, lhcTemplate()]]);
      const threadId = ThreadId.make("thread:engine-binding:new");
      const result = yield* run(runtime, [create(threadId, LHC, runtime.cwd)]);
      assert.deepEqual(
        result.projections.get(threadId)?.thread.engineBinding,
        bound(LHC, lhcTemplate()),
      );
      const [reloaded] = yield* reload(runtime, [threadId]);
      assert.deepEqual(reloaded?.projection.thread.engineBinding, bound(LHC, lhcTemplate()));
      assert.deepEqual(reloaded?.shell?.engineBinding, bound(LHC, lhcTemplate()));
      assert.lengthOf(reloaded!.projection.providerThreads, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("gives a fork made before its first send the source's seed, not the template's", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime("lazy-fork", [[LHC, lhcTemplate()]]);
      const sourceId = ThreadId.make("thread:engine-binding:fork-source");
      const forkId = ThreadId.make("thread:engine-binding:fork-target");
      yield* run(runtime, [
        create(sourceId, LHC, runtime.cwd),
        send(sourceId, "first", selection(LHC)),
      ]);
      yield* setTemplate(
        runtime.instances,
        LHC,
        lhcTemplate(HOME, { trigger: 500_000, target: 100_000 }),
      );
      yield* run(runtime, [fork(sourceId, forkId)]);
      const [source, target] = yield* reload(runtime, [sourceId, forkId]);
      assert.deepEqual(source?.projection.thread.engineBinding, bound(LHC, lhcTemplate()));
      assert.deepEqual(target?.projection.thread.engineBinding, bound(LHC, lhcTemplate()));
      assert.deepEqual(target?.shell?.engineBinding, bound(LHC, lhcTemplate()));
      assert.lengthOf(target!.projection.providerThreads, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leaves existing threads alone when the template changes after creation", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime("template-change", [[LHC, lhcTemplate()]]);
      const threadId = ThreadId.make("thread:engine-binding:template-change");
      yield* run(runtime, [create(threadId, LHC, runtime.cwd)]);
      yield* setTemplate(runtime.instances, LHC, lhcTemplate("/home/test/.claude-other"));
      yield* run(runtime, [setSelection(threadId, "model", selection(LHC, "claude-opus-4-8"))]);
      const [reloaded] = yield* reload(runtime, [threadId]);
      assert.equal(reloaded?.projection.thread.modelSelection.model, "claude-opus-4-8");
      assert.deepEqual(reloaded?.projection.thread.engineBinding, bound(LHC, lhcTemplate()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the seed when the thread's instance is deleted before its first send", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime("deleted-instance", [[LHC, lhcTemplate()]]);
      const threadId = ThreadId.make("thread:engine-binding:deleted");
      yield* run(runtime, [create(threadId, LHC, runtime.cwd)]);
      yield* deleteInstance(runtime.instances, LHC);
      const [reloaded] = yield* reload(runtime, [threadId]);
      assert.deepEqual(reloaded?.projection.thread.engineBinding, bound(LHC, lhcTemplate()));
      assert.deepEqual(reloaded?.shell?.engineBinding, bound(LHC, lhcTemplate()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "clears the seed on a switch to stock and stamps it on a switch to a templated instance",
    () =>
      Effect.gen(function* () {
        const other = lhcTemplate("/home/test/.claude-b");
        const runtime = yield* makeRuntime("switch", [
          [LHC, lhcTemplate()],
          [STOCK, null],
          [LHC_OTHER, other],
        ]);
        const threadId = ThreadId.make("thread:engine-binding:switch");
        const toStock = yield* run(runtime, [
          create(threadId, LHC, runtime.cwd),
          setSelection(threadId, "to-stock", selection(STOCK)),
        ]);
        assert.isUndefined(toStock.projections.get(threadId)?.thread.engineBinding);
        assert.notProperty(toStock.projections.get(threadId)?.thread, "engineBinding");
        const [afterStock] = yield* reload(runtime, [threadId]);
        assert.notProperty(afterStock?.projection.thread, "engineBinding");
        assert.notProperty(afterStock?.shell, "engineBinding");

        yield* run(runtime, [setSelection(threadId, "to-lhc-b", selection(LHC_OTHER))]);
        const [afterLhc] = yield* reload(runtime, [threadId]);
        assert.deepEqual(afterLhc?.projection.thread.engineBinding, bound(LHC_OTHER, other));

        yield* run(runtime, [setSelection(threadId, "to-lhc-a", selection(LHC))]);
        const [back] = yield* reload(runtime, [threadId]);
        assert.deepEqual(back?.projection.thread.engineBinding, bound(LHC, lhcTemplate()));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the seed on a model change within the instance", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime("model-change", [[LHC, lhcTemplate()]]);
      const threadId = ThreadId.make("thread:engine-binding:model");
      yield* run(runtime, [
        create(threadId, LHC, runtime.cwd),
        setSelection(threadId, "model", selection(LHC, "claude-opus-4-8")),
      ]);
      const [reloaded] = yield* reload(runtime, [threadId]);
      assert.deepEqual(
        reloaded?.storedEvents.map((stored) => stored.event.type),
        ["thread.created", "thread.model-selection-updated"],
      );
      assert.deepEqual(reloaded?.projection.thread.engineBinding, bound(LHC, lhcTemplate()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("creates the thread with no seed when the instance's metadata fails", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime("metadata-fails", [[LHC, lhcTemplate()]]);
      const threadId = ThreadId.make("thread:engine-binding:metadata-fails");
      yield* Ref.set(runtime.failMetadata, true);
      yield* run(runtime, [create(threadId, LHC, runtime.cwd)]);
      yield* Ref.set(runtime.failMetadata, false);
      const [reloaded] = yield* reload(runtime, [threadId]);
      assert.equal(reloaded?.projection.thread.providerInstanceId, LHC);
      assert.notProperty(reloaded?.projection.thread, "engineBinding");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each([
    ["home is relative", lhcTemplate("home/test/.claude-lhc")],
    ["home has a trailing slash", lhcTemplate(`${HOME}/`)],
    ["home has dot segments", lhcTemplate("/home/test/../test/.claude-lhc")],
    ["key names another home", { ...lhcTemplate(), continuationKey: "claude-lhc:home:/elsewhere" }],
  ] as const)("never seeds a binding from a template whose %s", ([, template]) =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime("canonical", [[LHC, template]]);
      const threadId = ThreadId.make("thread:engine-binding:canonical");
      yield* run(runtime, [create(threadId, LHC, runtime.cwd)]);
      const [reloaded] = yield* reload(runtime, [threadId]);
      assert.notProperty(reloaded?.projection.thread, "engineBinding");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each([
    ["to stock", LHC, STOCK, undefined],
    ["to a templated instance", STOCK, LHC, bound(LHC, lhcTemplate())],
  ] as const)("stamps a queued switch %s exactly as a direct switch", ([, from, to, expected]) =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime("queued", [
        [LHC, lhcTemplate()],
        [STOCK, null],
      ]);
      const threadId = ThreadId.make("thread:engine-binding:queued");
      const held: HeldTurn = {
        started: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      yield* run(runtime, [create(threadId, from, runtime.cwd)]);
      yield* Ref.set(runtime.instances.holdNextTurn, held);
      const queued = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(send(threadId, "first", selection(from)));
        yield* Deferred.await(held.started);
        yield* orchestrator.dispatch(send(threadId, "queued", selection(to), "queue_after_active"));
        const before = yield* orchestrator.getThreadProjection(threadId);
        yield* Deferred.succeed(held.release, undefined);
        yield* awaitIdle(threadId);
        return before;
      }).pipe(Effect.provide(layerRuntime(runtime)));
      assert.deepEqual(
        queued.runs.map((run) => run.status),
        ["running", "queued"],
      );
      assert.equal(queued.thread.providerInstanceId, from);
      const [reloaded] = yield* reload(runtime, [threadId]);
      const switched = reloaded!.storedEvents.filter(
        (stored) => stored.event.type === "thread.provider-switched",
      );
      assert.lengthOf(switched, 1);
      assert.isNull(switched[0]?.commandId);
      assert.deepEqual(
        reloaded?.projection.runs.map((run) => [run.providerInstanceId, run.status]),
        [
          [from, "completed"],
          [to, "completed"],
        ],
      );
      assert.equal(reloaded?.projection.thread.providerInstanceId, to);
      assert.deepEqual(reloaded?.projection.thread.engineBinding, expected);
      assert.deepEqual(reloaded?.shell?.engineBinding, expected);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const RETURN_CASES = [
  ["flipped from LHC to stock", lhcTemplate(), null, "new"],
  ["flipped from stock to LHC", null, lhcTemplate(), "new"],
  ["changed its Claude home", lhcTemplate(), lhcTemplate("/home/test/.claude-moved"), "new"],
  [
    "changed only its compact pair",
    lhcTemplate(),
    lhcTemplate(HOME, { trigger: 400_000, target: 80_000 }),
    "reused",
  ],
] as const;

const assertReturnedRow = (
  projection: OrchestrationV2ThreadProjection,
  before: ProviderEngineBindingTemplate | null,
  after: ProviderEngineBindingTemplate | null,
  expectedRow: "new" | "reused",
) => {
  const runs = projection.runs.toSorted((left, right) => left.ordinal - right.ordinal);
  assert.isTrue(runs.every((run) => run.status === "completed"));
  assert.equal(runs.at(-1)?.providerInstanceId, LHC);
  const first = rowOf(projection, runs[0]!.ordinal)!;
  const returned = rowOf(projection, runs.at(-1)!.ordinal)!;
  assert.equal(first.providerInstanceId, LHC);
  assert.equal(returned.providerInstanceId, LHC);
  assert.deepEqual(
    first.nativeMetadata?.engineBinding,
    before === null ? undefined : bound(LHC, before),
  );
  if (expectedRow === "reused") {
    assert.equal(returned.id, first.id);
  } else {
    assert.notEqual(returned.id, first.id);
    assert.deepEqual(
      returned.nativeMetadata?.engineBinding,
      after === null ? undefined : bound(LHC, after),
    );
  }
};

describe("returning to an instance", () => {
  // A row is resumed only while its binding agrees with the instance's current template.
  it.live.each(RETURN_CASES)("after the instance %s", ([, before, after, expectedRow]) =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime("return", [
        [LHC, before],
        [STOCK, null],
      ]);
      const threadId = ThreadId.make("thread:engine-binding:return");
      yield* run(runtime, [
        create(threadId, LHC, runtime.cwd),
        send(threadId, "on-a", selection(LHC)),
        send(threadId, "on-b", selection(STOCK)),
      ]);
      yield* setTemplate(runtime.instances, LHC, after);
      yield* run(runtime, [send(threadId, "back-on-a", selection(LHC))]);
      const [reloaded] = yield* reload(runtime, [threadId]);
      assert.lengthOf(reloaded!.projection.runs, 3);
      assertReturnedRow(reloaded!.projection, before, after, expectedRow);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // The queued message picks its row at enqueue, so promotion must check it again.
  it.live.each(RETURN_CASES)(
    "through a queued message after the instance %s while it waited",
    ([, before, after, expectedRow]) =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime("queued-return", [
          [LHC, before],
          [STOCK, null],
        ]);
        const threadId = ThreadId.make("thread:engine-binding:queued-return");
        yield* run(runtime, [
          create(threadId, LHC, runtime.cwd),
          send(threadId, "on-a", selection(LHC)),
          send(threadId, "on-b", selection(STOCK)),
        ]);
        const held: HeldTurn = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        yield* Ref.set(runtime.instances.holdNextTurn, held);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(send(threadId, "again-on-b", selection(STOCK)));
          yield* Deferred.await(held.started);
          yield* orchestrator.dispatch(
            send(threadId, "back-on-a", selection(LHC), "queue_after_active"),
          );
          yield* setTemplate(runtime.instances, LHC, after);
          yield* Deferred.succeed(held.release, undefined);
          yield* awaitIdle(threadId);
        }).pipe(Effect.provide(layerRuntime(runtime)));
        const [reloaded] = yield* reload(runtime, [threadId]);
        assert.lengthOf(reloaded!.projection.runs, 4);
        assertReturnedRow(reloaded!.projection, before, after, expectedRow);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
