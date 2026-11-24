import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  FORK_SETTINGS_WS_METHODS,
  type LimbaseCompactionPatch,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ForkSettings from "./ForkSettings.ts";
import * as ForkSettingsRpc from "./ForkSettingsRpc.ts";

const limbase = vi.hoisted(() => ({
  held: new Map<string, { trigger: number; target: number }>(),
  refuse: undefined as string | undefined,
}));

vi.mock("@limbase/host-agent-sdk", async (original) => ({
  ...(await original<typeof import("@limbase/host-agent-sdk")>()),
  connectLimbase: async () => ({
    call: async (rpc: (client: unknown) => unknown) =>
      rpc({
        GetThread: ({ threadId }: { threadId: string }) => ({
          threadId,
          createdAt: 0,
          ...(limbase.held.has(threadId) ? { compactPolicy: limbase.held.get(threadId) } : {}),
        }),
        SetCompactPolicy: ({
          threadId,
          compactPolicy,
        }: {
          threadId: string;
          compactPolicy: { trigger: number; target: number };
        }) => {
          if (limbase.refuse !== undefined) throw new Error(limbase.refuse);
          limbase.held.set(threadId, compactPolicy);
          return { threadId, createdAt: 0, compactPolicy };
        },
      }),
    close: async () => {},
  }),
}));

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const LIMBASE = ProviderInstanceId.make("claudeLimbase");
const PLAIN = ProviderInstanceId.make("claudeAgent");
const ON_LIMBASE = ThreadId.make("thread-on-limbase");
const PLAIN_THREAD = ThreadId.make("thread-plain");
const WIDE = ThreadId.make("thread-wide");
const SWITCHED = ThreadId.make("thread-switched");

const reported = (model: string, maxTokens: number) => ({ model, maxTokens });
const threads = {
  [ON_LIMBASE]: {
    instance: LIMBASE,
    limbaseThreadId: "th_rpc",
    model: "claude-sonnet-4-6",
    turns: [reported("claude-sonnet-4-6", 200_000)],
  },
  [PLAIN_THREAD]: {
    instance: PLAIN,
    limbaseThreadId: undefined,
    model: "claude-sonnet-4-5",
    turns: [],
  },
  [WIDE]: {
    instance: LIMBASE,
    limbaseThreadId: "th_wide",
    model: "claude-haiku-5-5[1m]",
    turns: [reported("claude-haiku-5-5", 200_000), reported("claude-haiku-5-5", 1_000_000)],
  },
  [SWITCHED]: {
    instance: LIMBASE,
    limbaseThreadId: "th_switched",
    model: "gateway-model",
    turns: [reported("claude-haiku-5-5", 1_000_000)],
  },
};

const orchestrator = Layer.succeed(OrchestratorV2, {
  getThreadRecords: (threadId: ThreadId) => {
    const thread = threads[threadId as keyof typeof threads]!;
    const row = ProviderThreadId.make(`provider-thread:${threadId}`);
    return Effect.succeed({
      thread: {
        id: threadId,
        providerInstanceId: thread.instance,
        modelSelection: { instanceId: thread.instance, model: thread.model },
        activeProviderThreadId: row,
      },
      providerThreads: [
        {
          id: row,
          contextUsage: null,
          nativeMetadata:
            thread.limbaseThreadId === undefined
              ? null
              : { limbaseThreadId: thread.limbaseThreadId },
        },
      ],
      providerTurns: thread.turns.map((turn) => ({
        providerThreadId: row,
        model: turn.model,
        tokenUsage: { usedTokens: 1, maxTokens: turn.maxTokens },
      })),
    });
  },
} as unknown as OrchestratorV2["Service"]);

const bundledCatalog = Layer.succeed(ModelCatalog.ModelCatalog, {
  current: () => Effect.undefined,
  bundled: () => undefined,
  refreshInBackground: Effect.void,
});

