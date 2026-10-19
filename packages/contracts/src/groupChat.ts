import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const GroupChatGroupId = TrimmedNonEmptyString.pipe(Schema.brand("GroupChatGroupId"));
export type GroupChatGroupId = typeof GroupChatGroupId.Type;
export const GroupChatMemberId = TrimmedNonEmptyString.pipe(Schema.brand("GroupChatMemberId"));
export type GroupChatMemberId = typeof GroupChatMemberId.Type;
export const GroupChatMessageId = TrimmedNonEmptyString.pipe(Schema.brand("GroupChatMessageId"));
export type GroupChatMessageId = typeof GroupChatMessageId.Type;
export const GroupChatDeliveryId = TrimmedNonEmptyString.pipe(Schema.brand("GroupChatDeliveryId"));
export type GroupChatDeliveryId = typeof GroupChatDeliveryId.Type;
export const GroupChatDiscussionId = TrimmedNonEmptyString.pipe(
  Schema.brand("GroupChatDiscussionId"),
);
export type GroupChatDiscussionId = typeof GroupChatDiscussionId.Type;

export const GroupChatGroup = Schema.Struct({
  id: GroupChatGroupId,
  title: TrimmedNonEmptyString,
  settledAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
});
export type GroupChatGroup = typeof GroupChatGroup.Type;

export const GroupChatMemberThread = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: Schema.String,
});
export type GroupChatMemberThread = typeof GroupChatMemberThread.Type;

/** A member keeps its identity, seen mark and handle history while removed, so a re-add restores them. */
export const GroupChatMember = Schema.Struct({
  id: GroupChatMemberId,
  groupId: GroupChatGroupId,
  handle: TrimmedNonEmptyString,
  handleHistory: Schema.Array(Schema.String),
  color: NonNegativeInt,
  thread: GroupChatMemberThread,
  seenSeq: NonNegativeInt,
  introduced: Schema.Boolean,
  toldRoster: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  addedAt: IsoDateTime,
  removedAt: Schema.NullOr(IsoDateTime),
});
export type GroupChatMember = typeof GroupChatMember.Type;

export const GroupChatAuthor = Schema.Union([
  Schema.TaggedStruct("operator", {}),
  Schema.TaggedStruct("member", { memberId: GroupChatMemberId }),
  Schema.TaggedStruct("system", {}),
]);
export type GroupChatAuthor = typeof GroupChatAuthor.Type;

export const GroupChatMessageKind = Schema.Literals([
  "chat",
  "reply",
  "discussion_prompt",
  "discussion_reply",
  "system",
]);
export type GroupChatMessageKind = typeof GroupChatMessageKind.Type;

const messageHeadFields = {
  id: GroupChatMessageId,
  groupId: GroupChatGroupId,
  seq: PositiveInt,
  author: GroupChatAuthor,
  kind: GroupChatMessageKind,
  recipients: Schema.Array(GroupChatMemberId),
  turnKey: Schema.String,
  triggerMessageId: Schema.NullOr(GroupChatMessageId),
  discussionId: Schema.NullOr(GroupChatDiscussionId),
  round: Schema.NullOr(PositiveInt),
  signOff: Schema.Boolean,
  late: Schema.Boolean,
  createdAt: IsoDateTime,
};
/** A message without its body, as the event stream carries it. The group page has the body. */
export const GroupChatMessageHead = Schema.Struct(messageHeadFields);
export type GroupChatMessageHead = typeof GroupChatMessageHead.Type;

export const GroupChatMessage = Schema.Struct({
  ...messageHeadFields,
  text: Schema.String,
  /** The text to render: a member's leading self-label and a counted sign-off line are gone. */
  displayText: Schema.String,
});
export type GroupChatMessage = typeof GroupChatMessage.Type;

export const GroupChatQuestion = Schema.Struct({
  id: Schema.String,
  header: Schema.NullOr(Schema.String),
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.NullOr(Schema.String),
      value: Schema.NullOr(Schema.String),
    }),
  ),
  multiSelect: Schema.Boolean,
});
export type GroupChatQuestion = typeof GroupChatQuestion.Type;

