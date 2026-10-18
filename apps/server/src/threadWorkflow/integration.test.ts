/**
 * The module on the real orchestration graph (`runtimeLayer.ts`), the largest subgraph of
 * `server.ts` a test can build: orchestrator, thread management, project service, effect worker,
 * projections and the thread lock are the production layers; only the provider adapter, git and
 * workspace services are stubbed. The settlement sweep's pre-filter is covered with a hook mock in
 * ThreadSettlementService.test.ts; here its command, `thread.auto-settle`, meets the real hooks.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ThreadWorkflowActor,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { HOOK_DEADLINE } from "../orchestration-v2/ThreadHooks.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ThreadWorkflow from "./layer.ts";
import { threadLogFileName } from "./store.ts";
import * as IdleReactor from "./ThreadWorkflowIdleReactor.ts";
import { ThreadWorkflowService } from "./ThreadWorkflowService.ts";

const T0 = Date.parse("2026-10-17T12:00:00.000Z");
const HOUR = 60 * 60 * 1_000;
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
    openSession: () => Effect.die("sessions are not used by lifecycle tests"),
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

/** Flipped on, every settings read the module makes signals `reached` and then never answers. */
interface SettingsStall {
  readonly on: Ref.Ref<boolean>;
  readonly reached: Deferred.Deferred<void>;
}

interface ModuleSetup {
  /** Written into the threads directory before the module folds it at layer build. */
  readonly seed?: (
    threadsDir: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>;
  /** The process environment the module reads at build. */
  readonly env?: Record<string, string>;
  /** Stalls the module's settings reads only; core keeps answering. */
  readonly stall?: SettingsStall;
}

const layerStallingSettings = <E, R>(
  stall: SettingsStall,
  layerSettings: Layer.Layer<ServerSettings.ServerSettingsService, E, R>,
) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.map(ServerSettings.ServerSettingsService, (settings) =>
      ServerSettings.ServerSettingsService.of({
        ...settings,
        getSettings: Ref.get(stall.on).pipe(
          Effect.flatMap((on) =>
            on
              ? Deferred.succeed(stall.reached, undefined).pipe(Effect.andThen(Effect.never))
              : settings.getSettings,
          ),
        ),
      }),
    ),
  ).pipe(Layer.provide(layerSettings));

const makeLayerTest = (setup: ModuleSetup = {}) => {
  const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-thread-workflow-integration-",
  });
  const layerSeed = Layer.effectDiscard(
    Effect.gen(function* () {
      if (setup.seed === undefined) return;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      yield* setup.seed(path.join(stateDir, "thread-workflows", "threads"));
    }),
  );
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
  const layerRuntime = RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService));
  const layerModule = ThreadWorkflow.layer.pipe(
    Layer.provide(layerSeed),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: setup.env ?? {} }))),
    Layer.provide(
      setup.stall === undefined ? layerSettings : layerStallingSettings(setup.stall, layerSettings),
    ),
    Layer.provide(ProjectionStore.layer),
    Layer.provide(ThreadCommandExecutor.layer),
  );
  return Layer.mergeAll(
    layerRuntime,
    RuntimeLayer.layerProjectService,
    RuntimeLayer.layerEventSink,
    ThreadCommandExecutor.layer,
    ProjectionStore.layer,
    IdleReactor.layer.pipe(Layer.provide(layerRuntime), Layer.provide(ProjectionStore.layer)),
  ).pipe(
    Layer.provideMerge(layerModule),
    Layer.provide(
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
    ),
    Layer.provide(
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
    ),
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(layerCheckpointStoreTest),
    Layer.provide(layerServerConfig),
    Layer.provideMerge(layerSettings),
    Layer.provide(layerProviderInstances),
    Layer.provide(
      Layer.mock(GitWorkflow.GitWorkflowService)({
        pruneWorktrees: () => Effect.void,
        createWorktree: () => Effect.succeed({} as never),
      }),
    ),
    Layer.provide(layerPlatformTest),
  );
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
      title: "Workflow thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  );

const startWorkflow = (threadId: ThreadId) =>
  Effect.flatMap(ThreadWorkflowService, (service) =>
    service.apply(user, threadId, { _tag: "start", templateId: "open-ended" as never }),
  );

const dispatchError = (error: unknown) => {
  assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
  return (error as Orchestrator.OrchestratorDispatchError).cause as string;
};

const scanAt = (ms: number) =>
  TestClock.setTime(ms).pipe(
    Effect.andThen(
      Effect.flatMap(IdleReactor.ThreadWorkflowIdleReactor, (reactor) => reactor.scan),
    ),
  );

