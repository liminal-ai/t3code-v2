import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, GroupChatUnavailable, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { GroupChat, layer as groupChatLayer } from "./layer.ts";
import { MIGRATIONS_TABLE, migrations, open, type StoreEvent, storeFile } from "./store.ts";
import * as Migrator from "effect/sql/Migrator";
import { layerNeverPort } from "./testkit.ts";

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
        Layer.provide(layerNeverPort),
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
        [
          "1_groups",
          "2_members_messages_deliveries_discussions",
          "3_lanes",
          "4_cancels",
          "5_cancel_in_flight",
          "6_external_members",
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("two concurrent commands on one row publish in commit order", () =>
    Effect.gen(function* () {
      const { file } = yield* setup;
      const store = yield* open(file);
      const member = yield* store.transaction((tx) =>
        Effect.flatMap(tx.createGroup("ordered"), (group) =>
          tx.addMember({
            groupId: group.id,
            handle: "alpha",
            color: 0,
            source: {
              _tag: "t3",
              thread: {
                environmentId: EnvironmentId.make("env"),
                threadId: ThreadId.make("alpha"),
                title: "Alpha",
              },
            },
          }),
        ),
      );
      const subscription = yield* PubSub.subscribe(store.changes);
      // Frequent yields let a transaction that has committed but is still publishing be overtaken
      // by the one waiting behind it, which commits and publishes in between.
      yield* Effect.all(
        [
          store.transaction((tx) =>
            Effect.forEach(Array.from({ length: 200 }), () => tx.touchMember(member.id), {
              discard: true,
            }),
          ),
          store.transaction((tx) => tx.updateMember(member.id, { handle: "renamed" })),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16));
      const events: StoreEvent[] = [];
      while (events.length < 201) events.push(yield* PubSub.take(subscription));
      const members = events.flatMap((e) => (e.change._tag === "member" ? [e] : []));
      const renamed = members.findIndex(
        (e) => e.change._tag === "member" && e.change.member.handle === "renamed",
      );
      assert.strictEqual(members.length, 201);
      assert.strictEqual(renamed, 200, "the rename committed last, so it is published last");
      assert.isTrue(members.every((e, i) => i === 0 || e.seq > members[i - 1]!.seq));
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
      assert.strictEqual((yield* recordedMigrations(file)).length, 6);
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

  it.effect(
    "upgrades a populated pre-GC6 database without losing members, messages or deliveries",
    () =>
      Effect.gen(function* () {
        const { fileSystem, file } = yield* setup;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
        const legacy = Object.fromEntries(
          Object.entries(migrations).filter(([name]) => !name.startsWith("6_")),
        );
        yield* withFile(file, (sql) =>
          Effect.gen(function* () {
            yield* Migrator.make({})({
              loader: Migrator.fromRecord(legacy),
              table: MIGRATIONS_TABLE,
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            yield* sql`
            INSERT INTO groups (id, title, settled_at, created_at, last_activity_at) VALUES
              ('grp_1', 'Crew', NULL, '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z')
          `;
            yield* sql`
            INSERT INTO members (
              id, group_id, handle, handle_history_json, color, environment_id, thread_id,
              thread_title, seen_seq, introduced, told_roster_json, added_at, removed_at
            ) VALUES
              ('mem_a', 'grp_1', 'alpha', '["alph"]', 0, 'env', 'thr_a', 'Alpha', 3, 1,
               '{"mem_a":"alpha","mem_b":"bravo"}', '2026-10-01T00:00:01.000Z', NULL),
              ('mem_b', 'grp_1', 'bravo', '[]', 1, 'env', 'thr_b', 'Bravo', 0, 0, NULL,
               '2026-10-01T00:00:02.000Z', '2026-10-01T00:05:00.000Z')
          `;
            yield* sql`
            INSERT INTO messages (
              id, group_id, seq, author_json, kind, text, display_text, recipients_json, turn_key,
              trigger_message_id, discussion_id, round, sign_off, late, created_at
            ) VALUES
              ('msg_1', 'grp_1', 1, '{"_tag":"operator"}', 'chat', 'hello', 'hello', '["mem_a"]',
               'msg_1', NULL, NULL, NULL, 0, 0, '2026-10-01T00:01:00.000Z'),
              ('msg_2', 'grp_1', 2, '{"_tag":"member","memberId":"mem_a"}', 'reply', 'hi', 'hi',
               '[]', 'msg_1', 'msg_1', NULL, NULL, 0, 0, '2026-10-01T00:02:00.000Z')
          `;
            yield* sql`
            INSERT INTO deliveries (
              id, group_id, member_id, trigger_message_id, turn_key, discussion_id, round, state,
              dispatch, attempt, envelope, from_seq, to_seq, run_id, message_id, sent_text,
              wait_json, withdrawn, reply_message_id, error, roster_json, created_at, updated_at
            ) VALUES
              ('dlv_1', 'grp_1', 'mem_a', 'msg_1', 'msg_1', NULL, NULL, 'replied', 'accepted', 1,
               'the envelope', 1, 1, 'run:1', 'message:group-chat:1', NULL, NULL, NULL, 'msg_2',
               NULL, '{"mem_a":"alpha"}', '2026-10-01T00:01:01.000Z', '2026-10-01T00:02:00.000Z'),
              ('dlv_2', 'grp_1', 'mem_b', 'msg_1', 'msg_1', NULL, NULL, 'cancelled', 'unsent', 1,
               '', 0, 1, NULL, NULL, NULL, NULL, 'member removed', NULL, 'member removed', NULL,
               '2026-10-01T00:01:01.000Z', '2026-10-01T00:05:00.000Z')
          `;
            yield* sql`INSERT INTO lanes (thread_id, paused_at) VALUES ('thr_a', '2026-10-01T00:03:00.000Z')`;
          }),
        );
        assert.strictEqual((yield* recordedMigrations(file)).length, 5);

        const store = yield* open(file);
        assert.strictEqual((yield* recordedMigrations(file)).length, 6);
        const members = yield* store.members("grp_1" as never, true);
        // Brands drop out through JSON, so the literals below can be plain strings.
        const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
        assert.deepStrictEqual(
          plain(
            members.map((m) => ({
              id: m.id,
              handle: m.handle,
              handleHistory: m.handleHistory,
              color: m.color,
              seenSeq: m.seenSeq,
              introduced: m.introduced,
              removedAt: m.removedAt,
              kind: m.kind,
            })),
          ),
          [
            {
              id: "mem_a",
              handle: "alpha",
              handleHistory: ["alph"],
              color: 0,
              seenSeq: 3,
              introduced: true,
              removedAt: null,
              kind: {
                _tag: "t3",
                thread: { environmentId: "env", threadId: "thr_a", title: "Alpha" },
              },
            },
            {
              id: "mem_b",
              handle: "bravo",
              handleHistory: [],
              color: 1,
              seenSeq: 0,
              introduced: false,
              removedAt: "2026-10-01T00:05:00.000Z",
              kind: {
                _tag: "t3",
                thread: { environmentId: "env", threadId: "thr_b", title: "Bravo" },
              },
            },
          ],
        );
        assert.deepStrictEqual(members[0]!.toldRoster, { mem_a: "alpha", mem_b: "bravo" });
        assert.isNull(members[0]!.external);
        assert.strictEqual((yield* store.messages("grp_1" as never)).length, 2);
        const deliveries = yield* store.deliveriesOfThread("thr_a" as never);
        assert.deepStrictEqual(
          plain(
            deliveries.map((d) => ({
              id: d.id,
              state: d.state,
              replyMessageId: d.replyMessageId,
              external: d.external,
              roster: d.roster,
            })),
          ),
          [
            {
              id: "dlv_1",
              state: "replied",
              replyMessageId: "msg_2",
              external: null,
              roster: { mem_a: "alpha" },
            },
          ],
        );
        assert.strictEqual((yield* store.deliveriesOfGroup("grp_1" as never)).length, 2);
        assert.strictEqual(
          (yield* store.memberByThread("grp_1" as never, "thr_b" as never)).length,
          1,
        );
        assert.isTrue(yield* store.lanePaused("thr_a" as never));
      }).pipe(Effect.scoped),
  );
});
