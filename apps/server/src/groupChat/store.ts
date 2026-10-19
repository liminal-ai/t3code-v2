import { GroupChatGroup } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

export const MIGRATIONS_TABLE = "group_chat_migrations";

const migrations = Migrator.fromRecord({
  "1_groups": Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        settled_at TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL
      )
    `,
  ),
});

const runMigrations = Migrator.make({});

export interface GroupChatStore {
  readonly groups: Effect.Effect<ReadonlyArray<GroupChatGroup>, SqlError | Schema.SchemaError>;
}

export const storeFile = (path: Path.Path, stateDir: string) =>
  path.join(stateDir, "group-chat", "groupchat.sqlite");

export const open = Effect.fn("groupChat.store.open")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  const sql = Context.get(
    yield* Layer.build(
      NodeSqliteClient.layer({
        filename: file,
        spanAttributes: { "db.name": path.basename(file), "service.name": "t3code-server" },
      }),
    ),
    SqlClient.SqlClient,
  );
  yield* sql`PRAGMA busy_timeout = 5000`;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`PRAGMA journal_mode = WAL`;
  yield* sql`PRAGMA synchronous = NORMAL`;
  yield* runMigrations({ loader: migrations, table: MIGRATIONS_TABLE }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );

  const listGroups = SqlSchema.findAll({
    Request: Schema.Void,
    Result: GroupChatGroup,
    execute: () => sql`
      SELECT
        id,
        title,
        settled_at AS "settledAt",
        created_at AS "createdAt",
        last_activity_at AS "lastActivityAt"
      FROM groups
      ORDER BY last_activity_at DESC
    `,
  });

  return { groups: listGroups(undefined) } satisfies GroupChatStore;
});
