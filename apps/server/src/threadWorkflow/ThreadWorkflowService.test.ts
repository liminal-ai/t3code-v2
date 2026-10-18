import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type OrchestrationV2AppThread,
  type ServerSettings as ServerSettingsShape,
  type ThreadWorkflowActor,
  type ThreadWorkflowRequest,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { ThreadHooks } from "../orchestration-v2/ThreadHooks.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadWorkflow from "./layer.ts";
import { threadLogFileName } from "./store.ts";
import { ThreadWorkflowService } from "./ThreadWorkflowService.ts";

const threadId = ThreadId.make("thread-service-test");
const user: ThreadWorkflowActor = { _tag: "user", clientSessionId: "pane-1" };
const agent: ThreadWorkflowActor = { _tag: "agent", threadId };
const start: ThreadWorkflowRequest = { _tag: "start", templateId: "open-ended" as never };

type ThreadLifecycle = Pick<
  OrchestrationV2AppThread,
  "deletedAt" | "archivedAt" | "settledAt" | "settledOverride"
>;
const active: ThreadLifecycle = {
  deletedAt: null,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
};

/** The module over a fresh state dir, with the thread's lifecycle under the test's control. */
/** The test settings layer never emits changes; the subscription test needs the flag flip to arrive. */
const settingsWithChanges = (enabled: boolean) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const current = yield* Ref.make<ServerSettingsShape>({
        ...DEFAULT_SERVER_SETTINGS,
        threadWorkflowsEnabled: enabled,
      });
      const changes = yield* PubSub.unbounded<ServerSettingsShape>();
      return ServerSettings.ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(current),
        updateSettings: (patch) =>
          Ref.updateAndGet(current, (settings) => applyServerSettingsPatch(settings, patch)).pipe(
            Effect.tap((settings) => PubSub.publish(changes, settings)),
          ),
        updateProviderInstance: () => Effect.die("unused"),
        withSettingsSnapshot: (use) => Effect.flatMap(Ref.get(current), use),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        ),
      });
    }),
  );

const makeHarness = (options: { readonly enabled?: boolean; readonly seedLog?: string } = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-workflow-" });
    const threadsDir = path.join(baseDir, "userdata", "thread-workflows", "threads");
    if (options.seedLog !== undefined) {
      yield* fileSystem.makeDirectory(threadsDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(threadsDir, threadLogFileName(threadId)),
        options.seedLog,
      );
    }
    const lifecycle = yield* Ref.make<ThreadLifecycle>(active);
    const layer = ThreadWorkflow.layer.pipe(
      Layer.provideMerge(ThreadCommandExecutor.layer),
      Layer.provideMerge(settingsWithChanges(options.enabled ?? true)),
      Layer.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () =>
            Ref.get(lifecycle).pipe(Effect.map((state) => state as OrchestrationV2AppThread)),
        }),
      ),
      Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
      Layer.provide(NodeServices.layer),
    );
    return { baseDir, threadsDir, lifecycle, layer };
  });

