import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2EngineBinding,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { acpSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as ProviderSwitch from "./ProviderSwitchService.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const currentInstanceId = ProviderInstanceId.make("codex_primary");
const currentSessionId = ProviderSessionId.make("session_primary");
const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const capabilitiesWithoutModelSwitch = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: false,
  },
};

function projection(): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: ThreadId.make("thread_switch_service"),
      modelSelection: { instanceId: currentInstanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: "/repo",
    },
    providerSessions: [
      {
        id: currentSessionId,
        providerInstanceId: currentInstanceId,
        status: "ready",
        cwd: "/repo",
        capabilities: capabilitiesWithoutModelSwitch,
        updatedAt: now,
      },
    ],
    providerThreads: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

function deadSessionRecord(
  id: string,
  status: "stopped" | "error",
  updatedAt: DateTime.Utc = DateTime.add(now, { seconds: 1 }),
) {
  return {
    ...projection().providerSessions[0]!,
    id: ProviderSessionId.make(id),
    status,
    updatedAt,
  };
}

function layerTest(
  metadata: Readonly<Record<string, { continuationKey: string }>>,
  planSelectionTransition: ProviderAdapter.ProviderAdapterV2["Service"]["planSelectionTransition"] = () =>
    Effect.succeed({ type: "restart_session" }),
) {
  const adapter = (
    instanceId: ProviderInstanceId,
  ): ProviderAdapter.ProviderAdapterV2["Service"] => ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilitiesWithoutModelSwitch),
    planSelectionTransition,
    openSession: () => Effect.die("ProviderSwitchService tests do not open sessions."),
  });
  const layerRegistry = Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
    get: (instanceId) =>
      metadata[instanceId] === undefined
        ? Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          )
        : Effect.succeed(adapter(instanceId)),
    list: () => Effect.succeed(Object.keys(metadata).map((id) => ProviderInstanceId.make(id))),
    getMetadata: (instanceId) => {
      const value = metadata[instanceId];
      return value === undefined
        ? Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          )
        : Effect.succeed({
            driver,
            continuationKey: value.continuationKey,
            enabled: true,
            capabilities: capabilitiesWithoutModelSwitch,
          });
    },
  });
  return ProviderSwitch.layer.pipe(Layer.provide(layerRegistry));
}

it.effect("releases the newest live session, not the newest record overall", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const thread = projection();
    const newerLiveSessionId = ProviderSessionId.make("session_newer_live");
    const result = yield* service.plan({
      projection: {
        ...thread,
        providerSessions: [
          ...thread.providerSessions,
          {
            ...thread.providerSessions[0]!,
            id: newerLiveSessionId,
            updatedAt: DateTime.add(now, { seconds: 1 }),
          },
          deadSessionRecord("dead_session", "stopped", DateTime.add(now, { seconds: 2 })),
        ],
      },
      targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
    });
    assert.equal(result.transition.type, "restart_and_resume");
    assert.deepEqual(result.releaseProviderSessionIds, [newerLiveSessionId]);
  }).pipe(
    Effect.provide(
      layerTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } }),
    ),
  ),
);

it.effect("creates a fresh session with handoff when every recorded session is dead", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const thread = projection();
    const result = yield* service.plan({
      projection: {
        ...thread,
        providerSessions: [
          deadSessionRecord("dead_session_older", "stopped"),
          deadSessionRecord("dead_session_newer", "error", DateTime.add(now, { seconds: 2 })),
        ],
      },
      targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
    });
    assert.equal(result.transition.type, "create_with_handoff");
    assert.deepEqual(result.releaseProviderSessionIds, []);
  }).pipe(
    Effect.provide(
      layerTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } }),
    ),
  ),
);

function deadNativeThreadProjection(
  status: "stopped" | "error",
  capabilities = capabilitiesWithoutModelSwitch,
): OrchestrationV2ThreadProjection {
  const thread = projection();
  return {
    ...thread,
    thread: {
      ...thread.thread,
      activeProviderThreadId: ProviderThreadId.make("provider-thread:native"),
    },
    providerSessions: [{ ...deadSessionRecord("dead_session", status), capabilities }],
    providerThreads: [
      {
        id: ProviderThreadId.make("provider-thread:native"),
        driver,
        providerInstanceId: currentInstanceId,
        providerSessionId: ProviderSessionId.make("dead_session"),
        appThreadId: thread.thread.id,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:abc",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
  } as OrchestrationV2ThreadProjection;
}

it.effect("falls back to the native provider thread when every recorded session is dead", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service.plan({
      projection: deadNativeThreadProjection("stopped"),
      targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
    });
    assert.equal(result.transition.type, "restart_and_resume");
    assert.deepEqual(result.releaseProviderSessionIds, []);
  }).pipe(
    Effect.provide(
      layerTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } }),
    ),
  ),
);