const idlePings = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  ).pipe(
    Effect.map(({ messages }) =>
      messages.filter((message) => message.notification?.source.kind === "system"),
    ),
  );

/** One ping for the first quiet day, unmoved by a rescan or a reactor rebuilt from scratch. */
const firstQuietDay = (name: string) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const projectId = ProjectId.make(`${name}-project`);
    const threadId = ThreadId.make(`${name}-thread`);
    yield* createProject(projectId);
    yield* createThread(threadId, projectId);
    yield* startWorkflow(threadId);

    yield* scanAt(T0 + 23 * HOUR);
    assert.lengthOf(yield* idlePings(threadId), 0);
    yield* scanAt(T0 + 25 * HOUR);
    yield* scanAt(T0 + 26 * HOUR);
    yield* scanAt(T0 + 27 * HOUR).pipe(Effect.provide(Layer.fresh(IdleReactor.layer)));
    const pings = yield* idlePings(threadId);
    assert.lengthOf(pings, 1);
    assert.strictEqual(
      pings[0]?.id,
      IdleReactor.idleCommandId({ threadId, instanceId: "w1", quietSinceMs: T0, quietDays: 1 }),
    );
    assert.match(
      pings[0]?.text ?? "",
      /thread_workflow_close \{"instanceId":"w1","outcome":"abandoned"/,
    );
    return threadId;
  });

/** The test adapter cannot open a session, so the ping's run ends as the provider would report it. */
const finishLatestRun = (
  threadId: ThreadId,
  end: { readonly status: "completed" | "failed"; readonly startedAtMs: number | null },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const { runs } = yield* orchestrator.getThreadProjection(threadId);
    const run = runs.at(-1)!;
    assert.strictEqual(run.status, "starting");
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:${run.id}:${end.status}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            ...run,
            status: end.status,
            startedAt: end.startedAtMs === null ? null : DateTime.makeUnsafe(end.startedAtMs),
            completedAt: now,
          },
        },
      ],
    });
  });