/** What a member thread waits for from a person. An approval can only be given in T3. */
export const GroupChatPendingInput = Schema.Union([
  Schema.TaggedStruct("question", {
    requestId: RuntimeRequestId,
    questions: Schema.Array(GroupChatQuestion),
  }),
  Schema.TaggedStruct("approval", {}),
]);
export type GroupChatPendingInput = typeof GroupChatPendingInput.Type;

/** Why a delivery has not run yet. Each one points at the member's thread. */
export const GroupChatWait = Schema.Union([
  Schema.TaggedStruct("lane_busy", { deliveryId: GroupChatDeliveryId }),
  Schema.TaggedStruct("busy_with_own_run", { runId: RunId }),
  /** `note` tells the operator that Resume in T3 releases the thread's whole queue, this envelope included. */
  Schema.TaggedStruct("queue_held", { note: Schema.String }),
  Schema.TaggedStruct("waiting_on_question", {
    requestId: RuntimeRequestId,
    questions: Schema.Array(GroupChatQuestion),
  }),
  Schema.TaggedStruct("waiting_on_approval", {}),
  Schema.TaggedStruct("stopped_in_t3", {}),
]);
export type GroupChatWait = typeof GroupChatWait.Type;

/** The run's status as the operator sees it. `queued` and `running` come from the envelope's T3 run. */
export const GroupChatDeliveryState = Schema.Literals([
  "pending",
  "queued",
  "running",
  "replied",
  "failed",
  "cancelled",
]);
export type GroupChatDeliveryState = typeof GroupChatDeliveryState.Type;

/**
 * Where the envelope is. `unknown` means a dispatch left without a recorded outcome; the derived
 * message id in the thread's records settles it. `rejected` is a definite refusal.
 */
export const GroupChatDispatchState = Schema.Literals([
  "unsent",
  "sending",
  "unknown",
  "accepted",
  "rejected",
]);
export type GroupChatDispatchState = typeof GroupChatDispatchState.Type;

const deliveryHeadFields = {
  id: GroupChatDeliveryId,
  groupId: GroupChatGroupId,
  memberId: GroupChatMemberId,
  triggerMessageId: GroupChatMessageId,
  turnKey: Schema.String,
  discussionId: Schema.NullOr(GroupChatDiscussionId),
  round: Schema.NullOr(PositiveInt),
  state: GroupChatDeliveryState,
  dispatch: GroupChatDispatchState,
  /** Rises only on an operator Retry after a definite rejection or an ended run. */
  attempt: PositiveInt,
  fromSeq: NonNegativeInt,
  toSeq: NonNegativeInt,
  runId: Schema.NullOr(RunId),
  messageId: Schema.NullOr(MessageId),
  wait: Schema.NullOr(GroupChatWait),
  /** Set when the operator no longer wants the reply while T3 still has the envelope. */
  withdrawn: Schema.NullOr(Schema.String),
  replyMessageId: Schema.NullOr(GroupChatMessageId),
  error: Schema.NullOr(Schema.String),
  retryable: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};
/** A delivery without the envelope it sent, as the event stream carries it. */
export const GroupChatDeliveryHead = Schema.Struct(deliveryHeadFields);
export type GroupChatDeliveryHead = typeof GroupChatDeliveryHead.Type;

export const GroupChatDelivery = Schema.Struct({
  ...deliveryHeadFields,
  envelope: Schema.String,
  /** The text that ran when it differs from the envelope, because it was edited in T3. */
  sentText: Schema.NullOr(Schema.String),
});
export type GroupChatDelivery = typeof GroupChatDelivery.Type;

export const GroupChatDiscussionState = Schema.Literals(["running", "ended"]);
export type GroupChatDiscussionState = typeof GroupChatDiscussionState.Type;

const discussionHeadFields = {
  id: GroupChatDiscussionId,
  groupId: GroupChatGroupId,
  participants: Schema.Array(GroupChatMemberId),
  maxRounds: PositiveInt,
  round: PositiveInt,
  state: GroupChatDiscussionState,
  endReason: Schema.NullOr(Schema.String),
  promptMessageId: GroupChatMessageId,
  signedOff: Schema.Record(Schema.String, PositiveInt),
  createdAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
};
/** A discussion without its topic, as the event stream carries it. */
export const GroupChatDiscussionHead = Schema.Struct(discussionHeadFields);
export type GroupChatDiscussionHead = typeof GroupChatDiscussionHead.Type;

