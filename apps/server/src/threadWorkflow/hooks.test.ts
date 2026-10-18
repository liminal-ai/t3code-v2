import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings as ServerSettingsShape,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { HOOK_DEADLINE, ThreadHooks } from "../orchestration-v2/ThreadHooks.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layerThreadHooks } from "./hooks.ts";
import { ThreadWorkflowStore } from "./store.ts";
import { given, started, threadId } from "./testkit.ts";

const runId = "run-1" as never;
const openState = given(started).state;

const layerFor = (
  store: Partial<ThreadWorkflowStore["Service"]>,
  getSettings: Effect.Effect<ServerSettingsShape, never> = Effect.succeed(DEFAULT_SERVER_SETTINGS),
) =>
  layerThreadHooks.pipe(
    Layer.provide(Layer.mock(ThreadWorkflowStore)({ unavailable: null, ...store })),
    Layer.provide(Layer.mock(ServerSettings.ServerSettingsService)({ getSettings })),
  );

const captureWarnings = () => {
  const warnings: Array<unknown> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });
  return { warnings, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

it.effect("gives no note and no blocker when the store throws while the hook is built", () => {
  const log = captureWarnings();
  return Effect.gen(function* () {
    const hooks = yield* ThreadHooks;
    assert.strictEqual(yield* hooks.turnNote({ threadId, runId, compacting: false }), "");
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
