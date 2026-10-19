import {
  EnvironmentId,
  GroupChatAuthor,
  type GroupChatDelivery,
  GroupChatDeliveryId,
  GroupChatDeliveryState,
  GroupChatDiscussion,
  GroupChatDiscussionId,
  GroupChatDiscussionState,
  GroupChatDispatchState,
  GroupChatGroup,
  GroupChatGroupId,
  GroupChatMember,
  GroupChatMemberId,
  GroupChatMessage,
  GroupChatMessageId,
  GroupChatMessageKind,
  GroupChatWait,
  IsoDateTime,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as Statement from "effect/sql/Statement";

import { newId } from "./domain.ts";

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
  "2_members_messages_deliveries_discussions": Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE members (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          handle TEXT NOT NULL,
          handle_history_json TEXT NOT NULL DEFAULT '[]',
          color INTEGER NOT NULL,
          environment_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          thread_title TEXT NOT NULL,
          seen_seq INTEGER NOT NULL DEFAULT 0,
          introduced INTEGER NOT NULL DEFAULT 0,
          told_roster_json TEXT,
          added_at TEXT NOT NULL,
          removed_at TEXT
        )
      `;
      yield* sql`CREATE INDEX members_group ON members(group_id)`;
      yield* sql`CREATE INDEX members_thread ON members(thread_id)`;
      yield* sql`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          author_json TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          display_text TEXT NOT NULL,
          recipients_json TEXT NOT NULL,
          turn_key TEXT NOT NULL,
          trigger_message_id TEXT,
          discussion_id TEXT,
          round INTEGER,
          sign_off INTEGER NOT NULL DEFAULT 0,
          late INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          UNIQUE(group_id, seq)
        )
      `;
      yield* sql`
        CREATE TABLE deliveries (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL,
          trigger_message_id TEXT NOT NULL,
          turn_key TEXT NOT NULL,
          discussion_id TEXT,
          round INTEGER,
          state TEXT NOT NULL,
          dispatch TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 1,
          envelope TEXT NOT NULL DEFAULT '',
          from_seq INTEGER NOT NULL DEFAULT 0,
          to_seq INTEGER NOT NULL,
          run_id TEXT,
          message_id TEXT,
          sent_text TEXT,
          wait_json TEXT,
          withdrawn TEXT,
          reply_message_id TEXT,
          error TEXT,
          roster_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE UNIQUE INDEX deliveries_unique
        ON deliveries(trigger_message_id, member_id, COALESCE(round, 0))
      `;
      yield* sql`CREATE INDEX deliveries_state ON deliveries(state)`;
      yield* sql`CREATE INDEX deliveries_member ON deliveries(member_id)`;
      yield* sql`
        CREATE TABLE discussions (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          participants_json TEXT NOT NULL,
          topic TEXT NOT NULL,
          max_rounds INTEGER NOT NULL,
          round INTEGER NOT NULL,
          state TEXT NOT NULL,
          end_reason TEXT,
          prompt_message_id TEXT NOT NULL,
          signed_off_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          ended_at TEXT
        )
      `;
    }),
  ),
  "3_lanes": Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      CREATE TABLE lanes (
        thread_id TEXT PRIMARY KEY,
        paused_at TEXT NOT NULL
      )
    `,
  ),
  "4_cancels": Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      CREATE TABLE cancels (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT,
        message_id TEXT,
        created_at TEXT NOT NULL
      )
    `,
  ),
});

const runMigrations = Migrator.make({});

const Roster = Schema.Record(Schema.String, Schema.String);
const SignedOff = Schema.Record(Schema.String, Schema.Int);

const MemberRow = Schema.Struct({
  id: GroupChatMemberId,
  groupId: GroupChatGroupId,
  handle: Schema.String,
  handleHistory: Schema.fromJsonString(Schema.Array(Schema.String)),
  color: Schema.Int,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  threadTitle: Schema.String,
  seenSeq: Schema.Int,
  introduced: Schema.BooleanFromBit,
  toldRoster: Schema.NullOr(Schema.fromJsonString(Roster)),
  addedAt: IsoDateTime,
  removedAt: Schema.NullOr(IsoDateTime),
});

const MessageRow = Schema.Struct({
  id: GroupChatMessageId,
  groupId: GroupChatGroupId,
  seq: Schema.Int,
  author: Schema.fromJsonString(GroupChatAuthor),
  kind: GroupChatMessageKind,
  text: Schema.String,
  displayText: Schema.String,
  recipients: Schema.fromJsonString(Schema.Array(GroupChatMemberId)),
  turnKey: Schema.String,
  triggerMessageId: Schema.NullOr(GroupChatMessageId),
  discussionId: Schema.NullOr(GroupChatDiscussionId),
  round: Schema.NullOr(Schema.Int),
  signOff: Schema.BooleanFromBit,
  late: Schema.BooleanFromBit,
  createdAt: IsoDateTime,
});

const DeliveryRow = Schema.Struct({
  id: GroupChatDeliveryId,
  groupId: GroupChatGroupId,
  memberId: GroupChatMemberId,
  triggerMessageId: GroupChatMessageId,
  turnKey: Schema.String,
  discussionId: Schema.NullOr(GroupChatDiscussionId),
  round: Schema.NullOr(Schema.Int),
  state: GroupChatDeliveryState,
  dispatch: GroupChatDispatchState,
  attempt: Schema.Int,
  envelope: Schema.String,
  fromSeq: Schema.Int,
  toSeq: Schema.Int,
  runId: Schema.NullOr(RunId),
  messageId: Schema.NullOr(MessageId),
  sentText: Schema.NullOr(Schema.String),
  wait: Schema.NullOr(Schema.fromJsonString(GroupChatWait)),
  withdrawn: Schema.NullOr(Schema.String),
  replyMessageId: Schema.NullOr(GroupChatMessageId),
  error: Schema.NullOr(Schema.String),
  roster: Schema.NullOr(Schema.fromJsonString(Roster)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DeliveryRow = typeof DeliveryRow.Type;

const DiscussionRow = Schema.Struct({
  id: GroupChatDiscussionId,
  groupId: GroupChatGroupId,
  participants: Schema.fromJsonString(Schema.Array(GroupChatMemberId)),
  topic: Schema.String,
  maxRounds: Schema.Int,
  round: Schema.Int,
  state: GroupChatDiscussionState,
  endReason: Schema.NullOr(Schema.String),
  promptMessageId: GroupChatMessageId,
  signedOff: Schema.fromJsonString(SignedOff),
  createdAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});

const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeRoster = Schema.encodeSync(Schema.fromJsonString(Roster));
const encodeAuthor = Schema.encodeSync(Schema.fromJsonString(GroupChatAuthor));
const encodeMemberIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(GroupChatMemberId)));
const encodeWait = Schema.encodeSync(Schema.fromJsonString(GroupChatWait));
const encodeSignedOff = Schema.encodeSync(Schema.fromJsonString(SignedOff));

export type StoreChange =
  | { readonly _tag: "group"; readonly group: GroupChatGroup }
  | { readonly _tag: "group.deleted"; readonly groupId: GroupChatGroupId }
  | { readonly _tag: "member"; readonly member: GroupChatMember }
  | { readonly _tag: "message"; readonly message: GroupChatMessage }
  | { readonly _tag: "delivery"; readonly delivery: DeliveryRow }
  | { readonly _tag: "discussion"; readonly discussion: GroupChatDiscussion };

export interface StoreEvent {
  readonly seq: number;
  readonly change: StoreChange;
}

export interface NewMessage {
  readonly groupId: GroupChatGroupId;
  readonly author: GroupChatAuthor;
  readonly kind: GroupChatMessageKind;
  readonly text: string;
  readonly displayText: string;
  readonly recipients?: ReadonlyArray<GroupChatMemberId>;
  readonly turnKey?: string;
  readonly triggerMessageId?: GroupChatMessageId | null;
  readonly discussionId?: GroupChatDiscussionId | null;
  readonly round?: number | null;
  readonly signOff?: boolean;
  readonly late?: boolean;
}

export interface NewDelivery {
  readonly groupId: GroupChatGroupId;
  readonly memberId: GroupChatMemberId;
  readonly triggerMessageId: GroupChatMessageId;
  readonly turnKey: string;
  readonly discussionId: GroupChatDiscussionId | null;
  readonly round: number | null;
  readonly toSeq: number;
  readonly wait: GroupChatWait | null;
}

export interface MemberPatch {
  readonly handle?: string;
  readonly color?: number;
  readonly threadTitle?: string;
  readonly seenSeq?: number;
  readonly introduced?: boolean;
  readonly toldRoster?: Record<string, string>;
  readonly removed?: boolean;
}

export type DeliveryPatch = Partial<
  Pick<
    DeliveryRow,
    | "state"
    | "dispatch"
    | "attempt"
    | "envelope"
    | "fromSeq"
    | "runId"
    | "messageId"
    | "sentText"
    | "wait"
    | "withdrawn"
    | "replyMessageId"
    | "error"
    | "roster"
  >
>;

export type DiscussionPatch = Partial<
  Pick<GroupChatDiscussion, "round" | "state" | "endReason" | "signedOff">
>;

/**
 * A queued envelope group chat must take back out of a thread, by its run id, or by the derived
 * id of the message a dispatch was still sending. The row outlives the delivery, so a group
 * deleted or a Stop pressed just before a crash still gets its envelope cancelled at the next boot.
 */
const CancelRow = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  messageId: Schema.NullOr(MessageId),
});
export type CancelRow = typeof CancelRow.Type;

export type NewCancel =
  | { readonly threadId: ThreadId; readonly runId: RunId }
  | { readonly threadId: ThreadId; readonly messageId: MessageId };

export type StoreError = SqlError | Schema.SchemaError;

export interface Reads {
  readonly groups: Effect.Effect<ReadonlyArray<GroupChatGroup>, StoreError>;
  readonly group: (id: GroupChatGroupId) => Effect.Effect<GroupChatGroup | null, StoreError>;
  readonly members: (
    groupId: GroupChatGroupId,
    includeRemoved: boolean,
  ) => Effect.Effect<ReadonlyArray<GroupChatMember>, StoreError>;
  readonly activeMembers: Effect.Effect<ReadonlyArray<GroupChatMember>, StoreError>;
  readonly member: (id: GroupChatMemberId) => Effect.Effect<GroupChatMember | null, StoreError>;
  readonly memberByThread: (
    groupId: GroupChatGroupId,
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<GroupChatMember>, StoreError>;
  readonly messages: (
    groupId: GroupChatGroupId,
    afterSeq?: number,
  ) => Effect.Effect<ReadonlyArray<GroupChatMessage>, StoreError>;
  readonly message: (id: GroupChatMessageId) => Effect.Effect<GroupChatMessage | null, StoreError>;
  readonly delivery: (id: GroupChatDeliveryId) => Effect.Effect<DeliveryRow | null, StoreError>;
  readonly deliveriesOfGroup: (
    groupId: GroupChatGroupId,
  ) => Effect.Effect<ReadonlyArray<DeliveryRow>, StoreError>;
  readonly deliveriesOfMember: (
    memberId: GroupChatMemberId,
  ) => Effect.Effect<ReadonlyArray<DeliveryRow>, StoreError>;
  readonly deliveriesOfThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<DeliveryRow>, StoreError>;
  readonly deliveriesOfRound: (
    discussionId: GroupChatDiscussionId,
    round: number,
  ) => Effect.Effect<ReadonlyArray<DeliveryRow>, StoreError>;
  readonly openDeliveries: Effect.Effect<ReadonlyArray<DeliveryRow>, StoreError>;
  readonly lanePaused: (threadId: ThreadId) => Effect.Effect<boolean, StoreError>;
  readonly pendingCancels: Effect.Effect<ReadonlyArray<CancelRow>, StoreError>;
  readonly discussion: (
    id: GroupChatDiscussionId,
  ) => Effect.Effect<GroupChatDiscussion | null, StoreError>;
  readonly discussionsOfGroup: (
    groupId: GroupChatGroupId,
  ) => Effect.Effect<ReadonlyArray<GroupChatDiscussion>, StoreError>;
  readonly runningDiscussions: Effect.Effect<ReadonlyArray<GroupChatDiscussion>, StoreError>;
}

export interface Writes {
  readonly createGroup: (title: string) => Effect.Effect<GroupChatGroup, StoreError>;
  readonly updateGroup: (
    id: GroupChatGroupId,
    patch: { readonly title?: string; readonly settled?: boolean },
  ) => Effect.Effect<GroupChatGroup, StoreError>;
  readonly deleteGroup: (id: GroupChatGroupId) => Effect.Effect<void, StoreError>;
  readonly addMember: (input: {
    readonly groupId: GroupChatGroupId;
    readonly handle: string;
    readonly color: number;
    readonly thread: GroupChatMember["thread"];
  }) => Effect.Effect<GroupChatMember, StoreError>;
  readonly updateMember: (
    id: GroupChatMemberId,
    patch: MemberPatch,
  ) => Effect.Effect<GroupChatMember, StoreError>;
  readonly touchMember: (id: GroupChatMemberId) => Effect.Effect<void, StoreError>;
  readonly pauseLane: (threadId: ThreadId) => Effect.Effect<void, StoreError>;
  readonly resumeLane: (threadId: ThreadId) => Effect.Effect<void, StoreError>;
  readonly insertCancel: (input: NewCancel) => Effect.Effect<void, StoreError>;
  readonly deleteCancel: (id: string) => Effect.Effect<void, StoreError>;
  readonly appendMessage: (input: NewMessage) => Effect.Effect<GroupChatMessage, StoreError>;
  readonly insertDelivery: (input: NewDelivery) => Effect.Effect<DeliveryRow, StoreError>;
  readonly updateDelivery: (
    id: GroupChatDeliveryId,
    patch: DeliveryPatch,
  ) => Effect.Effect<DeliveryRow, StoreError>;
  readonly insertDiscussion: (
    input: Omit<GroupChatDiscussion, "createdAt" | "endedAt">,
  ) => Effect.Effect<GroupChatDiscussion, StoreError>;
  readonly updateDiscussion: (
    id: GroupChatDiscussionId,
    patch: DiscussionPatch,
  ) => Effect.Effect<GroupChatDiscussion, StoreError>;
}

export type Tx = Reads & Writes;

export interface GroupChatStore extends Reads {
  readonly transaction: <A, E>(
    body: (tx: Tx) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | StoreError>;
  readonly changes: PubSub.PubSub<StoreEvent>;
}

export const storeFile = (path: Path.Path, stateDir: string) =>
  path.join(stateDir, "group-chat", "groupchat.sqlite");

const toMember = (row: typeof MemberRow.Type): GroupChatMember => ({
  id: row.id,
  groupId: row.groupId,
  handle: row.handle,
  handleHistory: row.handleHistory,
  color: row.color,
  thread: { environmentId: row.environmentId, threadId: row.threadId, title: row.threadTitle },
  seenSeq: row.seenSeq,
  introduced: row.introduced,
  toldRoster: row.toldRoster,
  addedAt: row.addedAt,
  removedAt: row.removedAt,
});

const OPEN_STATES: ReadonlyArray<GroupChatDelivery["state"]> = ["pending", "queued", "running"];

const makeReads = (sql: SqlClient.SqlClient): Reads => {
  const groupRows = SqlSchema.findAll({
    Request: Schema.Struct({ id: Schema.NullOr(GroupChatGroupId) }),
    Result: GroupChatGroup,
    execute: ({ id }) => sql`
      SELECT id, title, settled_at AS "settledAt", created_at AS "createdAt",
        last_activity_at AS "lastActivityAt"
      FROM groups
      WHERE ${id === null ? sql`1` : sql`id = ${id}`}
      ORDER BY last_activity_at DESC
    `,
  });
  const memberRows = SqlSchema.findAll({
    Request: Schema.Struct({ where: Schema.Any }),
    Result: MemberRow,
    execute: ({ where }) => sql`
      SELECT id, group_id AS "groupId", handle, handle_history_json AS "handleHistory", color,
        environment_id AS "environmentId", thread_id AS "threadId", thread_title AS "threadTitle",
        seen_seq AS "seenSeq", introduced, told_roster_json AS "toldRoster",
        added_at AS "addedAt", removed_at AS "removedAt"
      FROM members
      WHERE ${where as Statement.Fragment}
      ORDER BY added_at, rowid
    `,
  });
  const messageRows = SqlSchema.findAll({
    Request: Schema.Struct({ where: Schema.Any }),
    Result: MessageRow,
    execute: ({ where }) => sql`
      SELECT id, group_id AS "groupId", seq, author_json AS author, kind, text,
        display_text AS "displayText", recipients_json AS recipients, turn_key AS "turnKey",
        trigger_message_id AS "triggerMessageId", discussion_id AS "discussionId", round,
        sign_off AS "signOff", late, created_at AS "createdAt"
      FROM messages
      WHERE ${where as Statement.Fragment}
      ORDER BY seq
    `,
  });
  const deliveryRows = SqlSchema.findAll({
    Request: Schema.Struct({ where: Schema.Any }),
    Result: DeliveryRow,
    execute: ({ where }) => sql`
      SELECT id, group_id AS "groupId", member_id AS "memberId",
        trigger_message_id AS "triggerMessageId", turn_key AS "turnKey",
        discussion_id AS "discussionId", round, state, dispatch, attempt, envelope,
        from_seq AS "fromSeq", to_seq AS "toSeq", run_id AS "runId", message_id AS "messageId",
        sent_text AS "sentText", wait_json AS wait, withdrawn, reply_message_id AS "replyMessageId",
        error, roster_json AS roster, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM deliveries
      WHERE ${where as Statement.Fragment}
      ORDER BY created_at, rowid
    `,
  });
  const discussionRows = SqlSchema.findAll({
    Request: Schema.Struct({ where: Schema.Any }),
    Result: DiscussionRow,
    execute: ({ where }) => sql`
      SELECT id, group_id AS "groupId", participants_json AS participants, topic,
        max_rounds AS "maxRounds", round, state, end_reason AS "endReason",
        prompt_message_id AS "promptMessageId", signed_off_json AS "signedOff",
        created_at AS "createdAt", ended_at AS "endedAt"
      FROM discussions
      WHERE ${where as Statement.Fragment}
      ORDER BY created_at, rowid
    `,
  });
  const cancelRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CancelRow,
    execute: () => sql`
      SELECT id, thread_id AS "threadId", run_id AS "runId", message_id AS "messageId"
      FROM cancels
      ORDER BY created_at, rowid
    `,
  });
  const first = <A>(rows: ReadonlyArray<A>): A | null => rows[0] ?? null;
  const members = (where: Statement.Fragment) =>
    Effect.map(memberRows({ where }), (rows) => rows.map(toMember));
  const deliveries = (where: Statement.Fragment) => deliveryRows({ where });
  const discussions = (where: Statement.Fragment) => discussionRows({ where });
  return {
    groups: groupRows({ id: null }),
    group: (id) => Effect.map(groupRows({ id }), first),
    members: (groupId, includeRemoved) =>
      members(sql`group_id = ${groupId} ${includeRemoved ? sql`` : sql`AND removed_at IS NULL`}`),
    activeMembers: members(sql`removed_at IS NULL`),
    member: (id) => Effect.map(members(sql`id = ${id}`), first),
    memberByThread: (groupId, threadId) =>
      members(sql`group_id = ${groupId} AND thread_id = ${threadId}`),
    messages: (groupId, afterSeq = 0) =>
      messageRows({ where: sql`group_id = ${groupId} AND seq > ${afterSeq}` }),
    message: (id) => Effect.map(messageRows({ where: sql`id = ${id}` }), first),
    delivery: (id) => Effect.map(deliveries(sql`id = ${id}`), first),
    deliveriesOfGroup: (groupId) => deliveries(sql`group_id = ${groupId}`),
    deliveriesOfMember: (memberId) => deliveries(sql`member_id = ${memberId}`),
    deliveriesOfThread: (threadId) =>
      deliveries(sql`member_id IN (SELECT id FROM members WHERE thread_id = ${threadId})`),
    deliveriesOfRound: (discussionId, round) =>
      deliveries(sql`discussion_id = ${discussionId} AND round = ${round}`),
    openDeliveries: deliveries(sql`state IN ${sql.in(OPEN_STATES)}`),
    lanePaused: (threadId) =>
      Effect.map(
        sql<{ readonly one: number }>`SELECT 1 AS one FROM lanes WHERE thread_id = ${threadId}`,
        (rows) => rows.length > 0,
      ),
    pendingCancels: cancelRows(),
    discussion: (id) => Effect.map(discussions(sql`id = ${id}`), first),
    discussionsOfGroup: (groupId) => discussions(sql`group_id = ${groupId}`),
    runningDiscussions: discussions(sql`state = 'running'`),
  };
};

const makeWrites = (
  sql: SqlClient.SqlClient,
  reads: Reads,
  emit: (change: StoreChange) => void,
): Writes => {
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const stored = <A>(label: string, read: Effect.Effect<A | null, StoreError>) =>
    Effect.flatMap(read, (value) =>
      value === null
        ? Effect.die(new Error(`${label} vanished inside its own transaction`))
        : Effect.succeed(value),
    );
  return {
    createGroup: (title) =>
      Effect.gen(function* () {
        const id = GroupChatGroupId.make(newId("grp"));
        const at = yield* now;
        yield* sql`
          INSERT INTO groups (id, title, created_at, last_activity_at)
          VALUES (${id}, ${title}, ${at}, ${at})
        `;
        const group = yield* stored("group", reads.group(id));
        emit({ _tag: "group", group });
        return group;
      }),
    updateGroup: (id, patch) =>
      Effect.gen(function* () {
        const current = yield* stored("group", reads.group(id));
        if (patch.title !== undefined) {
          yield* sql`UPDATE groups SET title = ${patch.title} WHERE id = ${id}`;
        }
        if (patch.settled !== undefined && patch.settled !== (current.settledAt !== null)) {
          const settledAt = patch.settled ? yield* now : null;
          yield* sql`UPDATE groups SET settled_at = ${settledAt} WHERE id = ${id}`;
        }
        const group = yield* stored("group", reads.group(id));
        emit({ _tag: "group", group });
        return group;
      }),
    deleteGroup: (id) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM groups WHERE id = ${id}`;
        emit({ _tag: "group.deleted", groupId: id });
      }),
    addMember: (input) =>
      Effect.gen(function* () {
        const id = GroupChatMemberId.make(newId("mem"));
        const at = yield* now;
        yield* sql`
          INSERT INTO members (
            id, group_id, handle, color, environment_id, thread_id, thread_title, added_at
          ) VALUES (
            ${id}, ${input.groupId}, ${input.handle}, ${input.color},
            ${input.thread.environmentId}, ${input.thread.threadId}, ${input.thread.title}, ${at}
          )
        `;
        const member = yield* stored("member", reads.member(id));
        emit({ _tag: "member", member });
        return member;
      }),
    updateMember: (id, patch) =>
      Effect.gen(function* () {
        const current = yield* stored("member", reads.member(id));
        if (patch.handle !== undefined && patch.handle !== current.handle) {
          const history = encodeStrings(
            [
              ...current.handleHistory.filter((h) => h !== current.handle && h !== patch.handle),
              current.handle,
            ].slice(-10),
          );
          yield* sql`
            UPDATE members SET handle = ${patch.handle}, handle_history_json = ${history}
            WHERE id = ${id}
          `;
        }
        if (patch.color !== undefined) {
          yield* sql`UPDATE members SET color = ${patch.color} WHERE id = ${id}`;
        }
        if (patch.threadTitle !== undefined) {
          yield* sql`UPDATE members SET thread_title = ${patch.threadTitle} WHERE id = ${id}`;
        }
        if (patch.seenSeq !== undefined) {
          yield* sql`
            UPDATE members SET seen_seq = MAX(seen_seq, ${patch.seenSeq}) WHERE id = ${id}
          `;
        }
        if (patch.introduced !== undefined) {
          yield* sql`UPDATE members SET introduced = ${patch.introduced ? 1 : 0} WHERE id = ${id}`;
        }
        if (patch.toldRoster !== undefined) {
          const roster = encodeRoster(patch.toldRoster);
          yield* sql`UPDATE members SET told_roster_json = ${roster} WHERE id = ${id}`;
        }
        if (patch.removed !== undefined) {
          const removedAt = patch.removed ? yield* now : null;
          yield* sql`UPDATE members SET removed_at = ${removedAt} WHERE id = ${id}`;
        }
        const member = yield* stored("member", reads.member(id));
        emit({ _tag: "member", member });
        return member;
      }),
    touchMember: (id) =>
      Effect.map(reads.member(id), (member) => {
        if (member !== null) emit({ _tag: "member", member });
      }),
    appendMessage: (input) =>
      Effect.gen(function* () {
        const id = GroupChatMessageId.make(newId("msg"));
        const [next] = yield* sql<{ readonly seq: number }>`
          SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE group_id = ${input.groupId}
        `;
        const seq = next?.seq ?? 1;
        const at = yield* now;
        yield* sql`
          INSERT INTO messages (
            id, group_id, seq, author_json, kind, text, display_text, recipients_json, turn_key,
            trigger_message_id, discussion_id, round, sign_off, late, created_at
          ) VALUES (
            ${id}, ${input.groupId}, ${seq}, ${encodeAuthor(input.author)}, ${input.kind},
            ${input.text}, ${input.displayText}, ${encodeMemberIds(input.recipients ?? [])},
            ${input.turnKey ?? id}, ${input.triggerMessageId ?? null}, ${input.discussionId ?? null},
            ${input.round ?? null}, ${input.signOff ? 1 : 0}, ${input.late ? 1 : 0}, ${at}
          )
        `;
        yield* sql`UPDATE groups SET last_activity_at = ${at} WHERE id = ${input.groupId}`;
        const message = yield* stored("message", reads.message(id));
        emit({ _tag: "message", message });
        emit({ _tag: "group", group: yield* stored("group", reads.group(input.groupId)) });
        return message;
      }),
    insertDelivery: (input) =>
      Effect.gen(function* () {
        const id = GroupChatDeliveryId.make(newId("dlv"));
        const at = yield* now;
        const wait = input.wait === null ? null : encodeWait(input.wait);
        yield* sql`
          INSERT INTO deliveries (
            id, group_id, member_id, trigger_message_id, turn_key, discussion_id, round,
            state, dispatch, to_seq, wait_json, created_at, updated_at
          ) VALUES (
            ${id}, ${input.groupId}, ${input.memberId}, ${input.triggerMessageId}, ${input.turnKey},
            ${input.discussionId}, ${input.round}, 'pending', 'unsent', ${input.toSeq},
            ${wait}, ${at}, ${at}
          )
        `;
        const delivery = yield* stored("delivery", reads.delivery(id));
        emit({ _tag: "delivery", delivery });
        return delivery;
      }),
    updateDelivery: (id, patch) =>
      Effect.gen(function* () {
        const current = yield* stored("delivery", reads.delivery(id));
        const next = { ...current, ...patch };
        const at = yield* now;
        const wait = next.wait === null ? null : encodeWait(next.wait);
        const roster = next.roster === null ? null : encodeRoster(next.roster);
        yield* sql`
          UPDATE deliveries SET
            state = ${next.state}, dispatch = ${next.dispatch}, attempt = ${next.attempt},
            envelope = ${next.envelope}, from_seq = ${next.fromSeq}, run_id = ${next.runId},
            message_id = ${next.messageId}, sent_text = ${next.sentText}, wait_json = ${wait},
            withdrawn = ${next.withdrawn}, reply_message_id = ${next.replyMessageId},
            error = ${next.error}, roster_json = ${roster}, updated_at = ${at}
          WHERE id = ${id}
        `;
        const delivery = yield* stored("delivery", reads.delivery(id));
        emit({ _tag: "delivery", delivery });
        return delivery;
      }),
    insertDiscussion: (input) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* sql`
          INSERT INTO discussions (
            id, group_id, participants_json, topic, max_rounds, round, state, end_reason,
            prompt_message_id, signed_off_json, created_at
          ) VALUES (
            ${input.id}, ${input.groupId}, ${encodeMemberIds(input.participants)}, ${input.topic},
            ${input.maxRounds}, ${input.round}, ${input.state}, ${input.endReason},
            ${input.promptMessageId}, ${encodeSignedOff(input.signedOff)}, ${at}
          )
        `;
        const discussion = yield* stored("discussion", reads.discussion(input.id));
        emit({ _tag: "discussion", discussion });
        return discussion;
      }),
    pauseLane: (threadId) =>
      Effect.gen(function* () {
        const pausedAt = yield* now;
        yield* sql`
          INSERT INTO lanes (thread_id, paused_at) VALUES (${threadId}, ${pausedAt})
          ON CONFLICT(thread_id) DO UPDATE SET paused_at = excluded.paused_at
        `;
      }),
    resumeLane: (threadId) => Effect.asVoid(sql`DELETE FROM lanes WHERE thread_id = ${threadId}`),
    insertCancel: (input) =>
      Effect.gen(function* () {
        const runId = "runId" in input ? input.runId : null;
        const messageId = "messageId" in input ? input.messageId : null;
        const id = `${input.threadId}:${runId ?? `message:${messageId}`}`;
        const at = yield* now;
        yield* sql`
          INSERT OR IGNORE INTO cancels (id, thread_id, run_id, message_id, created_at)
          VALUES (${id}, ${input.threadId}, ${runId}, ${messageId}, ${at})
        `;
      }),
    deleteCancel: (id) => Effect.asVoid(sql`DELETE FROM cancels WHERE id = ${id}`),
    updateDiscussion: (id, patch) =>
      Effect.gen(function* () {
        const current = yield* stored("discussion", reads.discussion(id));
        const next = { ...current, ...patch };
        const endedAt = next.state === "ended" ? (current.endedAt ?? (yield* now)) : null;
        yield* sql`
          UPDATE discussions SET
            round = ${next.round}, state = ${next.state}, end_reason = ${next.endReason},
            signed_off_json = ${encodeSignedOff(next.signedOff)}, ended_at = ${endedAt}
          WHERE id = ${id}
        `;
        const discussion = yield* stored("discussion", reads.discussion(id));
        emit({ _tag: "discussion", discussion });
        return discussion;
      }),
  };
};

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

  const changes = yield* PubSub.unbounded<StoreEvent>();
  const seq = yield* Ref.make(0);
  const reads = makeReads(sql);
  // The commit and the publication of its changes happen under one lock, so `seq` follows commit
  // order and a client applying events by `seq` never sees an older row after a newer one.
  const writer = yield* Semaphore.make(1);

  const transaction: GroupChatStore["transaction"] = (body) =>
    writer.withPermits(1)(
      Effect.gen(function* () {
        const pending: StoreChange[] = [];
        const tx: Tx = { ...reads, ...makeWrites(sql, reads, (change) => pending.push(change)) };
        const result = yield* sql.withTransaction(body(tx));
        for (const change of pending) {
          const n = yield* Ref.updateAndGet(seq, (value) => value + 1);
          yield* PubSub.publish(changes, { seq: n, change });
        }
        return result;
      }),
    );

  return { ...reads, transaction, changes } satisfies GroupChatStore;
});