export const GroupChatDiscussion = Schema.Struct({ ...discussionHeadFields, topic: Schema.String });
export type GroupChatDiscussion = typeof GroupChatDiscussion.Type;

export const GroupChatSnapshot = Schema.Struct({
  groups: Schema.Array(GroupChatGroup),
  members: Schema.Array(GroupChatMember),
});
export type GroupChatSnapshot = typeof GroupChatSnapshot.Type;

export const GroupChatGroupParams = Schema.Struct({
  groupId: GroupChatGroupId,
});

export const GroupChatDeliveryParams = Schema.Struct({
  deliveryId: GroupChatDeliveryId,
});

/** How many messages one group page holds. */
export const GROUP_CHAT_PAGE_SIZE = 200;

const SeqFromQuery = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

/**
 * Which page of a group's messages to read. Neither key reads the latest page. `before` reads the
 * page of older messages below that seq. `after` reads what arrived past that seq, so a client that
 * holds everything up to a seq can fetch the bodies behind new stream heads.
 */
export const GroupChatGroupQuery = Schema.Struct({
  before: Schema.optionalKey(SeqFromQuery),
  after: Schema.optionalKey(SeqFromQuery),
});
export type GroupChatGroupQuery = typeof GroupChatGroupQuery.Type;

/**
 * One page of a group. `messages` rise by seq and hold at most `GROUP_CHAT_PAGE_SIZE`. `deliveries`
 * are the heads for those messages, plus every open delivery when the page was not read with
 * `before`, so a client always sees what is still in flight. A delivery's envelope comes from the
 * delivery read. `olderBefore` is the `before` for the next older page, or null at the first message.
 */
export const GroupChatGroupPage = Schema.Struct({
  group: GroupChatGroup,
  members: Schema.Array(GroupChatMember),
  discussions: Schema.Array(GroupChatDiscussion),
  messages: Schema.Array(GroupChatMessage),
  deliveries: Schema.Array(GroupChatDeliveryHead),
  olderBefore: Schema.NullOr(PositiveInt),
});
export type GroupChatGroupPage = typeof GroupChatGroupPage.Type;

const GROUP_CHAT_MAX_ROUNDS = 20;

export const GroupChatCommand = Schema.Union([
  Schema.TaggedStruct("group.create", {
    title: Schema.String,
    threadIds: Schema.Array(ThreadId),
  }),
  Schema.TaggedStruct("group.rename", { groupId: GroupChatGroupId, title: Schema.String }),
  Schema.TaggedStruct("group.settle", { groupId: GroupChatGroupId }),
  Schema.TaggedStruct("group.unsettle", { groupId: GroupChatGroupId }),
  Schema.TaggedStruct("group.delete", { groupId: GroupChatGroupId }),
  Schema.TaggedStruct("member.add", { groupId: GroupChatGroupId, threadId: ThreadId }),
  Schema.TaggedStruct("member.remove", { memberId: GroupChatMemberId }),
  Schema.TaggedStruct("member.rename", { memberId: GroupChatMemberId, handle: Schema.String }),
  Schema.TaggedStruct("member.thread.settle", { memberId: GroupChatMemberId }),
  Schema.TaggedStruct("member.thread.unsettle", { memberId: GroupChatMemberId }),
  Schema.TaggedStruct("member.answer", {
    memberId: GroupChatMemberId,
    requestId: RuntimeRequestId,
    answers: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Array(Schema.String)]),
    ),
  }),
  Schema.TaggedStruct("message.send", {
    groupId: GroupChatGroupId,
    text: Schema.String,
    recipients: Schema.Array(GroupChatMemberId),
  }),
  Schema.TaggedStruct("delivery.retry", { deliveryId: GroupChatDeliveryId }),
  Schema.TaggedStruct("delivery.stop", { deliveryId: GroupChatDeliveryId }),
  Schema.TaggedStruct("discussion.start", {
    groupId: GroupChatGroupId,
    participants: Schema.Array(GroupChatMemberId),
    topic: Schema.String,
    maxRounds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: GROUP_CHAT_MAX_ROUNDS })),
  }),
  Schema.TaggedStruct("discussion.stop", { discussionId: GroupChatDiscussionId }),
]);
export type GroupChatCommand = typeof GroupChatCommand.Type;

