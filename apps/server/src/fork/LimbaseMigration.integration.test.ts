import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
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
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const PLAIN: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-7",
  options: [{ id: "effort", value: "medium" }],
};
const LIMBASE = ProviderInstanceId.make("claude-limbase");
const CODEX_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-luna",
};
const MIGRATED_SESSION = "00000000-0000-4000-8000-00000000beef";
const LIMBASE_THREAD = "th_migrated_fixture";

interface Turn {
  readonly instanceId: ProviderInstanceId;
  readonly providerThreadId: ProviderThreadId;
  readonly nativeThreadId: string | null;
  readonly text: string;
  readonly ordinal: number;
}

/** A provider that completes each turn at once, records what it was sent, and can hold a turn. */
const fakeAdapter = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly turns: Ref.Ref<ReadonlyArray<Turn>>;
  readonly injected: Ref.Ref<number>;
  readonly hold?: {
    readonly ordinal: number;
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
}): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId: input.instanceId,
  driver: input.driver,
  getCapabilities: () =>
    Effect.succeed(
      input.driver === CLAUDE ? ClaudeProviderCapabilitiesV2 : CodexProviderCapabilitiesV2,
    ),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (sessionInput) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      const providerSession: OrchestrationV2ProviderSession = {
        id: sessionInput.providerSessionId,
        driver: input.driver,
        providerInstanceId: input.instanceId,
        status: "ready",
        cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
        model: "fixture",
        capabilities:
          input.driver === CLAUDE ? ClaudeProviderCapabilitiesV2 : CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const fail = (detail: string) =>
        Effect.fail(
          new ProviderAdapter.ProviderAdapterProtocolError({ driver: input.driver, detail }),
        );
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: input.instanceId,
        driver: input.driver,
        providerSessionId: sessionInput.providerSessionId,
        providerSession,
        events: Stream.fromPubSub(events),
        ensureThread: (threadInput) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            const nativeThreadId = `${input.instanceId}:${threadInput.threadId}`;
            return {
              id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
              driver: input.driver,
              providerInstanceId: input.instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: input.driver,
                nativeId: nativeThreadId,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            } satisfies OrchestrationV2ProviderThread;
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        injectHistory: () => Ref.update(input.injected, (count) => count + 1).pipe(Effect.as(true)),
        compactThread: () => fail("unused"),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            yield* Ref.update(input.turns, (turns) => [
              ...turns,
              {
                instanceId: input.instanceId,
                providerThreadId: turnInput.providerThread.id,
                nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                text: turnInput.message.text,
                ordinal: turnInput.runOrdinal,
              },
            ]);
            if (input.hold !== undefined && turnInput.runOrdinal === input.hold.ordinal) {
              yield* Deferred.succeed(input.hold.started, undefined);
              yield* Deferred.await(input.hold.release);
            }
            const at = yield* DateTime.now;
            const providerTurnId = ProviderTurnId.make(
              `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
            );
            const published: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
              {
                type: "provider_turn.updated",
                driver: input.driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turnInput.providerThread.id,
                  nodeId: turnInput.rootNodeId,
                  runAttemptId: turnInput.attemptId,
                  nativeTurnRef: {
                    driver: input.driver,
                    nativeId: `native-turn:${input.instanceId}:${turnInput.runOrdinal}`,
                    strength: "strong",
                  },
                  ordinal: turnInput.runOrdinal,
                  status: "completed",
                  startedAt: at,
                  completedAt: at,
                },
              },
              {
                type: "turn_item.updated",
                driver: input.driver,
                turnItem: {
                  id: TurnItemId.make(`turn-item:${input.instanceId}:${turnInput.runOrdinal}`),
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
                  startedAt: at,
                  completedAt: at,
                  updatedAt: at,
                  type: "assistant_message",
                  messageId: MessageId.make(
                    `message:${input.instanceId}:${turnInput.runOrdinal}:assistant`,
                  ),
                  text: `Reply ${turnInput.runOrdinal}`,
                  streaming: false,
                },
              },
              {
                type: "turn.terminal",
                driver: input.driver,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                runOrdinal: turnInput.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              },
            ];
            for (const event of published) yield* PubSub.publish(events, event);
          }),
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => fail("unused"),
        rollbackThread: () => fail("unused"),
        forkThread: () => fail("unused"),
      };
      return runtime;
    }),
});

const harness = (
  name: string,
  cwd: string,
  adapters: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>,
) =>
  ProviderReplayHarness.layerWithRegistry(
    {
      name,
      runtimePolicyOverride: {
        cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
      },
    },
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        get: (instanceId) => {
          const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
          return adapter === undefined
            ? Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              )
            : Effect.succeed(adapter);
        },
        list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
        getMetadata: (instanceId) => {
          const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
          return adapter === undefined
            ? Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              )
            : Effect.succeed({
                driver: adapter.driver,
                continuationKey: `${adapter.instanceId}:history`,
                enabled: true,
                capabilities:
                  adapter.driver === CLAUDE
                    ? ClaudeProviderCapabilitiesV2
                    : CodexProviderCapabilitiesV2,
              });
        },
      }),
    ),
  );

const waitForIdle = Effect.fn("LimbaseMigrationTest.waitForIdle")(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const isIdle = (projection: OrchestrationV2ThreadProjection) =>
    projection.runs.every(
      (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
    );
  const afterSequence = yield* eventSink.latestSequence();
  const current = yield* orchestrator.getThreadProjection(threadId);
  if (isIdle(current)) return current;
  const [idle] = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    Stream.filter(isIdle),
    Stream.take(1),
    Stream.runCollect,
  );
  return idle!;
});

/** A thread on the plain Claude instance, with helpers to send and to bind. */
const scenario = Effect.fn("LimbaseMigrationTest.scenario")(function* (key: string, cwd: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const threadId = ThreadId.make(`thread:limbase-migration:${key}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:${key}:create`),
    threadId,
    projectId: ProjectId.make(`project:${key}`),
    title: "Migrated thread",
    modelSelection: PLAIN,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
  });
  let sent = 0;
  /** Sends on the thread's current pick, as the composer does, unless told otherwise. */
  const send = (
    text: string,
    options: {
      readonly modelSelection?: ModelSelection;
      readonly freshContext?: boolean;
      readonly wait?: boolean;
      readonly queue?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      sent += 1;
      const { thread } = yield* orchestrator.getThreadProjection(threadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:${key}:send:${sent}`),
        threadId,
        messageId: MessageId.make(`message:${key}:${sent}`),
        text,
        attachments: [],
        modelSelection: options.modelSelection ?? thread.modelSelection,
        ...(options.freshContext === undefined ? {} : { freshContext: options.freshContext }),
        deliveryIntent: "auto",
        dispatchMode:
          options.queue === true ? { type: "queue_after_active" } : { type: "start_immediately" },
      });
      if (options.wait === false) return;
      yield* worker.drain();
      yield* waitForIdle(threadId);
    });
  const bind = (ifLastRun: number, sessionId = MIGRATED_SESSION) =>
    orchestrator.dispatch({
      type: "thread.limbase.bind",
      commandId: CommandId.make(`command:${key}:bind:${ifLastRun}:${sessionId}`),
      threadId,
      providerInstanceId: LIMBASE,
      limbaseThreadId: LIMBASE_THREAD,
      sessionId,
      ifLastRun,
    });
  const unbind = (name: string) =>
    orchestrator.dispatch({
      type: "thread.limbase.unbind",
      commandId: CommandId.make(`command:${key}:unbind:${name}`),
      threadId,
    });
  const projection = () => orchestrator.getThreadProjection(threadId);
  return { threadId, send, bind, unbind, projection };
});

