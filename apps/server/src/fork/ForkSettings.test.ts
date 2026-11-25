import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ForkSettings from "./ForkSettings.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const LIMBASE = ProviderInstanceId.make("claudeLimbase");
const PLAIN = ProviderInstanceId.make("claudeAgent");
const LATER = ProviderInstanceId.make("claudeLimbaseLater");
const THREAD = ThreadId.make("thread-settings-test");

const started = (instances: Record<string, { readonly limbaseHome?: string }>) =>
  ForkSettings.layer.pipe(
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: Object.fromEntries(
          Object.entries(instances).map(([id, config]) => [id, { driver: CLAUDE, config }]),
        ),
      }),
    ),
  );

const withStore = <A, E>(
  instances: Record<string, { readonly limbaseHome?: string }>,
  use: (store: ForkSettings.ForkSettingsStore["Service"]) => Effect.Effect<A, E>,
) => Effect.flatMap(ForkSettings.ForkSettingsStore, use).pipe(Effect.provide(started(instances)));

const instance = (id: ProviderInstanceId) => ({ scope: "instance", id }) as const;

it.layer(SqlitePersistence.layerMemory)("ForkSettings", (it) => {
  it.effect(
    "keeps 700k/100k on the Limbase instances of the first start, and on no later one",
    () =>
      Effect.gen(function* () {
        const first = { [LIMBASE]: { limbaseHome: "~/limbase" }, [PLAIN]: {} };
        yield* withStore(first, (store) =>
          Effect.gen(function* () {
            assert.deepEqual(yield* store.read(instance(LIMBASE)), {
              limbaseCompaction: { compactAt: { tokens: 700_000 }, downTo: { tokens: 100_000 } },
            });
            assert.deepEqual(yield* store.read(instance(PLAIN)), {});
            yield* store.write(instance(LIMBASE), { limbaseCompaction: {} });
          }),
        );
        const later = { ...first, [LATER]: { limbaseHome: "~/limbase-later" } };
        yield* withStore(later, (store) =>
          Effect.gen(function* () {
            assert.deepEqual(yield* store.read(instance(LIMBASE)), {});
            assert.deepEqual(yield* store.read(instance(LATER)), {});
          }),
        );
      }),
  );

  it.effect("replaces the groups a write names, keeps groups it does not know, and clears", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stored = sql<{ readonly settings: string }>`
        SELECT settings_json AS settings FROM fork_settings WHERE owner_id = ${THREAD}
      `.pipe(Effect.map((rows) => rows.map((row) => JSON.parse(row.settings))));
      yield* withStore({}, (store) =>
        Effect.gen(function* () {
          const thread = { scope: "thread", id: THREAD } as const;
          yield* sql`
            INSERT INTO fork_settings (scope, owner_id, settings_json, updated_at)
            VALUES ('thread', ${THREAD}, '{"laterFeature":{"on":true}}', '')
          `;
          yield* store.write(thread, { limbaseCompaction: { downTo: { percent: 10 } } });
          assert.deepEqual(yield* store.read(thread), {
            limbaseCompaction: { downTo: { percent: 10 } },
          });
          assert.deepEqual(yield* stored, [
            { laterFeature: { on: true }, limbaseCompaction: { downTo: { percent: 10 } } },
          ]);
          yield* store.write(thread, { limbaseCompaction: {} });
          assert.deepEqual(yield* store.read(thread), {});
          assert.deepEqual(yield* stored, [{ laterFeature: { on: true } }]);
        }),
      );
    }),
  );
});