it.effect("hands off from a native provider thread after its session detaches", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service.plan({
      projection: { ...deadNativeThreadProjection("stopped"), providerSessions: [] },
      targetModelSelection: {
        instanceId: ProviderInstanceId.make("codex_other"),
        model: "gpt-5.2-codex",
      },
    });
    assert.equal(result.transition.type, "create_with_handoff");
    assert.deepEqual(result.releaseProviderSessionIds, []);
  }).pipe(
    Effect.provide(
      layerTest({
        [currentInstanceId]: { continuationKey: "codex:account:primary" },
        codex_other: { continuationKey: "codex:account:other" },
      }),
    ),
  ),
);

it.effect.each(["stopped", "error"] as const)(
  "applies a model change on next turn when a %s session negotiated model switching",
  (deadStatus) =>
    Effect.gen(function* () {
      const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
      const result = yield* service.plan({
        projection: deadNativeThreadProjection(deadStatus, CodexProviderCapabilitiesV2),
        targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
      });
      assert.equal(result.transition.type, "switch_model_in_session");
      assert.deepEqual(result.releaseProviderSessionIds, []);
    }).pipe(
      Effect.provide(
        layerTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } }, (input) =>
          Effect.succeed(acpSelectionTransition(input)),
        ),
      ),
    ),
);

it.effect("rejects a model change the dead record never negotiated support for", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service
      .plan({
        projection: deadNativeThreadProjection("stopped"),
        targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
      })
      .pipe(Effect.flip);
    assert.instanceOf(result, ProviderSwitch.ProviderSwitchPlanError);
  }).pipe(
    Effect.provide(
      layerTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } }, (input) =>
        Effect.succeed(acpSelectionTransition(input)),
      ),
    ),
  ),
);

it.effect("distinguishes compatible and incompatible instances of the same driver", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const compatibleId = ProviderInstanceId.make("codex_compatible");
    const incompatibleId = ProviderInstanceId.make("codex_incompatible");
    const compatible = yield* service.plan({
      projection: projection(),
      targetModelSelection: { instanceId: compatibleId, model: "gpt-5.1-codex" },
    });
    const incompatible = yield* service.plan({
      projection: projection(),
      targetModelSelection: { instanceId: incompatibleId, model: "gpt-5.1-codex" },
    });
    assert.equal(compatible.transition.type, "restart_and_resume");
    assert.equal(incompatible.transition.type, "create_with_handoff");
  }).pipe(
    Effect.provide(
      layerTest({
        [currentInstanceId]: { continuationKey: "codex:account:primary" },
        codex_compatible: { continuationKey: "codex:account:primary" },
        codex_incompatible: { continuationKey: "codex:account:other" },
      }),
    ),
  ),
);

const otherInstanceId = ProviderInstanceId.make("claude_other");
const homeA = "/homes/a";
const homeB = "/homes/b";
const homeKey = (home: string) => `claude:home:${home}`;
const engineBinding = (home: string): OrchestrationV2EngineBinding => ({
  providerInstanceId: currentInstanceId,
  engine: "claude-lhc",
  continuationKey: homeKey(home),
  claudeHome: home,
  compact: null,
  nativeContinuation: "required",
  compaction: "provider",
});
const modelChange = { instanceId: currentInstanceId, model: "gpt-5.2-codex" };
const switchToOther = { instanceId: otherInstanceId, model: "gpt-5.1-codex" };

function boundProjection(input: {
  readonly row?: string;
  readonly seed?: string;
  readonly sessions?: "live" | "stopped";
}): OrchestrationV2ThreadProjection {
  const thread = deadNativeThreadProjection("stopped");
  return {
    ...thread,
    thread: {
      ...thread.thread,
      ...(input.seed === undefined ? {} : { engineBinding: engineBinding(input.seed) }),
    },
    providerSessions: input.sessions === "live" ? projection().providerSessions : [],
    providerThreads: thread.providerThreads.map((row) => ({
      ...row,
      ...(input.row === undefined
        ? {}
        : { nativeMetadata: { engineBinding: engineBinding(input.row) } }),
    })),
  };
}

const isPlanError = Schema.is(ProviderSwitch.ProviderSwitchPlanError);

const planCause = (
  projection: OrchestrationV2ThreadProjection,
  targetModelSelection: typeof modelChange,
) =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const error = yield* service.plan({ projection, targetModelSelection }).pipe(Effect.flip);
    let cause: unknown = error;
    while (isPlanError(cause)) cause = cause.cause;
    assert.isString(cause);
    return cause as string;
  });

const planTransition = (
  projection: OrchestrationV2ThreadProjection,
  targetModelSelection: typeof modelChange,
) =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    return (yield* service.plan({ projection, targetModelSelection })).transition.type;
  });

it.effect("rejects a bound thread whose current instance is missing and names its home", () =>
  Effect.gen(function* () {
    const cause = yield* planCause(boundProjection({ row: homeA, seed: homeA }), modelChange);
    assert.include(cause, `Instance ${currentInstanceId} is missing`);
    assert.include(cause, homeA);
    assert.equal(
      yield* planTransition(boundProjection({ row: homeA, seed: homeA }), switchToOther),
      "create_with_handoff",
    );
  }).pipe(Effect.provide(layerTest({ [otherInstanceId]: { continuationKey: homeKey(homeB) } }))),
);

