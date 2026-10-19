import type {
  GroupChatDiscussion,
  GroupChatDiscussionId,
  GroupChatMember,
  GroupChatMemberId,
  GroupChatMessage,
  GroupChatPageDelivery,
} from "@t3tools/contracts";

import type { GroupView } from "../store";

export type ParticipantStatus =
  | { readonly _tag: "removed" }
  | { readonly _tag: "signed_off" }
  | { readonly _tag: "replied" }
  | { readonly _tag: "late" }
  | { readonly _tag: "open"; readonly delivery: GroupChatPageDelivery }
  | { readonly _tag: "paused"; readonly delivery: GroupChatPageDelivery }
  | { readonly _tag: "failed"; readonly delivery: GroupChatPageDelivery }
  | { readonly _tag: "cancelled"; readonly delivery: GroupChatPageDelivery }
  | { readonly _tag: "no_delivery" };

export interface ParticipantRow {
  readonly memberId: GroupChatMemberId;
  readonly member: GroupChatMember | undefined;
  readonly status: ParticipantStatus;
}

export interface DiscussionView {
  readonly discussion: GroupChatDiscussion;
  readonly running: boolean;
  readonly round: number;
  readonly maxRounds: number;
  readonly participants: ReadonlyArray<ParticipantRow>;
  readonly replied: ReadonlyArray<ParticipantRow>;
  readonly signedOff: ReadonlyArray<ParticipantRow>;
  readonly waitingOn: ReadonlyArray<ParticipantRow>;
  readonly endSentence: string | null;
}

const WAITING: ReadonlySet<ParticipantStatus["_tag"]> = new Set(["open", "paused", "no_delivery"]);

const STOPPED_BY_OPERATOR = "stopped by operator";

function statusOf(
  discussion: GroupChatDiscussion,
  memberId: GroupChatMemberId,
  member: GroupChatMember | undefined,
  delivery: GroupChatPageDelivery | undefined,
  messages: GroupView["messages"],
): ParticipantStatus {
  if (member === undefined || member.removedAt !== null) return { _tag: "removed" };
  const replyId = delivery?.replyMessageId ?? null;
  const reply = replyId === null ? undefined : messages.get(replyId);
  if (reply?.signOff === true || discussion.signedOff[memberId] === discussion.round) {
    return { _tag: "signed_off" };
  }
  if (delivery === undefined) return { _tag: "no_delivery" };
  switch (delivery.state) {
    case "replied":
      return delivery.withdrawn === null && reply?.late !== true
        ? { _tag: "replied" }
        : { _tag: "late" };
    case "failed":
      return delivery.wait?._tag === "stopped_in_t3"
        ? { _tag: "paused", delivery }
        : { _tag: "failed", delivery };
    case "cancelled":
      return { _tag: "cancelled", delivery };
    case "pending":
    case "queued":
    case "running":
      return { _tag: "open", delivery };
  }
}

function roundDeliveries(view: GroupView, discussion: GroupChatDiscussion) {
  const byMember = new Map<GroupChatMemberId, GroupChatPageDelivery>();
  for (const d of view.deliveries.values()) {
    if (d.discussionId !== discussion.id || d.round !== discussion.round) continue;
    const existing = byMember.get(d.memberId);
    if (existing === undefined || existing.createdAt < d.createdAt) byMember.set(d.memberId, d);
  }
  return byMember;
}

export function discussionView(view: GroupView, id: GroupChatDiscussionId): DiscussionView | null {
  const discussion = view.discussions.get(id);
  if (discussion === undefined) return null;
  const deliveries = roundDeliveries(view, discussion);
  const participants = discussion.participants.map((memberId): ParticipantRow => {
    const member = view.members.get(memberId);
    return {
      memberId,
      member,
      status: statusOf(discussion, memberId, member, deliveries.get(memberId), view.messages),
    };
  });
  return {
    discussion,
    running: discussion.state === "running",
    round: discussion.round,
    maxRounds: discussion.maxRounds,
    participants,
    replied: participants.filter(
      (p) => p.status._tag === "replied" || p.status._tag === "signed_off",
    ),
    signedOff: participants.filter((p) => p.status._tag === "signed_off"),
    waitingOn: participants.filter((p) => WAITING.has(p.status._tag)),
    endSentence: endSentence(discussion),
  };
}

export const endSentence = (discussion: GroupChatDiscussion): string | null =>
  discussion.state === "running" || discussion.endReason === null
    ? null
    : `Ended: ${discussion.endReason}.`;

export function lateLabel(
  message: GroupChatMessage,
  discussion: GroupChatDiscussion | undefined,
): string | null {
  if (!message.late) return null;
  if (message.kind !== "discussion_reply") return "late reply";
  // A reply dated before the end was withdrawn or its member removed while the discussion ran.
  if (
    discussion === undefined ||
    discussion.endedAt === null ||
    message.createdAt <= discussion.endedAt
  ) {
    return "arrived after the round, not counted";
  }
  return discussion.endReason === STOPPED_BY_OPERATOR
    ? "arrived after Stop, not counted"
    : "arrived after the discussion ended, not counted";
}

export function runningDiscussion(view: GroupView): GroupChatDiscussion | null {
  for (const d of view.discussions.values()) if (d.state === "running") return d;
  return null;
}

function discussionOfLastMessage(view: GroupView): GroupChatDiscussion | undefined {
  let last: GroupChatMessage | undefined;
  for (const m of view.messages.values()) if (last === undefined || m.seq > last.seq) last = m;
  return last === undefined || last.discussionId === null
    ? undefined
    : view.discussions.get(last.discussionId);
}

export function panelDiscussion(
  view: GroupView,
  dismissedId: string | null,
): GroupChatDiscussion | null {
  const running = runningDiscussion(view);
  if (running !== null) return running;
  const recent = discussionOfLastMessage(view);
  return recent !== undefined && recent.state === "ended" && recent.id !== dismissedId
    ? recent
    : null;
}

export type RoundDivider =
  | {
      readonly _tag: "round";
      readonly round: number;
      readonly maxRounds: number;
      readonly caption: string;
    }
  | { readonly _tag: "ended"; readonly endSentence: string; readonly note: string | null };

const roundCaption = (round: number) =>
  round === 1
    ? "each participant sees the topic"
    : `each participant sees the others' round ${round - 1} replies`;

export function roundDivider(
  message: GroupChatMessage,
  discussion: GroupChatDiscussion | undefined,
): RoundDivider | null {
  if (discussion === undefined || message.round === null) return null;
  if (message.kind !== "discussion_prompt" && message.kind !== "system") return null;
  if (message.displayText.startsWith("Discussion ended")) {
    const sentence = endSentence(discussion);
    if (sentence === null) return { _tag: "ended", endSentence: message.displayText, note: null };
    const own = `Discussion ended: ${discussion.endReason}.`;
    const note = message.displayText.startsWith(own)
      ? message.displayText.slice(own.length).trim()
      : "";
    return { _tag: "ended", endSentence: sentence, note: note === "" ? null : note };
  }
  const round = message.kind === "discussion_prompt" ? 1 : message.round;
  return { _tag: "round", round, maxRounds: discussion.maxRounds, caption: roundCaption(round) };
}
