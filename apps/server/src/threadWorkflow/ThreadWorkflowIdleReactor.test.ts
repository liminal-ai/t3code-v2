import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type ThreadWorkflowActor,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadWorkflowStore from "./store.ts";
import {
  QUIET_PERIOD_MS,
  ThreadWorkflowIdleReactor,
  idleCommandId,
  layer as reactorLayer,
} from "./ThreadWorkflowIdleReactor.ts";
import * as ThreadWorkflowService from "./ThreadWorkflowService.ts";

const T0 = Date.parse("2026-10-17T12:00:00.000Z");
const HOUR = 60 * 60 * 1_000;
const threadId = ThreadId.make("thread-idle");
const user: ThreadWorkflowActor = { _tag: "user", clientSessionId: "pane" };
const at = (ms: number) => DateTime.makeUnsafe(ms);

const shellOf = (overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell =>
  ({
    id: threadId,
    projectId: ProjectId.make("project-idle"),
    title: "Idle thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    latestRunId: null,
    latestRunStartedAt: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at(T0),
    updatedAt: at(T0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const queuedRun = { id: RunId.make("run-queued"), status: "queued" } as OrchestrationV2Run;

const makeHarness = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-workflow-idle-" });
  const shell = yield* Ref.make<OrchestrationV2ThreadShell | null>(shellOf());
  const runs = yield* Ref.make<ReadonlyArray<OrchestrationV2Run>>([]);
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const dependencies = Layer.mergeAll(
    ThreadCommandExecutor.layer,
    ServerSettings.layerTest({ threadWorkflowsEnabled: true }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThread: () => Ref.get(shell).pipe(Effect.map((current) => current as never)),
      getThreadShell: () => Ref.get(shell),
      getThreadRecords: () =>
        Effect.all({ thread: Effect.succeed({} as never), runs: Ref.get(runs) }).pipe(
          Effect.map((records) => records as never),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        Ref.update(dispatched, (commands) => [...commands, command]).pipe(
          Effect.as({ sequence: 1, replayed: false } as never),
        ),
    }),
  );
  // Each `Effect.provide(layer())` builds its own store from the dir, so a second build is a restart.
  const layer = () =>
    Layer.mergeAll(ThreadWorkflowService.layer, reactorLayer).pipe(
      Layer.provideMerge(ThreadWorkflowStore.layer),
      Layer.provideMerge(dependencies),
      Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
      Layer.provide(NodeServices.layer),
    );
  return { shell, runs, dispatched, layer };
});

const scanAt = (ms: number) =>
  TestClock.setTime(ms).pipe(
    Effect.andThen(Effect.flatMap(ThreadWorkflowIdleReactor, (reactor) => reactor.scan)),
  );

const startInstance = Effect.flatMap(ThreadWorkflowService.ThreadWorkflowService, (service) =>
  service.apply(user, threadId, { _tag: "start", templateId: "open-ended" as never }),
);

it.layer(NodeServices.layer)("ThreadWorkflowIdleReactor", (it) => {
  it.effect("pings once per quiet day, across a rescan and a restart, with one command id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* TestClock.setTime(T0);
        yield* Effect.gen(function* () {
          yield* startInstance;
          yield* scanAt(T0 + 23 * HOUR);
          assert.lengthOf(yield* Ref.get(harness.dispatched), 0);
          yield* scanAt(T0 + 25 * HOUR);
          yield* scanAt(T0 + 26 * HOUR);
          const commands = yield* Ref.get(harness.dispatched);
          assert.lengthOf(commands, 2);
          const expectedId = idleCommandId({
            threadId,
            instanceId: "w1",
            quietSinceMs: T0,
            quietDays: 1,
          });
          for (const command of commands) {
            assert.strictEqual(command.type, "message.dispatch");
            assert.strictEqual(command.commandId, expectedId);
            if (command.type === "message.dispatch") {
              assert.strictEqual(command.messageId, expectedId);
              assert.strictEqual(command.creationSource, "server");
              assert.strictEqual(command.createdBy, "agent");
              assert.deepStrictEqual(command.dispatchMode, { type: "queue_after_active" });
              assert.deepStrictEqual(command.notification?.source, { kind: "system" });
              assert.match(command.text, /Open-ended.*\(w1\).*thread-idle/);
              assert.match(command.text, /Ask the user whether to continue this workflow\./);
              assert.notMatch(command.text, /question tool/);
              assert.match(
                command.text,
                /thread_workflow_change \{"action":"comment","target":"w1"/,
              );
              assert.match(command.text, /who answered/);
              assert.match(
                command.text,
                /thread_workflow_close \{"instanceId":"w1","outcome":"abandoned"/,
              );
            }
          }
        }).pipe(Effect.provide(harness.layer()));
        yield* Effect.gen(function* () {
          yield* scanAt(T0 + 27 * HOUR);
          yield* scanAt(T0 + 49 * HOUR);
          const ids = (yield* Ref.get(harness.dispatched)).map((command) => command.commandId);
          assert.deepStrictEqual(ids.slice(2), [
            idleCommandId({ threadId, instanceId: "w1", quietSinceMs: T0, quietDays: 1 }),
            idleCommandId({ threadId, instanceId: "w1", quietSinceMs: T0, quietDays: 2 }),
          ]);
        }).pipe(Effect.provide(harness.layer()));
      }),
    ),
  );

  it.effect("skips threads that are busy, parked, children, closed, or off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* TestClock.setTime(T0);
        yield* Effect.gen(function* () {
          yield* startInstance;
          const cases: ReadonlyArray<[string, Partial<OrchestrationV2ThreadShell>]> = [
            ["running", { activeRunId: RunId.make("run-live") }],
            [
              "pending request",
              {
                pendingRuntimeRequest: { id: "rr" as never, kind: "user_input", createdAt: at(T0) },
              },
            ],
            ["snoozed", { snoozedUntil: at(T0 + 100 * HOUR) }],
            [
              "child",
              {
                lineage: {
                  rootThreadId: ThreadId.make("parent"),
                  parentThreadId: ThreadId.make("parent"),
                  relationshipToParent: "subagent",
                },
              },
            ],
            ["settled", { settledOverride: "settled" }],
            ["archived", { archivedAt: at(T0) }],
          ];
          for (const [label, overrides] of cases) {
            yield* Ref.set(harness.shell, shellOf(overrides));
            yield* scanAt(T0 + 30 * HOUR);
            assert.lengthOf(yield* Ref.get(harness.dispatched), 0, label);
          }
          yield* Ref.set(harness.shell, shellOf());
          yield* Ref.set(harness.runs, [queuedRun]);
          yield* scanAt(T0 + 30 * HOUR);
          assert.lengthOf(yield* Ref.get(harness.dispatched), 0, "queued");
          yield* Ref.set(harness.runs, []);
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* settings.updateSettings({ threadWorkflowsEnabled: false });
          yield* scanAt(T0 + 30 * HOUR);
          assert.lengthOf(yield* Ref.get(harness.dispatched), 0, "flag off");
          yield* settings.updateSettings({ threadWorkflowsEnabled: true });
          const service = yield* ThreadWorkflowService.ThreadWorkflowService;
          yield* service.apply(user, threadId, {
            _tag: "close",
            instanceId: "w1" as never,
            outcome: "abandoned",
            reason: "done with it",
          });
          yield* scanAt(T0 + 60 * HOUR);
          assert.lengthOf(yield* Ref.get(harness.dispatched), 0, "closed");
          const snoozeOver = shellOf({ snoozedUntil: at(T0 + HOUR) });
          yield* Ref.set(harness.shell, snoozeOver);
          yield* service.apply(user, threadId, {
            _tag: "reopen",
            target: "w1" as never,
            reason: "again",
          });
          yield* scanAt(T0 + 60 * HOUR + QUIET_PERIOD_MS);
          assert.lengthOf(yield* Ref.get(harness.dispatched), 1, "snooze elapsed");
        }).pipe(Effect.provide(harness.layer()));
      }),
    ),
  );
});
