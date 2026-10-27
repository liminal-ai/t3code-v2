import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationMessageContext,
  type ServerSettings as ServerSettingsShape,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { HOOK_DEADLINE, ThreadHooks, type TurnNoteInput } from "../orchestration-v2/ThreadHooks.ts";
import * as ServerSettings from "../serverSettings.ts";
import { toSubscriptionView, type ThreadWorkflowState } from "./domain.ts";
import { layerThreadHooks } from "./hooks.ts";
import { ThreadWorkflowStore } from "./store.ts";
import { agent, given, started, threadId, user } from "./testkit.ts";
import { noWorkflowNote, turnNote } from "./turnNote.ts";

const runId = "run-1" as never;
const run2 = "run-2" as never;
const run3 = "run-3" as never;
const openState = given(started).state;
const context: TurnNoteInput["context"] = {
  providerThreadId: "provider-thread-1" as never,
  nativeThreadId: "native-1",
  model: "claudeAgent/claude-opus-5-5",
  compactions: 0,
};
const userSaid = (
  text: string,
  records: ReadonlyArray<unknown> = [],
): TurnNoteInput["message"] => ({
  role: "user",
  text,
  context: { version: 1, records } as OrchestrationMessageContext,
});
const ask = (overrides: Partial<TurnNoteInput> = {}): TurnNoteInput => ({
  threadId,
  runId,
  compacting: false,
  context,
  completedRunIds: new Set(),
  message: userSaid("Continue"),
  ...overrides,
});

const layerFor = (
  store: Partial<ThreadWorkflowStore["Service"]>,
  getSettings: Effect.Effect<ServerSettingsShape, never> = Effect.succeed(DEFAULT_SERVER_SETTINGS),
) =>
  layerThreadHooks.pipe(
    Layer.provide(
      Layer.mock(ThreadWorkflowStore)({
        unavailable: null,
        pstackThreads: Effect.succeed(new Set<ThreadId>()),
        markPstackThread: () => Effect.void,
        ...store,
      }),
    ),
    Layer.provide(Layer.mock(ServerSettings.ServerSettingsService)({ getSettings })),
  );

const withState = (initial: ThreadWorkflowState, marked: ReadonlySet<ThreadId> = new Set()) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initial);
    const marks = yield* Ref.make(marked);
    const markCalls = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const hooks = yield* ThreadHooks.pipe(
      Effect.provide(
        layerFor({
          state: () => Ref.get(state),
          pstackThreads: Ref.get(marks),
          markPstackThread: (id) =>
            Ref.update(markCalls, (calls) => [...calls, id]).pipe(
              Effect.andThen(Ref.update(marks, (set) => new Set(set).add(id))),
            ),
        }),
      ),
    );
    return {
      note: (input: TurnNoteInput) => hooks.turnNote(input),
      set: (next: ThreadWorkflowState) => Ref.set(state, next),
      markCalls: Ref.get(markCalls),
    };
  });

const letDetachedWorkRun = Effect.yieldNow;

const full = (state: ThreadWorkflowState) => turnNote(toSubscriptionView(state), "full");
const short = (state: ThreadWorkflowState) => turnNote(toSubscriptionView(state), "short");

