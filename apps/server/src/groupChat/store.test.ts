import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GroupChatUnavailable } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { GroupChat, layer as groupChatLayer } from "./layer.ts";
import { MIGRATIONS_TABLE, open, storeFile } from "./store.ts";

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-group-chat-store-" });
  return { fileSystem, baseDir, file: storeFile(path, path.join(baseDir, "userdata")) };
});

const withFile = <A, E>(file: string, body: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(NodeSqliteClient.layer({ filename: file })), (context) =>
      body(Context.get(context, SqlClient.SqlClient)),
    ),
  );

const recordedMigrations = (file: string) =>
  withFile(
    file,
    (sql) =>
      sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(MIGRATIONS_TABLE)}
    `,
  );

const openModule = (baseDir: string) =>
  Effect.flatMap(Effect.service(GroupChat), (groupChat) => Effect.flip(groupChat.store)).pipe(
    Effect.provide(
      groupChatLayer.pipe(
        Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      ),
    ),
  );

it.layer(NodeServices.layer)("group chat store", (it) => {
  it.effect("migrates a fresh file", () =>
    Effect.gen(function* () {
      const { file } = yield* setup;
      const groups = yield* Effect.scoped(Effect.flatMap(open(file), (store) => store.groups));
      assert.deepStrictEqual(groups, []);
      const [mode] = yield* withFile(
        file,
        (sql) => sql<{ journal_mode: string }>`PRAGMA journal_mode`,
      );
      assert.strictEqual(mode?.journal_mode, "wal");
      assert.deepStrictEqual(
        (yield* recordedMigrations(file)).map((row) => `${row.migration_id}_${row.name}`),
        ["1_groups", "2_members_messages_deliveries_discussions"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reopens a migrated file without running a migration twice", () =>
    Effect.gen(function* () {
      const { file } = yield* setup;
      yield* Effect.scoped(open(file));
      yield* withFile(
        file,
        (sql) => sql`
          INSERT INTO groups (id, title, settled_at, created_at, last_activity_at) VALUES
            ('older', 'Older', NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
            ('newer', 'Newer', '2026-10-03T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z')
        `,
      );
      const groups = yield* Effect.scoped(Effect.flatMap(open(file), (store) => store.groups));
      assert.deepStrictEqual(
        groups.map((group) => [group.id, group.settledAt]),
        [
          ["newer", "2026-10-03T00:00:00.000Z"],
          ["older", null],
        ],
      );
      assert.strictEqual((yield* recordedMigrations(file)).length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("a corrupt file makes the module unavailable and the layer still builds", () =>
    Effect.gen(function* () {
      const { fileSystem, baseDir, file } = yield* setup;
      yield* Effect.scoped(open(file));
      yield* fileSystem.writeFile(
        file,
        new Uint8Array(4096).map((_, index) => (index * 131 + 7) % 256),
      );
      yield* fileSystem.remove(`${file}-wal`).pipe(Effect.ignore);
      yield* fileSystem.remove(`${file}-shm`).pipe(Effect.ignore);
      const failure = yield* openModule(baseDir);
      assert.deepStrictEqual(failure, new GroupChatUnavailable({ reason: "store_unavailable" }));
    }).pipe(Effect.scoped),
  );
});