it.layer(makeLayerTest())("thread workflow module on the orchestration graph", (it) => {
  it.effect("refuses every way out of active work while an instance is open", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const projects = yield* ProjectService.ProjectService;
      const projectId = ProjectId.make("workflow-guard-project");
      const threadId = ThreadId.make("workflow-guard-thread");
      yield* createProject(projectId);
      yield* createThread(threadId, projectId);
      yield* startWorkflow(threadId);

      const blocker = /open workflow "Open-ended" \(w1, 3 of 3 steps open\)/;
      const webSettle = yield* threads
        .dispatch({ type: "thread.settle", commandId: id(`${threadId}-settle`), threadId })
        .pipe(Effect.flip);
      assert.match(dispatchError(webSettle), blocker);
      const sweepSettle = yield* orchestrator
        .dispatch({
          type: "thread.auto-settle",
          commandId: id(`${threadId}-auto-settle`),
          threadId,
          snapshotAt: DateTime.makeUnsafe(T0 + HOUR),
        })
        .pipe(Effect.flip);
      assert.match(dispatchError(sweepSettle), blocker);
      const agentSettle = yield* threads
        .settleThread({ threadId, commandId: id(`${threadId}-agent-settle`), byOwnAgent: true })
        .pipe(Effect.flip);
      assert.match(dispatchError(agentSettle), blocker);
      for (const type of ["thread.archive", "thread.delete"] as const) {
        const error = yield* orchestrator
          .dispatch({ type, commandId: id(`${threadId}-${type}`), threadId })
          .pipe(Effect.flip);
        assert.match(dispatchError(error), blocker);
      }
      const projectDelete = yield* projects
        .delete({ commandId: id(`${projectId}-delete`), projectId, force: true })
        .pipe(Effect.flip);
      assert.instanceOf(projectDelete, ProjectService.ProjectThreadsBlockedError);
      assert.match(projectDelete.blockers.join(" "), blocker);

      const thread = (yield* orchestrator.getThreadProjection(threadId)).thread;
      assert.isNull(thread.settledOverride);
      assert.isNull(thread.archivedAt);
      assert.isNull(thread.deletedAt);
      assert.isNull(Option.getOrThrow(yield* projects.getById(projectId)).deletedAt);

      const service = yield* ThreadWorkflowService;
      yield* service.apply(user, threadId, {
        _tag: "close",
        instanceId: "w1" as never,
        outcome: "abandoned",
        reason: "scope changed",
      });
      yield* threads.dispatch({
        type: "thread.settle",
        commandId: id(`${threadId}-settle-after`),
        threadId,
      });
      const deleted = yield* projects.delete({
        commandId: id(`${projectId}-delete-after`),
        projectId,
        force: true,
      });
      assert.isNotNull(deleted.deletedAt);
    }),
  );

  it.effect("serializes a workflow start against a settle on the thread's own lock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const service = yield* ThreadWorkflowService;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectId = ProjectId.make("workflow-race-project");
      const settle = (threadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.settle",
          commandId: id(`${threadId}-settle`),
          threadId,
        });

      const settledFirst = ThreadId.make("workflow-race-settled-first");
      yield* createThread(settledFirst, projectId);
      yield* settle(settledFirst);
      const lateStart = yield* startWorkflow(settledFirst).pipe(Effect.flip);
      assert.strictEqual(lateStart.code, "thread_not_active");

      const startedFirst = ThreadId.make("workflow-race-started-first");
      yield* createThread(startedFirst, projectId);
      yield* startWorkflow(startedFirst);
      assert.match(dispatchError(yield* settle(startedFirst).pipe(Effect.flip)), /open workflow/);

      const contended = ThreadId.make("workflow-race-contended");
      yield* createThread(contended, projectId);
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          contended,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const starting = yield* startWorkflow(contended).pipe(Effect.exit, Effect.forkChild);
      const settling = yield* settle(contended).pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const [started, settled] = [yield* Fiber.join(starting), yield* Fiber.join(settling)];
      const instanceOpen = (yield* service.view(contended)).activeInstanceId !== null;
      const threadSettled =
        (yield* orchestrator.getThreadProjection(contended)).thread.settledOverride === "settled";
      assert.notStrictEqual(instanceOpen, threadSettled, "exactly one of them won");
      assert.strictEqual(Exit.isSuccess(started), instanceOpen);
      assert.strictEqual(Exit.isSuccess(settled), threadSettled);
    }),
  );

  it.effect("pings once for a quiet day, again after a continue comment starts a new one", () =>
    Effect.gen(function* () {
      const threadId = yield* firstQuietDay("workflow-idle-comment");
      yield* finishLatestRun(threadId, { status: "failed", startedAtMs: null });
      yield* TestClock.setTime(T0 + 30 * HOUR);
      const service = yield* ThreadWorkflowService;
      yield* service.apply(user, threadId, {
        _tag: "comment",
        target: "w1" as never,
        comment: "continue, answered by the user",
      });

      yield* scanAt(T0 + 50 * HOUR);
      assert.lengthOf(yield* idlePings(threadId), 1);
      yield* scanAt(T0 + 55 * HOUR);
      const pings = yield* idlePings(threadId);
      assert.deepStrictEqual(
        pings.map((message) => message.id),
        [
          IdleReactor.idleCommandId({ threadId, instanceId: "w1", quietSinceMs: T0, quietDays: 1 }),
          IdleReactor.idleCommandId({
            threadId,
            instanceId: "w1",
            quietSinceMs: T0 + 30 * HOUR,
            quietDays: 1,
          }),
        ],
      );
      assert.match(pings[1]?.text ?? "", /no workflow activity for 1 day,/);
    }),
  );

  it.effect("pings again a quiet day after the ping's own run started", () =>
    Effect.gen(function* () {
      const threadId = yield* firstQuietDay("workflow-idle-run");
      yield* finishLatestRun(threadId, { status: "completed", startedAtMs: T0 + 25 * HOUR });

      yield* scanAt(T0 + 48 * HOUR);
      assert.lengthOf(yield* idlePings(threadId), 1);
      yield* scanAt(T0 + 50 * HOUR);
      const pings = yield* idlePings(threadId);
      assert.lengthOf(pings, 2);
      assert.strictEqual(
        pings[1]?.id,
        IdleReactor.idleCommandId({
          threadId,
          instanceId: "w1",
          quietSinceMs: T0 + 25 * HOUR,
          quietDays: 1,
        }),
      );
    }),
  );
});

const corruptThread = ThreadId.make("workflow-corrupt-thread");

it.layer(
  makeLayerTest({
    seed: (threadsDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(threadsDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(threadsDir, threadLogFileName(corruptThread)),
          "not json\n",
        );
      }),
  }),
)("thread workflow module with a corrupt thread log", (it) => {
  it.effect("lets the corrupt thread settle and still refuses a valid open instance", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const service = yield* ThreadWorkflowService;
      const projectId = ProjectId.make("workflow-corrupt-project");
      const openThread = ThreadId.make("workflow-corrupt-neighbour");
      yield* createProject(projectId);
      yield* createThread(corruptThread, projectId);
      yield* createThread(openThread, projectId);
      yield* startWorkflow(openThread);
      assert.isTrue((yield* service.state(corruptThread)).visible);

      yield* threads.dispatch({
        type: "thread.settle",
        commandId: id(`${corruptThread}-settle`),
        threadId: corruptThread,
      });
      const refused = yield* threads
        .dispatch({
          type: "thread.settle",
          commandId: id(`${openThread}-settle`),
          threadId: openThread,
        })
        .pipe(Effect.flip);
      assert.match(dispatchError(refused), /open workflow "Open-ended" \(w1/);

      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const settled = (yield* orchestrator.getThreadProjection(corruptThread)).thread;
      assert.strictEqual(settled.settledOverride, "settled");
      assert.strictEqual(
        (yield* service.view(corruptThread)).corruption,
        "line 1 of its log is not JSON",
      );
    }),
  );
});

