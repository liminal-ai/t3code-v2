import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
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
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { ThreadHooks, type TurnNoteInput } from "../orchestration-v2/ThreadHooks.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadWorkflow from "./layer.ts";
import { threadLogFileName } from "./store.ts";
import { given, started } from "./testkit.ts";
import { ThreadWorkflowService } from "./ThreadWorkflowService.ts";

const noteInput = (compacting: boolean): TurnNoteInput => ({
  threadId,
  runId: "run-1" as never,
  compacting,
  context: {
    providerThreadId: "provider-thread-1" as never,
    nativeThreadId: null,
    model: "codex/gpt-5.4",
    compactions: 0,
  },
  completedRunIds: new Set(),
  message: { role: "user", text: "Continue" },
});

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

/** Flipped on, every settings read signals `reached` and then never answers. */
interface SettingsStall {
  readonly on: Ref.Ref<boolean>;
  readonly reached: Deferred.Deferred<void>;
}

/** The test settings layer never emits changes; the subscription test needs the flag flip to arrive. */
const settingsWithChanges = (enabled: boolean, stall?: SettingsStall) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const current = yield* Ref.make<ServerSettingsShape>({
        ...DEFAULT_SERVER_SETTINGS,
        threadWorkflowsEnabled: enabled,
      });
      const changes = yield* PubSub.unbounded<ServerSettingsShape>();
      const stalled =
        stall === undefined
          ? Effect.succeed(false)
          : Ref.get(stall.on).pipe(
              Effect.tap((on) => (on ? Deferred.succeed(stall.reached, undefined) : Effect.void)),
            );
      return ServerSettings.ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.flatMap(stalled, (on) => (on ? Effect.never : Ref.get(current))),
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

/** The module over a fresh state dir, with the thread's lifecycle under the test's control. */
const makeHarness = (
  options: {
    readonly enabled?: boolean;
    readonly seedLog?: string;
    readonly stall?: SettingsStall;
    /** The module's view of the disk, over the real one. */
    readonly fileSystem?: (real: FileSystem.FileSystem) => FileSystem.FileSystem;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-workflow-" });
    const threadsDir = path.join(baseDir, "userdata", "thread-workflows", "threads");
    const logFile = path.join(threadsDir, threadLogFileName(threadId));
    if (options.seedLog !== undefined) {
      yield* fileSystem.makeDirectory(threadsDir, { recursive: true });
      yield* fileSystem.writeFileString(logFile, options.seedLog);
    }
    const lifecycle = yield* Ref.make<ThreadLifecycle>(active);
    const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const answerReactor = ThreadWorkflow.layerAnswerReactorStart.pipe(
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Queue.offer(dispatched, command).pipe(
              Effect.as({ sequence: 1, replayed: false } as never),
            ),
        }),
      ),
      Layer.provide(ThreadWorkflow.layer),
    );
    const layer = Layer.merge(ThreadWorkflow.layer, answerReactor).pipe(
      Layer.provideMerge(ThreadCommandExecutor.layer),
      Layer.provideMerge(settingsWithChanges(options.enabled ?? true, options.stall)),
      Layer.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () =>
            Ref.get(lifecycle).pipe(Effect.map((state) => state as OrchestrationV2AppThread)),
        }),
      ),
      Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
      Layer.provide(
        Layer.effect(
          FileSystem.FileSystem,
          Effect.map(FileSystem.FileSystem, options.fileSystem ?? ((real) => real)),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    return { baseDir, threadsDir, logFile, lifecycle, dispatched, layer };
  });

const askQuestion: ThreadWorkflowRequest = {
  _tag: "ask",
  title: "Merge without a second review?",
  summary: "Yes (recommended) · No",
};

const makeStall = Effect.gen(function* () {
  const stall: SettingsStall = {
    on: yield* Ref.make(false),
    reached: yield* Deferred.make<void>(),
  };
  return stall;
});