const captureWarnings = () => {
  const warnings: Array<unknown> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });
  return { warnings, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

it.effect("sends the whole step once, then one line while that run's turn completed", () =>
  Effect.gen(function* () {
    const hooks = yield* withState(openState);
    assert.strictEqual(yield* hooks.note(ask()), full(openState));
    assert.strictEqual(
      yield* hooks.note(ask({ runId: run2, completedRunIds: new Set([runId]) })),
      short(openState),
    );
    assert.strictEqual(
      yield* hooks.note(ask({ runId: run3, completedRunIds: new Set([runId, run2]) })),
      short(openState),
    );
  }),
);

it.effect("sends the whole step again while the run that carried it has no completed turn", () =>
  Effect.gen(function* () {
    const hooks = yield* withState(openState);
    assert.strictEqual(yield* hooks.note(ask()), full(openState));
    assert.strictEqual(yield* hooks.note(ask({ runId: run2 })), full(openState));
    assert.strictEqual(
      yield* hooks.note(ask({ runId: run3, completedRunIds: new Set([runId]) })),
      full(openState),
    );
    assert.strictEqual(
      yield* hooks.note(ask({ runId: "run-4" as never, completedRunIds: new Set([run3]) })),
      short(openState),
    );
  }),
);

it.effect("sends the whole step again after the step changes or its text is edited", () =>
  Effect.gen(function* () {
    const hooks = yield* withState(openState);
    yield* hooks.note(ask());
    const settled = ask({ runId: run2, completedRunIds: new Set([runId, run2]) });
    assert.strictEqual(yield* hooks.note(settled), short(openState));

    const ticked = given(started, [agent, { _tag: "tick", stepId: "w1.1", comment: "done" }]).state;
    yield* hooks.set(ticked);
    assert.strictEqual(yield* hooks.note(settled), full(ticked));
    assert.strictEqual(yield* hooks.note(settled), short(ticked));

    const edited: ThreadWorkflowState = {
      ...ticked,
      instances: ticked.instances.map((entry) => ({
        ...entry,
        instance: {
          ...entry.instance,
          steps: entry.instance.steps.map((step) =>
            step.id === "w1.2" ? { ...step, instructions: "Ask whether to ship today." } : step,
          ),
        },
      })),
    };
    yield* hooks.set(edited);
    const resent = yield* hooks.note(settled);
    assert.strictEqual(resent, full(edited));
    assert.include(resent, "ship today");
    assert.strictEqual(yield* hooks.note(settled), short(edited));
  }),
);

it.effect(
  "sends the whole step again after a compaction, a new provider thread, native thread or model",
  () =>
    Effect.gen(function* () {
      const hooks = yield* withState(openState);
      const completed = new Set([runId]);
      yield* hooks.note(ask());
      assert.strictEqual(yield* hooks.note(ask({ completedRunIds: completed })), short(openState));
      for (const changed of [
        { ...context, compactions: 1 },
        { ...context, providerThreadId: "provider-thread-2" as never },
        { ...context, nativeThreadId: "native-2" },
        { ...context, nativeThreadId: null },
        { ...context, model: "codex/gpt-6.1-sol" },
      ]) {
        const input = ask({ context: changed, completedRunIds: completed });
        assert.strictEqual(yield* hooks.note(input), full(openState), JSON.stringify(changed));
        assert.strictEqual(yield* hooks.note(input), short(openState), JSON.stringify(changed));
      }
    }),
);

it.effect("sends nothing on a compacting turn and records nothing", () =>
  Effect.gen(function* () {
    const hooks = yield* withState(openState);
    assert.strictEqual(yield* hooks.note(ask({ compacting: true })), "");
    assert.strictEqual(
      yield* hooks.note(ask({ runId: run2, completedRunIds: new Set([runId]) })),
      full(openState),
    );
  }),
);

it.effect("sends the close form in full every turn once every step is resolved", () =>
  Effect.gen(function* () {
    const resolved = given(
      started,
      [agent, { _tag: "tick", stepId: "w1.1", comment: "done" }],
      [agent, { _tag: "tick", stepId: "w1.2", comment: "go" }],
      [agent, { _tag: "skip", stepId: "w1.3", reason: "elsewhere" }],
    ).state;
    const hooks = yield* withState(resolved);
    yield* hooks.note(ask());
    const again = yield* hooks.note(ask({ runId: run2, completedRunIds: new Set([runId]) }));
    assert.strictEqual(again, full(resolved));
    assert.include(again, "thread_workflow_close");
  }),
);

it.effect(
  "tells a thread under /poteto-mode with no workflow to start one, on that turn and the next",
  () =>
    Effect.gen(function* () {
      const expected = noWorkflowNote();
      for (const message of [
        userSaid("$poteto-mode", [{ kind: "skill", name: "poteto-mode", label: "$poteto-mode" }]),
        userSaid("Load /poteto-mode and run recall"),
        userSaid("load Poteto Mode and run recall"),
        userSaid("poteto-mode, then fix the bug"),
      ]) {
        const hooks = yield* withState(given().state);
        assert.strictEqual(yield* hooks.note(ask({ message })), expected, message.text);
        yield* letDetachedWorkRun;
        assert.deepStrictEqual(yield* hooks.markCalls, [threadId], message.text);
        const plain = ask({ runId: run2, message: userSaid("fix the bug") });
        assert.strictEqual(yield* hooks.note(plain), expected, message.text);
        assert.strictEqual(yield* hooks.note(ask({ runId: run3, message })), expected);
        assert.deepStrictEqual(yield* hooks.markCalls, [threadId], message.text);
      }
    }),
);

it.effect("tells a thread the store has marked to start a workflow, without marking it again", () =>
  Effect.gen(function* () {
    const hooks = yield* withState(given().state, new Set([threadId]));
    assert.strictEqual(
      yield* hooks.note(ask({ message: userSaid("fix the bug") })),
      noWorkflowNote(),
    );
    assert.deepStrictEqual(yield* hooks.markCalls, []);
  }),
);

it.effect("tells a plain thread nothing, and a thread whose workflow closed to start one", () =>
  Effect.gen(function* () {
    const hooks = yield* withState(given().state);
    for (const message of [
      userSaid("fix the bug"),
      { role: "assistant", text: "I run under poteto mode." } as const,
      userSaid("use the skill", [{ kind: "skill", name: "pinchtab", label: "$pinchtab" }]),
    ]) {
      assert.strictEqual(yield* hooks.note(ask({ message })), "", message.text);
    }
    assert.deepStrictEqual(yield* hooks.markCalls, []);
    const closed = given(started, [
      user,
      { _tag: "close", instanceId: "w1", outcome: "abandoned", reason: "x" },
    ]).state;
    yield* hooks.set(closed);
    assert.strictEqual(yield* hooks.note(ask()), noWorkflowNote());
    assert.strictEqual(yield* hooks.note(ask({ compacting: true })), "");
    assert.deepStrictEqual(yield* hooks.markCalls, []);
  }),
);

it.effect("gives no note and no blocker when the store throws while the hook is built", () => {
  const log = captureWarnings();
  return Effect.gen(function* () {
    const hooks = yield* ThreadHooks;
    assert.strictEqual(yield* hooks.turnNote(ask()), "");
    assert.isNull(yield* hooks.lifecycleBlocker({ threadId, action: "settle" }));
    assert.lengthOf(log.warnings, 2);
  }).pipe(
    Effect.provide(
      Layer.merge(
        layerFor({
          state: () => {
            throw new Error("state() threw before returning an effect");
          },
        }),
        log.layer,
      ),
    ),
  );
});

it.effect("stops blocking when the settings read does not answer by the hook deadline", () => {
  const log = captureWarnings();
  return Effect.gen(function* () {
    const stalled = yield* Ref.make(false);
    const reached = yield* Deferred.make<void>();
    const getSettings = Ref.get(stalled).pipe(
      Effect.flatMap((stall) =>
        stall
          ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(DEFAULT_SERVER_SETTINGS),
      ),
    );
    yield* Effect.gen(function* () {
      const hooks = yield* ThreadHooks;
      assert.match((yield* hooks.lifecycleBlocker({ threadId, action: "settle" })) ?? "", /w1/);

      yield* Ref.set(stalled, true);
      const answered = yield* Ref.make(false);
      const checking = yield* hooks.lifecycleBlocker({ threadId, action: "settle" }).pipe(
        Effect.tap(() => Ref.set(answered, true)),
        Effect.forkChild,
      );
      yield* Deferred.await(reached);
      assert.isFalse(yield* Ref.get(answered));
      yield* TestClock.adjust(HOOK_DEADLINE);
      assert.isNull(yield* Fiber.join(checking));
      assert.match(String(log.warnings.at(-1)), /lifecycle check failed/);
    }).pipe(Effect.provide(layerFor({ state: () => Effect.succeed(openState) }, getSettings)));
  }).pipe(Effect.provide(log.layer));
});

it.effect("stops blocking when the settings read dies", () => {
  const log = captureWarnings();
  return Effect.gen(function* () {
    const hooks = yield* ThreadHooks;
    assert.isNull(yield* hooks.lifecycleBlocker({ threadId, action: "archive" }));
    assert.lengthOf(log.warnings, 1);
  }).pipe(
    Effect.provide(
      Layer.merge(
        layerFor(
          { state: () => Effect.succeed(openState) },
          Effect.die(new Error("settings broke")),
        ),
        log.layer,
      ),
    ),
  );
});