const handlers = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "limbase-home-" });
  yield* fileSystem.makeDirectory(path.join(home, "config"));
  yield* fileSystem.writeFileString(
    path.join(home, "config", "membase.json"),
    JSON.stringify({ socketPath: path.join(home, "limbase.sock") }),
  );
  const settings = ServerSettings.layerTest({
    providerInstances: {
      [LIMBASE]: { driver: CLAUDE, config: { limbaseHome: home } },
      [PLAIN]: { driver: CLAUDE, config: {} },
    },
  });
  return yield* ForkSettingsRpc.wsHandlers.pipe(
    Effect.provide(
      Layer.mergeAll(ForkSettings.layer, orchestrator, bundledCatalog).pipe(
        Layer.provideMerge(settings),
      ),
    ),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, SqlitePersistence.layerMemory))(
  "ForkSettingsRpc",
  (it) => {
    it.effect("shows the Limbase group only on a Limbase thread, seeded from its instance", () =>
      Effect.gen(function* () {
        const rpc = yield* handlers;
        limbase.held.set("th_rpc", { trigger: 700_000, target: 100_000 });
        assert.deepEqual(
          yield* rpc[FORK_SETTINGS_WS_METHODS.getThread]({ threadId: PLAIN_THREAD }),
          {},
        );
        const view = (yield* rpc[FORK_SETTINGS_WS_METHODS.getThread]({ threadId: ON_LIMBASE }))
          .limbaseCompaction;
        assert.deepInclude(view, {
          value: {},
          instance: { compactAt: { tokens: 700_000 }, downTo: { tokens: 100_000 } },
          contextWindow: 200_000,
          profile: "standard",
          applied: { trigger: 700_000, target: 100_000 },
        });
        assert.deepEqual(
          yield* rpc[FORK_SETTINGS_WS_METHODS.getInstance]({ instanceId: PLAIN }),
          {},
        );
      }),
    );

    it.effect("gives the card the window Claude reported for its model at the last turn", () =>
      Effect.gen(function* () {
        const rpc = yield* handlers;
        const windowOf = (threadId: ThreadId) =>
          rpc[FORK_SETTINGS_WS_METHODS.getThread]({ threadId }).pipe(
            Effect.map((view) => view.limbaseCompaction?.contextWindow),
          );
        assert.equal(yield* windowOf(WIDE), 1_000_000);
        assert.isNull(yield* windowOf(SWITCHED), "a turn on another model gives no window");
      }),
    );

    it.effect(
      "saves only the fields a write names, and returns a guard's or Limbase's refusal",
      () =>
        Effect.gen(function* () {
          const rpc = yield* handlers;
          const set = (limbaseCompaction: LimbaseCompactionPatch) =>
            rpc[FORK_SETTINGS_WS_METHODS.setThread]({
              threadId: ON_LIMBASE,
              settings: { limbaseCompaction },
            });
          yield* set({ compactAt: null, downTo: null });
          const saved = yield* set({ compactAt: { percent: 75 } });
          assert.deepEqual(saved.limbaseCompaction?.applied, { trigger: 150_000, target: 100_000 });
          const both = yield* set({ downTo: { tokens: 60_000 } });
          assert.deepEqual(both.limbaseCompaction?.value, {
            compactAt: { percent: 75 },
            downTo: { tokens: 60_000 },
          });
          assert.deepEqual(both.limbaseCompaction?.applied, { trigger: 150_000, target: 60_000 });
          const guard = yield* Effect.flip(set({ downTo: { tokens: 160_000 } }));
          assert.equal(guard.message, "Down to (160k) must be below compact at (75%).");
          limbase.refuse = "limbase call failed: StoreUnavailable";
          const refused = yield* Effect.flip(set({ downTo: { tokens: 50_000 } }));
          limbase.refuse = undefined;
          assert.equal(
            refused.message,
            "Limbase: the service refused the compaction policy (limbase call failed: StoreUnavailable)",
          );
          const after = yield* rpc[FORK_SETTINGS_WS_METHODS.getThread]({ threadId: ON_LIMBASE });
          assert.deepEqual(after.limbaseCompaction?.value, {
            compactAt: { percent: 75 },
            downTo: { tokens: 60_000 },
          });
          const cleared = yield* set({ compactAt: null });
          assert.deepEqual(cleared.limbaseCompaction?.value, { downTo: { tokens: 60_000 } });

          const instance = (limbaseCompaction: LimbaseCompactionPatch) =>
            rpc[FORK_SETTINGS_WS_METHODS.setInstance]({
              instanceId: LIMBASE,
              settings: { limbaseCompaction },
            }).pipe(Effect.map((view) => view.limbaseCompaction?.value));
          assert.deepEqual(yield* instance({ compactAt: { tokens: 640_000 } }), {
            compactAt: { tokens: 640_000 },
            downTo: { tokens: 100_000 },
          });
          assert.deepEqual(yield* instance({ downTo: { tokens: 95_000 } }), {
            compactAt: { tokens: 640_000 },
            downTo: { tokens: 95_000 },
          });

          const plain = yield* Effect.flip(
            rpc[FORK_SETTINGS_WS_METHODS.setThread]({
              threadId: PLAIN_THREAD,
              settings: { limbaseCompaction: {} },
            }),
          );
          assert.equal(
            plain.message,
            "Limbase compaction applies only to a thread on a Limbase instance.",
          );
        }),
    );
  },
);