it.layer(NodeServices.layer)("ThreadWorkflowService", (it) => {
  it.effect("starts under the shared thread lock and refuses once the thread settled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          const hooks = yield* ThreadHooks;
          const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;

          const order = yield* Ref.make<ReadonlyArray<string>>([]);
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const holder = yield* executor
            .withLock(
              threadId,
              Deferred.succeed(held, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Ref.update(order, (seen) => [...seen, "lock released"])),
              ),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(held);
          const starting = yield* service.apply(user, threadId, start).pipe(
            Effect.tap(() => Ref.update(order, (seen) => [...seen, "start applied"])),
            Effect.forkChild,
          );
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(holder);
          const started = yield* Fiber.join(starting);
          assert.deepStrictEqual(yield* Ref.get(order), ["lock released", "start applied"]);
          assert.isTrue(started.changed);
          assert.strictEqual(started.view.activeInstanceId, "w1");
          assert.match((yield* hooks.lifecycleBlocker({ threadId, action: "settle" })) ?? "", /w1/);

          yield* service.apply(user, threadId, {
            _tag: "close",
            instanceId: "w1" as never,
            outcome: "abandoned",
            reason: "test",
          });
          yield* Ref.set(harness.lifecycle, { ...active, settledOverride: "settled" });
          const refused = yield* service.apply(user, threadId, start).pipe(Effect.flip);
          assert.strictEqual(refused.code, "thread_not_active");
          assert.isNull(yield* hooks.lifecycleBlocker({ threadId, action: "settle" }));
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("keeps the guard, the note and the close path when the flag is off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          const hooks = yield* ThreadHooks;
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* service.apply(agent, threadId, start);
          yield* settings.updateSettings({ threadWorkflowsEnabled: false });

          const state = yield* service.state(threadId);
          assert.isFalse(state.enabled);
          assert.isTrue(state.visible);
          assert.isNotNull(yield* hooks.lifecycleBlocker({ threadId, action: "archive" }));
          const note = yield* hooks.turnNote({
            threadId,
            runId: "run-1" as never,
            compacting: false,
          });
          assert.match(note, /^<thread-workflow>/);
          assert.strictEqual(
            yield* hooks.turnNote({ threadId, runId: "run-1" as never, compacting: true }),
            "",
          );

          const ticked = yield* service.apply(agent, threadId, {
            _tag: "tick",
            stepId: "w1.1" as never,
            comment: "stated the goal",
          });
          assert.isTrue(ticked.changed);
          const otherThread = ThreadId.make("thread-service-other");
          const refused = yield* service.apply(user, otherThread, start).pipe(Effect.flip);
          assert.strictEqual(refused.code, "disabled");
          const closed = yield* service.apply(user, threadId, {
            _tag: "close",
            instanceId: "w1" as never,
            outcome: "abandoned",
            reason: "flag went off",
          });
          assert.isNull(closed.view.activeInstanceId);
          assert.isNull(yield* hooks.lifecycleBlocker({ threadId, action: "delete" }));
          assert.isFalse((yield* service.state(threadId)).visible);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("keeps a corrupt log read-only and visible without blocking the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ enabled: false, seedLog: "not json\n" });
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          const hooks = yield* ThreadHooks;
          for (const action of ["settle", "archive", "delete"] as const) {
            assert.isNull(yield* hooks.lifecycleBlocker({ threadId, action }));
          }
          assert.match(
            yield* hooks.turnNote({ threadId, runId: "run-1" as never, compacting: false }),
            /cannot be trusted/,
          );
          const pane = yield* service.state(threadId);
          assert.isTrue(pane.visible);
          assert.strictEqual(pane.view.corruption, "line 1 of its log is not JSON");
          const refused = yield* service.apply(agent, threadId, start).pipe(Effect.flip);
          assert.strictEqual(refused.code, "corrupt");
          const agentRecover = yield* service
            .apply(agent, threadId, { _tag: "recover", reason: "agent tries" })
            .pipe(Effect.flip);
          assert.strictEqual(agentRecover.code, "user_only");
          const recovered = yield* service.apply(user, threadId, {
            _tag: "recover",
            reason: "disk hiccup",
          });
          assert.isNull(recovered.view.corruption);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("replays a request id and refuses its reuse for a different request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          const first = yield* service.apply(user, threadId, start, { requestId: "req-1" });
          const again = yield* service.apply(user, threadId, start, { requestId: "req-1" });
          assert.isTrue(first.changed);
          assert.isTrue(again.replayed);
          assert.strictEqual(again.view.revision, first.view.revision);
          const reused = yield* service
            .apply(
              user,
              threadId,
              { _tag: "comment", target: "w1" as never, comment: "x" },
              {
                requestId: "req-1",
              },
            )
            .pipe(Effect.flip);
          assert.strictEqual(reused.code, "request_id_reused");
          const stale = yield* service
            .apply(
              user,
              threadId,
              { _tag: "comment", target: "w1" as never, comment: "x" },
              {
                requestId: "req-2",
                expectedRevision: 0,
              },
            )
            .pipe(Effect.flip);
          assert.strictEqual(stale.code, "revision_conflict");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("streams the view after each durable change and after the flag flips", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          const settings = yield* ServerSettings.ServerSettingsService;
          const states = yield* Queue.unbounded<{ enabled: boolean; revision: number }>();
          yield* service.subscribe(threadId).pipe(
            Stream.runForEach((state) =>
              Queue.offer(states, { enabled: state.enabled, revision: state.view.revision }),
            ),
            Effect.forkScoped,
          );
          assert.deepStrictEqual(yield* Queue.take(states), { enabled: true, revision: 0 });
          yield* service.apply(user, threadId, start);
          assert.deepStrictEqual(yield* Queue.take(states), { enabled: true, revision: 1 });
          yield* settings.updateSettings({ threadWorkflowsEnabled: false });
          assert.deepStrictEqual(yield* Queue.take(states), { enabled: false, revision: 1 });
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("lists the built-in templates with their freshness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          const templates = yield* service.templates;
          assert.deepStrictEqual(templates.map((template) => template.id).toSorted(), [
            "open-ended",
            "orchestrate",
            "single-task",
          ]);
          assert.isTrue(templates.every((template) => template.stepCount > 0));
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("turns itself off when the threads directory exists but cannot be read", () => {
    const errors: Array<unknown> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Error") errors.push(message);
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-thread-workflow-",
        });
        const rootDir = path.join(baseDir, "userdata", "thread-workflows");
        yield* fileSystem.makeDirectory(rootDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(rootDir, "threads"), "a file, not a directory");
        const layer = ThreadWorkflow.layer.pipe(
          Layer.provide(ThreadCommandExecutor.layer),
          Layer.provide(ServerSettings.layerTest({ threadWorkflowsEnabled: true })),
          Layer.provide(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: () => Effect.succeed(active as OrchestrationV2AppThread),
            }),
          ),
          Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          const hooks = yield* ThreadHooks;
          assert.isNull(yield* hooks.lifecycleBlocker({ threadId, action: "settle" }));
          assert.strictEqual(
            yield* hooks.turnNote({ threadId, runId: "run-1" as never, compacting: false }),
            "",
          );
          for (const refused of [
            yield* service.apply(user, threadId, start).pipe(Effect.flip),
            yield* service.view(threadId).pipe(Effect.flip),
          ]) {
            assert.strictEqual(refused.code, "store_unavailable");
          }
          const pane = yield* service.state(threadId);
          assert.match(pane.unavailable ?? "", /could not be loaded/);
          assert.deepStrictEqual(pane.view.instances, []);
        }).pipe(Effect.provide(layer));
        assert.lengthOf(errors, 1);
        assert.match(String(errors[0]), /thread workflow module disabled/);
      }),
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });
});