const duplicateStart = given(started).records.flatMap((record) => [record, { ...record, seq: 2 }]);

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
          const note = yield* hooks.turnNote(noteInput(false));
          assert.match(note, /^<thread-workflow>/);
          assert.strictEqual(yield* hooks.turnNote(noteInput(true)), "");

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
          assert.match(yield* hooks.turnNote(noteInput(false)), /cannot be trusted/);
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

  it.effect("replays an unanchored insert after a reload as acting on the instance it hit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const close = (instanceId: string): ThreadWorkflowRequest => ({
          _tag: "close",
          instanceId: instanceId as never,
          outcome: "abandoned",
          reason: "test",
        });
        const insert: ThreadWorkflowRequest = {
          _tag: "insert",
          step: {
            title: "Extra",
            instructions: "Do more.",
            proofLevel: "none",
            waitsForUser: false,
          },
          reason: "found more work",
        } as never;
        const first = yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          yield* service.apply(user, threadId, start);
          yield* service.apply(user, threadId, close("w1"));
          yield* service.apply(user, threadId, start);
          yield* service.apply(user, threadId, close("w2"));
          yield* service.apply(user, threadId, {
            _tag: "reopen",
            target: "w1" as never,
            reason: "test",
          } as never);
          return yield* service.apply(agent, threadId, insert, { requestId: "insert-1" });
        }).pipe(Effect.provide(harness.layer));
        assert.strictEqual(first.instanceId, "w1");

        const retried = yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          return yield* service.apply(agent, threadId, insert, { requestId: "insert-1" });
        }).pipe(Effect.provide(harness.layer));
        assert.isTrue(retried.replayed);
        assert.strictEqual(retried.view.revision, first.view.revision);
        assert.strictEqual(retried.instanceId, "w1");
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

  it.effect("posts a pane answer into the thread once, and never a chat answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          yield* service.apply(agent, threadId, start);
          yield* service.apply(agent, threadId, askQuestion);
          yield* service.apply(agent, threadId, {
            ...askQuestion,
            title: "Ship to staging first?",
          });

          const answered = yield* service.apply(
            user,
            threadId,
            { _tag: "answer", questionId: "w1.q1" as never, answer: "Yes, merge it" },
            { requestId: "pane-answer-1", expectedRevision: 3 },
          );
          assert.isTrue(answered.changed);
          const command = yield* Queue.take(harness.dispatched);
          assert.strictEqual(command.type, "message.dispatch");
          if (command.type !== "message.dispatch") return;
          assert.strictEqual(command.threadId, threadId);
          assert.strictEqual(
            command.text,
            'Answer to workflow question w1.q1, "Merge without a second review?":\nYes, merge it',
          );
          assert.strictEqual(command.createdBy, "user");
          assert.strictEqual(command.creationSource, "web");
          assert.deepStrictEqual(command.dispatchMode, { type: "queue_after_active" });
          assert.strictEqual<string>(command.commandId, command.messageId);
          assert.strictEqual(
            command.commandId,
            `server:thread-workflow-answer:${threadId}:w1.q1:${answered.view.revision}`,
          );

          const replayed = yield* service.apply(
            user,
            threadId,
            { _tag: "answer", questionId: "w1.q1" as never, answer: "Yes, merge it" },
            { requestId: "pane-answer-1", expectedRevision: 3 },
          );
          assert.isTrue(replayed.replayed);
          const fromChat = yield* service.apply(agent, threadId, {
            _tag: "answer",
            questionId: "w1.q2" as never,
            answer: "No, straight to prod",
            source: "chat",
          });
          assert.isTrue(fromChat.changed);
          yield* TestClock.adjust("1 second");
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Queue.size(harness.dispatched), 0);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("streams every thread's open-question count after each change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          const other = ThreadId.make("thread-service-other");
          const seen = yield* Queue.unbounded<ReadonlyArray<string>>();
          yield* service.attention.pipe(
            Stream.runForEach((entries) =>
              Queue.offer(
                seen,
                entries.map(
                  (entry) => `${entry.threadId}:${entry.openQuestions}:${entry.latestQuestionId}`,
                ),
              ),
            ),
            Effect.forkScoped,
          );
          assert.deepStrictEqual(yield* Queue.take(seen), []);
          yield* service.apply(agent, threadId, start);
          assert.deepStrictEqual(yield* Queue.take(seen), []);
          yield* service.apply(agent, threadId, askQuestion);
          assert.deepStrictEqual(yield* Queue.take(seen), [`${threadId}:1:w1.q1`]);
          yield* service.apply(agent, other, start);
          assert.deepStrictEqual(yield* Queue.take(seen), [`${threadId}:1:w1.q1`]);
          yield* service.apply(agent, other, askQuestion);
          yield* service.apply(agent, threadId, { ...askQuestion, title: "Second?" });
          assert.deepStrictEqual(yield* Queue.take(seen), [
            `${threadId}:1:w1.q1`,
            `${other}:1:w1.q1`,
          ]);
          assert.deepStrictEqual(yield* Queue.take(seen), [
            `${threadId}:2:w1.q2`,
            `${other}:1:w1.q1`,
          ]);
          yield* service.apply(user, threadId, {
            _tag: "answer",
            questionId: "w1.q2" as never,
            answer: "Later",
          });
          assert.deepStrictEqual(yield* Queue.take(seen), [
            `${threadId}:1:w1.q1`,
            `${other}:1:w1.q1`,
          ]);
          yield* service.apply(agent, threadId, {
            _tag: "withdraw",
            questionId: "w1.q1" as never,
            reason: "moot",
          });
          assert.deepStrictEqual(yield* Queue.take(seen), [`${other}:1:w1.q1`]);
          yield* service.apply(user, other, {
            _tag: "close",
            instanceId: "w1" as never,
            outcome: "abandoned",
            reason: "test",
          });
          assert.deepStrictEqual(yield* Queue.take(seen), []);
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

  it.effect("answers store_unavailable and frees the lock when the append does not finish", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const landed = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          fileSystem: (real) =>
            FileSystem.FileSystem.of({
              ...real,
              // The real open acquires its handle uninterruptibly; this one does the same and waits.
              open: (file, openOptions) =>
                openOptions?.flag === "a"
                  ? Effect.acquireRelease(
                      Deferred.succeed(reached, undefined).pipe(
                        Effect.andThen(Deferred.await(gate)),
                      ),
                      () => Effect.void,
                    ).pipe(
                      Effect.andThen(real.open(file, openOptions)),
                      Effect.tap(() =>
                        Effect.addFinalizer(() => Deferred.succeed(landed, undefined)),
                      ),
                    )
                  : real.open(file, openOptions),
            }),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          const hooks = yield* ThreadHooks;
          const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
          const fileSystem = yield* FileSystem.FileSystem;

          const starting = yield* service
            .apply(user, threadId, start)
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(reached);
          yield* TestClock.adjust("10 seconds");
          assert.strictEqual((yield* Fiber.join(starting)).code, "store_unavailable");
          assert.strictEqual(
            yield* executor.withLock(threadId, Effect.succeed("a lifecycle command ran")),
            "a lifecycle command ran",
          );
          assert.strictEqual(
            (yield* service.state(threadId)).view.corruption,
            "a write did not complete",
          );
          assert.isNull(yield* hooks.lifecycleBlocker({ threadId, action: "settle" }));

          yield* Deferred.succeed(gate, undefined);
          yield* Deferred.await(landed);
          const onDisk = yield* fileSystem.readFileString(harness.logFile);
          assert.lengthOf(onDisk.split("\n"), 2);
          const inMemory = (yield* service.state(threadId)).view;
          assert.strictEqual(inMemory.corruption, "a write did not complete");
          assert.deepStrictEqual(inMemory.instances, []);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("lists templates unverified and refuses a start while the disk permit is held", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          fileSystem: (real) =>
            FileSystem.FileSystem.of({
              ...real,
              open: (file, openOptions) =>
                openOptions?.flag === "a"
                  ? Deferred.succeed(reached, undefined).pipe(
                      Effect.andThen(Deferred.await(gate)),
                      Effect.andThen(real.open(file, openOptions)),
                    )
                  : real.open(file, openOptions),
            }),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          const stalling = yield* service
            .apply(user, threadId, start)
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(reached);
          yield* TestClock.adjust("10 seconds");
          assert.strictEqual((yield* Fiber.join(stalling)).code, "store_unavailable");

          const listing = yield* Effect.forkChild(service.templates);
          const starting = yield* service
            .apply(user, ThreadId.make("thread-2"), start)
            .pipe(Effect.flip, Effect.forkChild);
          yield* Effect.yieldNow;
          yield* TestClock.adjust("5 seconds");
          assert.deepStrictEqual(
            (yield* Fiber.join(listing)).map((template) => template.freshness).toSorted(),
            ["no-source", "source-missing", "source-missing"],
          );
          const refused = yield* Fiber.join(starting);
          assert.strictEqual(refused.code, "store_unavailable");
          assert.match(refused.message, /workflow templates did not answer/);

          yield* Deferred.succeed(gate, undefined);
          assert.lengthOf(yield* service.templates, 3);
          assert.isNull((yield* service.view(ThreadId.make("thread-2"))).activeInstanceId);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("fails a request instead of holding the lock when settings do not answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stall = yield* makeStall;
        const harness = yield* makeHarness({ stall });
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
          yield* service.apply(user, threadId, start);

          yield* Ref.set(stall.on, true);
          const commenting = yield* service
            .apply(user, threadId, { _tag: "comment", target: "w1" as never, comment: "hi" })
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(stall.reached);
          yield* TestClock.adjust("5 seconds");
          const refused = yield* Fiber.join(commenting);
          assert.strictEqual(refused.code, "store_unavailable");
          assert.match(refused.message, /Server settings did not answer/);
          assert.strictEqual(yield* executor.withLock(threadId, Effect.succeed("free")), "free");
          assert.strictEqual((yield* service.view(threadId)).activeInstanceId, "w1");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("loads a log with a repeated start as corrupt, blocks nothing, and recovers it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          seedLog: duplicateStart.map((record) => `${JSON.stringify(record)}\n`).join(""),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadWorkflowService;
          const hooks = yield* ThreadHooks;
          const pane = yield* service.state(threadId);
          assert.strictEqual(
            pane.view.corruption,
            "line 2 of its log starts w1, which already exists",
          );
          assert.isTrue(pane.visible);
          for (const action of ["settle", "archive", "delete"] as const) {
            assert.isNull(yield* hooks.lifecycleBlocker({ threadId, action }));
          }
          const recovered = yield* service.apply(user, threadId, {
            _tag: "recover",
            reason: "the log repeated a start",
          });
          assert.isNull(recovered.view.corruption);
          const next = yield* service.apply(user, threadId, start);
          assert.strictEqual(next.view.activeInstanceId, "w2");
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
          assert.strictEqual(yield* hooks.turnNote(noteInput(false)), "");
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