const setup = (
  key: string,
  hold?: { readonly ordinal: number; readonly instanceId: ProviderInstanceId },
) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(`limbase-migration-${key}`);
    const turns = yield* Ref.make<ReadonlyArray<Turn>>([]);
    const injected = yield* Ref.make(0);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holdFor = (instanceId: ProviderInstanceId) =>
      hold !== undefined && hold.instanceId === instanceId
        ? { hold: { ordinal: hold.ordinal, started, release } }
        : {};
    const adapters = [
      fakeAdapter({
        instanceId: PLAIN.instanceId,
        driver: CLAUDE,
        turns,
        injected,
        ...holdFor(PLAIN.instanceId),
      }),
      fakeAdapter({ instanceId: LIMBASE, driver: CLAUDE, turns, injected, ...holdFor(LIMBASE) }),
      fakeAdapter({ instanceId: CODEX_SELECTION.instanceId, driver: CODEX, turns, injected }),
    ];
    return { cwd, turns, injected, started, release, layer: harness(key, cwd, adapters) };
  });

const handoffMarker = "Context handoff";

describe("Limbase migration bind", () => {
  it.live("runs the next prompt on the migrated session with no handoff of the runs it holds", () =>
    Effect.gen(function* () {
      const env = yield* setup("bind");
      yield* Effect.gen(function* () {
        const thread = yield* scenario("bind", env.cwd);
        yield* thread.send("one");
        yield* thread.send("two");
        yield* thread.send("three");
        const before = yield* thread.projection();
        const original = before.providerThreads.find(
          (row) => row.id === before.thread.activeProviderThreadId,
        )!;

        yield* thread.bind(3);
        const bound = yield* thread.projection();
        const row = bound.providerThreads.find(
          (candidate) => candidate.id === bound.thread.activeProviderThreadId,
        )!;
        assert.notEqual(row.id, original.id);
        assert.equal(row.providerInstanceId, LIMBASE);
        assert.equal(row.nativeThreadRef?.nativeId, MIGRATED_SESSION);
        assert.deepEqual(row.nativeMetadata, {
          limbaseThreadId: LIMBASE_THREAD,
          limbaseMigratedThroughRunOrdinal: 3,
          limbaseMigratedFromProviderThreadId: original.id,
        });
        // The original row is exactly as it was; the model and its options are kept.
        assert.deepEqual(
          bound.providerThreads.find((candidate) => candidate.id === original.id),
          original,
        );
        assert.deepEqual(bound.thread.modelSelection, { ...PLAIN, instanceId: LIMBASE });
        assert.equal(bound.thread.providerInstanceId, LIMBASE);

        yield* thread.send("four");
        const after = yield* thread.projection();
        const fourth = (yield* Ref.get(env.turns)).at(-1)!;
        assert.deepEqual(fourth, {
          instanceId: LIMBASE,
          providerThreadId: row.id,
          nativeThreadId: MIGRATED_SESSION,
          text: "four",
          ordinal: 4,
        });
        assert.equal(after.runs.at(-1)?.providerInstanceId, LIMBASE);
        assert.equal(after.runs.at(-1)?.providerThreadId, row.id);
        assert.lengthOf(after.contextHandoffs, 0);
        assert.equal(yield* Ref.get(env.injected), 0);
        // Only the bound row exists on the Limbase instance: no second Limbase thread was made.
        assert.lengthOf(
          after.providerThreads.filter((candidate) => candidate.providerInstanceId === LIMBASE),
          1,
        );

        // An ordinary switch later on still hands off what the target has not seen.
        yield* thread.send("five", { modelSelection: CODEX_SELECTION });
        const switched = yield* thread.projection();
        assert.lengthOf(switched.contextHandoffs, 1);
        assert.deepEqual(switched.contextHandoffs[0]!.coveredRunOrdinals, { from: 1, to: 4 });
        const fifth = (yield* Ref.get(env.turns)).at(-1)!;
        assert.equal(fifth.instanceId, CODEX_SELECTION.instanceId);
        // Codex takes the handoff as injected history, or inline when it cannot.
        assert.isTrue((yield* Ref.get(env.injected)) > 0 || fifth.text.includes(handoffMarker));
      }).pipe(Effect.provide(env.layer));
    }),
  );

  it.live("unbinds back to the original session and its instance", () =>
    Effect.gen(function* () {
      const env = yield* setup("unbind");
      yield* Effect.gen(function* () {
        const thread = yield* scenario("unbind", env.cwd);
        yield* thread.send("one");
        yield* thread.send("two");
        const before = yield* thread.projection();
        const original = before.providerThreads.find(
          (row) => row.id === before.thread.activeProviderThreadId,
        )!;
        yield* thread.bind(2);
        yield* thread.send("three on limbase");

        yield* thread.unbind("first");
        const unbound = yield* thread.projection();
        assert.equal(unbound.thread.activeProviderThreadId, original.id);
        assert.deepEqual(unbound.thread.modelSelection, PLAIN);
        assert.deepEqual(
          unbound.providerThreads.find((candidate) => candidate.id === original.id),
          original,
        );

        yield* thread.send("four back home");
        const after = yield* thread.projection();
        const fourth = (yield* Ref.get(env.turns)).at(-1)!;
        assert.equal(fourth.instanceId, PLAIN.instanceId);
        assert.equal(fourth.providerThreadId, original.id);
        assert.equal(fourth.nativeThreadId, original.nativeThreadRef?.nativeId ?? null);
        assert.equal(after.runs.at(-1)?.providerInstanceId, PLAIN.instanceId);
        assert.equal(after.runs.at(-1)?.providerThreadId, original.id);

        const again = yield* Effect.result(thread.unbind("second"));
        assert.isTrue(again._tag === "Failure");
      }).pipe(Effect.provide(env.layer));
    }),
  );

  it.live(
    "keeps the bound row for runs queued behind its first run after a fresh-context run",
    () =>
      Effect.gen(function* () {
        const env = yield* setup("fresh", { ordinal: 4, instanceId: LIMBASE });
        yield* Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const thread = yield* scenario("fresh", env.cwd);
          yield* thread.send("one");
          yield* thread.send("two, fresh", { freshContext: true });
          yield* thread.send("three");
          yield* thread.bind(3);
          const rowId = (yield* thread.projection()).thread.activeProviderThreadId;

          // The effect worker runs the held turn; draining here would wait on it.
          yield* thread.send("four", { wait: false });
          yield* Deferred.await(env.started);
          // Queued behind the bound row's first run, so it starts through the queue.
          yield* thread.send("five", { wait: false });
          assert.equal((yield* thread.projection()).runs.at(-1)?.status, "queued");
          yield* Deferred.succeed(env.release, undefined);
          yield* worker.drain();
          yield* waitForIdle(thread.threadId);

          const after = yield* thread.projection();
          assert.deepEqual(
            after.runs.slice(-2).map((run) => [run.status, run.providerThreadId]),
            [
              ["completed", rowId],
              ["completed", rowId],
            ],
          );
          assert.lengthOf(
            after.providerThreads.filter((candidate) => candidate.providerInstanceId === LIMBASE),
            1,
          );
          assert.deepEqual(
            (yield* Ref.get(env.turns)).slice(-2).map((turn) => [turn.text, turn.nativeThreadId]),
            [
              ["four", MIGRATED_SESSION],
              ["five", MIGRATED_SESSION],
            ],
          );
          assert.lengthOf(after.contextHandoffs, 0);
        }).pipe(Effect.provide(env.layer));
      }),
  );

  it.live.each(["plain", "after a fresh-context run"] as const)(
    "hands a bound row only the runs after the migration when the thread switches back to it (%s)",
    (history) =>
      Effect.gen(function* () {
        const key = history === "plain" ? "switch-back" : "switch-back-fresh";
        const env = yield* setup(key);
        yield* Effect.gen(function* () {
          const thread = yield* scenario(key, env.cwd);
          yield* thread.send("one");
          yield* thread.send("two", { freshContext: history !== "plain" });
          yield* thread.send("three");
          yield* thread.bind(3);
          const rowId = (yield* thread.projection()).thread.activeProviderThreadId;
          // A stale picker sends on Codex before the bound row has run anything.
          yield* thread.send("four", { modelSelection: CODEX_SELECTION });
          yield* thread.send("five", { modelSelection: { ...PLAIN, instanceId: LIMBASE } });
          const after = yield* thread.projection();
          assert.equal(after.runs.at(-1)?.providerThreadId, rowId);
          // No second row, so no second Limbase thread, on the Limbase instance.
          assert.lengthOf(
            after.providerThreads.filter((candidate) => candidate.providerInstanceId === LIMBASE),
            1,
          );
          assert.equal((yield* Ref.get(env.turns)).at(-1)?.nativeThreadId, MIGRATED_SESSION);
          const toBound = after.contextHandoffs.filter(
            (handoff) => handoff.toProviderThreadId === rowId,
          );
          assert.deepEqual(
            toBound.map((handoff) => handoff.coveredRunOrdinals),
            [{ from: 4, to: 4 }],
          );
        }).pipe(Effect.provide(env.layer));
      }),
  );

  it.live("refuses, and changes nothing, when a run came after the export", () =>
    Effect.gen(function* () {
      const env = yield* setup("stale");
      yield* Effect.gen(function* () {
        const thread = yield* scenario("stale", env.cwd);
        yield* thread.send("one");
        yield* thread.send("two");
        const before = yield* thread.projection();
        const refused = yield* Effect.result(thread.bind(1));
        assert.isTrue(refused._tag === "Failure");
        if (refused._tag === "Failure") {
          assert.include(String((refused.failure as { cause?: unknown }).cause), "not 1");
        }
        const after = yield* thread.projection();
        assert.deepEqual(after.thread, before.thread);
        assert.deepEqual(after.providerThreads, before.providerThreads);
      }).pipe(Effect.provide(env.layer));
    }),
  );

  it.live("refuses, and changes nothing, while a run is in progress", () =>
    Effect.gen(function* () {
      const env = yield* setup("busy", { ordinal: 2, instanceId: PLAIN.instanceId });
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const thread = yield* scenario("busy", env.cwd);
        yield* thread.send("one");
        yield* thread.send("two", { wait: false });
        yield* worker.drain();
        yield* Deferred.await(env.started);
        const before = yield* thread.projection();
        assert.equal(before.runs.at(-1)?.status, "running");
        const refused = yield* Effect.result(thread.bind(2));
        assert.isTrue(refused._tag === "Failure");
        const after = yield* thread.projection();
        assert.deepEqual(after.thread, before.thread);
        assert.deepEqual(after.providerThreads, before.providerThreads);
        yield* Deferred.succeed(env.release, undefined);
        yield* waitForIdle(thread.threadId);
      }).pipe(Effect.provide(env.layer));
    }),
  );
});