it.layer(
  makeLayerTest({
    seed: (threadsDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.dirname(threadsDir), { recursive: true });
        yield* fileSystem.writeFileString(threadsDir, "a file, not a directory");
      }),
  }),
)("thread workflow module with an unreadable threads directory", (it) => {
  it.effect("builds, stays out of the way, and answers store_unavailable", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("workflow-unreadable-project");
      const threadId = ThreadId.make("workflow-unreadable-thread");
      yield* createProject(projectId);
      yield* createThread(threadId, projectId);

      const refused = yield* startWorkflow(threadId).pipe(Effect.flip);
      assert.strictEqual(refused.code, "store_unavailable");
      yield* threads.dispatch({
        type: "thread.settle",
        commandId: id(`${threadId}-settle`),
        threadId,
      });
      const settled = (yield* orchestrator.getThreadProjection(threadId)).thread;
      assert.strictEqual(settled.settledOverride, "settled");
    }),
  );
});

/** Settle, archive and delete, each on its own thread with an open workflow, as the user would. */
const leaveActiveWork = (name: string) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projectId = ProjectId.make(`${name}-project`);
    yield* createProject(projectId);
    return yield* Effect.forEach(
      ["thread.settle", "thread.archive", "thread.delete"] as const,
      (type) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`${name}-${type}`);
          yield* createThread(threadId, projectId);
          yield* startWorkflow(threadId);
          return yield* threads
            .dispatch({ type, commandId: id(`${threadId}-${type}`), threadId })
            .pipe(Effect.exit);
        }),
    );
  });

it.layer(makeLayerTest())("thread workflow enforcement bypass by setting", (it) => {
  it.effect("refuses with the setting off and allows every way out once it is on", () =>
    Effect.gen(function* () {
      for (const exit of yield* leaveActiveWork("workflow-bypass-off")) {
        assert.isTrue(Exit.isFailure(exit));
        assert.match(String(exit), /open workflow/);
      }
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ threadWorkflowEnforcementDisabled: true });
      for (const exit of yield* leaveActiveWork("workflow-bypass-on")) {
        assert.isTrue(Exit.isSuccess(exit));
      }
    }),
  );
});

it.layer(makeLayerTest({ env: { T3CODE_THREAD_WORKFLOW_ENFORCEMENT: "off" } }))(
  "thread workflow enforcement bypass by environment",
  (it) => {
    it.effect("allows every way out with the setting still off", () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        assert.isFalse((yield* settings.getSettings).threadWorkflowEnforcementDisabled);
        for (const exit of yield* leaveActiveWork("workflow-bypass-env")) {
          assert.isTrue(Exit.isSuccess(exit));
        }
      }),
    );
  },
);

const settingsStall: SettingsStall = { on: Ref.makeUnsafe(false), reached: Deferred.makeUnsafe() };

it.layer(makeLayerTest({ stall: settingsStall }))(
  "thread workflow module whose settings reads stall",
  (it) => {
    it.effect("lets a settle through once the hook deadline passes", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectId = ProjectId.make("workflow-stall-project");
        const threadId = ThreadId.make("workflow-stall-thread");
        yield* createProject(projectId);
        yield* createThread(threadId, projectId);
        yield* startWorkflow(threadId);

        yield* Ref.set(settingsStall.on, true);
        const answered = yield* Ref.make(false);
        const settling = yield* threads
          .dispatch({ type: "thread.settle", commandId: id(`${threadId}-settle`), threadId })
          .pipe(
            Effect.exit,
            Effect.tap(() => Ref.set(answered, true)),
            Effect.forkChild,
          );
        yield* Deferred.await(settingsStall.reached);
        assert.isFalse(yield* Ref.get(answered));
        yield* TestClock.adjust(HOOK_DEADLINE);
        const settled = yield* Fiber.join(settling);
        assert.isTrue(Exit.isSuccess(settled), String(settled));
        assert.strictEqual(
          (yield* orchestrator.getThreadProjection(threadId)).thread.settledOverride,
          "settled",
        );
      }),
    );
  },
);