it.effect("keeps trunk's behavior for an unbound thread whose current instance is missing", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* planCause(boundProjection({}), modelChange),
      "The target provider instance is unavailable.",
    );
    assert.equal(yield* planTransition(boundProjection({}), switchToOther), "create_with_handoff");
  }).pipe(Effect.provide(layerTest({ [otherInstanceId]: { continuationKey: homeKey(homeB) } }))),
);

it.effect("rejects a bound thread whose same-id instance changed home and names both homes", () =>
  Effect.gen(function* () {
    const cause = yield* planCause(
      boundProjection({ row: homeA, seed: homeA, sessions: "live" }),
      modelChange,
    );
    assert.include(cause, `Instance ${currentInstanceId}`);
    assert.include(cause, homeKey(homeB));
    assert.include(cause, homeA);
    assert.equal(
      yield* planTransition(boundProjection({ sessions: "live" }), modelChange),
      "restart_and_resume",
    );
  }).pipe(Effect.provide(layerTest({ [currentInstanceId]: { continuationKey: homeKey(homeB) } }))),
);

it.effect("rejects a bound thread whose instance was deleted and re-added with another home", () =>
  Effect.gen(function* () {
    const cause = yield* planCause(boundProjection({ row: homeA, seed: homeA }), modelChange);
    assert.include(cause, homeKey(homeB));
    assert.include(cause, homeA);
  }).pipe(Effect.provide(layerTest({ [currentInstanceId]: { continuationKey: homeKey(homeB) } }))),
);

it.effect("hands a bound thread off to a live target with another key", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* planTransition(boundProjection({ row: homeA, seed: homeA }), switchToOther),
      "create_with_handoff",
    );
  }).pipe(
    Effect.provide(
      layerTest({
        [currentInstanceId]: { continuationKey: homeKey(homeA) },
        [otherInstanceId]: { continuationKey: homeKey(homeB) },
      }),
    ),
  ),
);

it.effect("resumes a bound row on another instance that uses its home", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* planTransition(boundProjection({ row: homeA, seed: homeA }), switchToOther),
      "restart_and_resume",
    );
  }).pipe(
    Effect.provide(
      layerTest({
        [currentInstanceId]: { continuationKey: homeKey(homeB) },
        [otherInstanceId]: { continuationKey: homeKey(homeA) },
      }),
    ),
  ),
);

it.effect("reads the active row's binding before the thread's seed", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* planTransition(boundProjection({ row: homeA, seed: homeB }), modelChange),
      "restart_and_resume",
    );
    const cause = yield* planCause(boundProjection({ row: homeB, seed: homeA }), modelChange);
    assert.include(cause, homeB);
    assert.notInclude(cause, `home ${homeA}`);
  }).pipe(Effect.provide(layerTest({ [currentInstanceId]: { continuationKey: homeKey(homeA) } }))),
);

it.effect("hands off a lazy fork child that has a seed and no provider row", () =>
  Effect.gen(function* () {
    const child = {
      ...boundProjection({ seed: homeA }),
      providerThreads: [],
    } as OrchestrationV2ThreadProjection;
    assert.equal(
      yield* planTransition(
        { ...child, thread: { ...child.thread, activeProviderThreadId: null } },
        switchToOther,
      ),
      "create_with_handoff",
    );
  }).pipe(
    Effect.provide(
      layerTest({
        [currentInstanceId]: { continuationKey: homeKey(homeA) },
        [otherInstanceId]: { continuationKey: homeKey(homeB) },
      }),
    ),
  ),
);

it.effect("trusts an unbound row and reads a seed only for its own instance", () =>
  Effect.gen(function* () {
    const unboundRow = boundProjection({ sessions: "live" });
    const seeded = (seed: OrchestrationV2EngineBinding, withRow: boolean) =>
      ({
        ...unboundRow,
        thread: {
          ...unboundRow.thread,
          engineBinding: seed,
          ...(withRow ? {} : { activeProviderThreadId: null }),
        },
        providerThreads: withRow ? unboundRow.providerThreads : [],
      }) as OrchestrationV2ThreadProjection;
    const ownSeed = engineBinding(homeA);
    const foreignSeed = { ...ownSeed, providerInstanceId: otherInstanceId };
    assert.equal(yield* planTransition(seeded(ownSeed, true), modelChange), "restart_and_resume");
    assert.equal(
      yield* planTransition(seeded(foreignSeed, false), modelChange),
      "restart_and_resume",
    );
    assert.include(yield* planCause(seeded(ownSeed, false), modelChange), homeA);
  }).pipe(Effect.provide(layerTest({ [currentInstanceId]: { continuationKey: homeKey(homeB) } }))),
);