export const GroupChatDispatchResult = Schema.Union([
  Schema.TaggedStruct("group", { group: GroupChatGroup }),
  Schema.TaggedStruct("member", { member: GroupChatMember }),
  Schema.TaggedStruct("message", { message: GroupChatMessage }),
  Schema.TaggedStruct("delivery", { delivery: GroupChatDelivery }),
  Schema.TaggedStruct("discussion", { discussion: GroupChatDiscussion }),
  Schema.TaggedStruct("done", {}),
]);
export type GroupChatDispatchResult = typeof GroupChatDispatchResult.Type;

/**
 * One changed row per event, without bodies: a message's text, a delivery's envelope and a
 * discussion's topic come from the group page. `seq` rises per server boot, so a client can spot a
 * gap and refetch.
 */
export const GroupChatStreamEvent = Schema.Union([
  Schema.TaggedStruct("group", { seq: PositiveInt, group: GroupChatGroup }),
  Schema.TaggedStruct("group.deleted", { seq: PositiveInt, groupId: GroupChatGroupId }),
  Schema.TaggedStruct("member", { seq: PositiveInt, member: GroupChatMember }),
  Schema.TaggedStruct("message", { seq: PositiveInt, message: GroupChatMessageHead }),
  Schema.TaggedStruct("delivery", { seq: PositiveInt, delivery: GroupChatDeliveryHead }),
  Schema.TaggedStruct("discussion", { seq: PositiveInt, discussion: GroupChatDiscussionHead }),
]);
export type GroupChatStreamEvent = typeof GroupChatStreamEvent.Type;

/**
 * `disabled` is the `T3CODE_GROUP_CHAT=off` kill switch. `store_unavailable` means the module's
 * database failed to open or migrate at boot, and the server started without it.
 */
export const GroupChatUnavailableReason = Schema.Literals([
  "disabled",
  "store_unavailable",
  "not_ready",
]);
export type GroupChatUnavailableReason = typeof GroupChatUnavailableReason.Type;

export class GroupChatUnavailable extends Schema.TaggedError<GroupChatUnavailable>()(
  "GroupChatUnavailable",
  { reason: GroupChatUnavailableReason },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(GroupChatUnavailable)(this, { status: 503 });
  }

  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return "Group chat is turned off on this server.";
      case "store_unavailable":
        return "Group chat could not open its data. The server log says why.";
      case "not_ready":
        return "This server does not support that group chat request yet.";
    }
  }
}

export const GroupChatEntity = Schema.Literals([
  "group",
  "member",
  "message",
  "delivery",
  "discussion",
  "thread",
]);
export type GroupChatEntity = typeof GroupChatEntity.Type;

export class GroupChatNotFound extends Schema.TaggedError<GroupChatNotFound>()(
  "GroupChatNotFound",
  { entity: GroupChatEntity, id: Schema.String },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(GroupChatNotFound)(this, { status: 404 });
  }

  override get message(): string {
    return `No group chat ${this.entity} ${this.id}.`;
  }
}

/** The operator's input cannot be used as written. `reason` is the sentence to show. */
export class GroupChatInvalid extends Schema.TaggedError<GroupChatInvalid>()(
  "GroupChatInvalid",
  { reason: Schema.String },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(GroupChatInvalid)(this, { status: 400 });
  }

  override get message(): string {
    return this.reason;
  }
}

/** The group's state does not allow the command now. `reason` is the sentence to show. */
export class GroupChatRefused extends Schema.TaggedError<GroupChatRefused>()(
  "GroupChatRefused",
  { reason: Schema.String },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(GroupChatRefused)(this, { status: 409 });
  }

  override get message(): string {
    return this.reason;
  }
}

/** T3 refused to act on the member's thread. `reason` is T3's own sentence, verbatim. */
export class GroupChatThreadRefused extends Schema.TaggedError<GroupChatThreadRefused>()(
  "GroupChatThreadRefused",
  {
    action: Schema.Literals(["add", "settle", "unsettle", "answer"]),
    threadId: ThreadId,
    reason: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(GroupChatThreadRefused)(this, { status: 409 });
  }

  override get message(): string {
    return this.reason;
  }
}

export const GroupChatCommandError = Schema.Union([
  GroupChatNotFound,
  GroupChatInvalid,
  GroupChatRefused,
  GroupChatThreadRefused,
]);
export type GroupChatCommandError = typeof GroupChatCommandError.Type;
