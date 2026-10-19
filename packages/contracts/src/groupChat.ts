import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const GroupChatGroupId = TrimmedNonEmptyString.pipe(Schema.brand("GroupChatGroupId"));
export type GroupChatGroupId = typeof GroupChatGroupId.Type;

export const GroupChatGroup = Schema.Struct({
  id: GroupChatGroupId,
  title: TrimmedNonEmptyString,
  settledAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
});
export type GroupChatGroup = typeof GroupChatGroup.Type;

export const GroupChatSnapshot = Schema.Struct({
  groups: Schema.Array(GroupChatGroup),
});
export type GroupChatSnapshot = typeof GroupChatSnapshot.Type;

export const GroupChatGroupParams = Schema.Struct({
  groupId: GroupChatGroupId,
});

export const GroupChatGroupSnapshot = Schema.Struct({
  group: GroupChatGroup,
});
export type GroupChatGroupSnapshot = typeof GroupChatGroupSnapshot.Type;

export const GroupChatCreateGroup = Schema.TaggedStruct("group.create", {
  title: TrimmedNonEmptyString,
});

export const GroupChatCommand = Schema.Union([GroupChatCreateGroup]);
export type GroupChatCommand = typeof GroupChatCommand.Type;

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
