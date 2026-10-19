import type {
  GroupChatDiscussion,
  GroupChatDiscussionId,
  GroupChatGroupId,
  GroupChatGroupPage,
  GroupChatMember,
  GroupChatMemberId,
  GroupChatMessage,
  GroupChatMessageId,
  GroupChatPageDelivery,
  GroupChatStreamEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyEvent, applyPage, emptyState, type StoreState } from "../store";
import {
  discussionView,
  endSentence,
  lateLabel,
  panelDiscussion,
  roundDivider,
} from "./discussionView";

const groupId = "grp_1" as GroupChatGroupId;
const discussionId = "dsc_1" as GroupChatDiscussionId;
const m1 = "mem_1" as GroupChatMemberId;
const m2 = "mem_2" as GroupChatMemberId;
const at = "2026-10-19T00:00:00.000Z";

const member = (id: GroupChatMemberId, handle: string): GroupChatMember => ({
  id,
  groupId,
  handle,
  handleHistory: [],
  color: 0 as GroupChatMember["color"],
  thread: { environmentId: "env" as never, threadId: `thr_${handle}` as never, title: handle },
  seenSeq: 0 as GroupChatMember["seenSeq"],
  introduced: true,
  toldRoster: null,
  addedAt: at,
  removedAt: null,
});

const discussion = (overrides: Partial<GroupChatDiscussion> = {}): GroupChatDiscussion => ({
  id: discussionId,
  groupId,
  participants: [m1, m2],
  maxRounds: 3 as GroupChatDiscussion["maxRounds"],
  round: 1 as GroupChatDiscussion["round"],
  state: "running",
  endReason: null,
  promptMessageId: "msg_1" as GroupChatMessageId,
  signedOff: {},
  topic: "Pick a name",
  createdAt: at,
  endedAt: null,
  ...overrides,
});

const message = (seq: number, overrides: Partial<GroupChatMessage> = {}): GroupChatMessage => ({
  id: `msg_${seq}` as GroupChatMessageId,
  groupId,
  seq: seq as GroupChatMessage["seq"],
  author: { _tag: "operator" },
  kind: "chat",
  recipients: [],
  turnKey: `msg_${seq}`,
  triggerMessageId: null,
  discussionId: null,
  round: null,
  signOff: false,
  late: false,
  createdAt: at,
  text: `message ${seq}`,
  displayText: `message ${seq}`,
  ...overrides,
});

const prompt = message(1, {
  kind: "discussion_prompt",
  recipients: [m1, m2],
  turnKey: `${discussionId}:r1`,
  discussionId,
  round: 1 as GroupChatMessage["round"],
  text: "Pick a name",
  displayText: "Pick a name",
});

const reply = (
  seq: number,
  memberId: GroupChatMemberId,
  round: number,
  overrides: Partial<GroupChatMessage> = {},
): GroupChatMessage =>
  message(seq, {
    author: { _tag: "member", memberId },
    kind: "discussion_reply",
    turnKey: `${discussionId}:r${round}`,
    triggerMessageId: prompt.id,
    discussionId,
    round: round as GroupChatMessage["round"],
    ...overrides,
  });

const delivery = (
  memberId: GroupChatMemberId,
  round: number,
  overrides: Partial<GroupChatPageDelivery> = {},
): GroupChatPageDelivery => ({
  id: `dlv_${memberId}_r${round}` as GroupChatPageDelivery["id"],
  groupId,
  memberId,
  triggerMessageId: prompt.id,
  turnKey: `${discussionId}:r${round}`,
  discussionId,
  round: round as GroupChatPageDelivery["round"],
  state: "running",
  dispatch: "accepted",
  attempt: 1 as GroupChatPageDelivery["attempt"],
  fromSeq: 0 as GroupChatPageDelivery["fromSeq"],
  toSeq: 1 as GroupChatPageDelivery["toSeq"],
  runId: null,
  messageId: null,
  wait: null,
  withdrawn: null,
  replyMessageId: null,
  error: null,
  retryable: false,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const page = (extra: Partial<GroupChatGroupPage> = {}): GroupChatGroupPage => ({
  group: { id: groupId, title: "Crew", settledAt: null, createdAt: at, lastActivityAt: at },
  members: [member(m1, "ana"), member(m2, "bo")],
  discussions: [discussion()],
  messages: [prompt],
  deliveries: [],
  olderBefore: null,
  ...extra,
});

const loaded = (extra: Partial<GroupChatGroupPage> = {}) =>
  applyPage(emptyState, groupId, page(extra), "latest");

const viewOf = (state: StoreState) => state.groups.get(groupId)!;

type EventBody = GroupChatStreamEvent extends infer E
  ? E extends { readonly seq: number }
    ? Omit<E, "seq">
    : never
  : never;

const event = (state: StoreState, seq: number, body: EventBody) =>
  applyEvent(state, { ...body, seq } as GroupChatStreamEvent).state;

const head = ({ topic: _topic, ...rest }: GroupChatDiscussion) => rest;

const handles = (rows: ReadonlyArray<{ readonly member: GroupChatMember | undefined }>) =>
  rows.map((row) => row.member?.handle);

const END_REASONS = [
  "all signed off in round 2",
  "reached 3 rounds",
  "reached 1 round",
  "stopped by operator",
  "fewer than two participants left after removals",
  "no participants left (all were removed)",
];

describe("discussion view", () => {
  it("events advance the round counter", () => {
    const start = loaded();
    expect(discussionView(viewOf(start), discussionId)?.round).toBe(1);
    const advanced = event(start, 1, {
      _tag: "discussion",
      discussion: head(discussion({ round: 2 as GroupChatDiscussion["round"] })),
    });
    const view = discussionView(viewOf(advanced), discussionId);
    expect(view?.round).toBe(2);
    expect(view?.maxRounds).toBe(3);
    expect(view?.running).toBe(true);
  });

  it("a sign-off marks the member for that round only", () => {
    const earlier = loaded({
      discussions: [
        discussion({ round: 2 as GroupChatDiscussion["round"], signedOff: { [m1]: 1 as never } }),
      ],
      deliveries: [delivery(m1, 2), delivery(m2, 2)],
    });
    const before = discussionView(viewOf(earlier), discussionId)!;
    expect(handles(before.signedOff)).toEqual([]);
    expect(handles(before.replied)).toEqual([]);
    expect(handles(before.waitingOn)).toEqual(["ana", "bo"]);

    const signed = reply(2, m1, 2, { signOff: true, text: "Done", displayText: "Done" });
    const after = applyPage(
      earlier,
      groupId,
      page({
        discussions: [
          discussion({ round: 2 as GroupChatDiscussion["round"], signedOff: { [m1]: 1 as never } }),
        ],
        messages: [signed],
        deliveries: [
          delivery(m1, 2, {
            state: "replied",
            replyMessageId: signed.id,
            updatedAt: "2026-10-19T00:01:00.000Z",
          }),
        ],
      }),
      "since",
    );
    const view = discussionView(viewOf(after), discussionId)!;
    expect(handles(view.signedOff)).toEqual(["ana"]);
    expect(handles(view.replied)).toEqual(["ana"]);
    expect(handles(view.waitingOn)).toEqual(["bo"]);
    expect(view.participants[0]?.status._tag).toBe("signed_off");
  });

  it("each end reason renders its sentence", () => {
    expect(endSentence(discussion())).toBeNull();
    for (const reason of END_REASONS) {
      const ended = discussion({ state: "ended", endReason: reason, endedAt: at });
      expect(endSentence(ended)).toBe(`Ended: ${reason}.`);
    }
    const state = loaded({
      discussions: [discussion({ state: "ended", endReason: END_REASONS[1]!, endedAt: at })],
    });
    const view = discussionView(viewOf(state), discussionId)!;
    expect(view.running).toBe(false);
    expect(view.endSentence).toBe("Ended: reached 3 rounds.");
  });

  it("a reply after Stop is marked not counted", () => {
    const later = "2026-10-19T00:05:00.000Z";
    const late = reply(3, m2, 1, { late: true, createdAt: later });
    const stopped = discussion({ state: "ended", endReason: "stopped by operator", endedAt: at });
    expect(lateLabel(late, stopped)).toBe("arrived after Stop, not counted");
    const limit = discussion({ state: "ended", endReason: "reached 3 rounds", endedAt: at });
    expect(lateLabel(late, limit)).toBe("arrived after the discussion ended, not counted");
    expect(lateLabel(late, discussion())).toBe("arrived after the round, not counted");
    expect(lateLabel(reply(3, m2, 1), stopped)).toBeNull();
    expect(lateLabel(message(4, { kind: "reply", late: true }), undefined)).toBe("late reply");
  });

  it("a reply withdrawn before Stop keeps its own label after the discussion ends", () => {
    const withdrawnEarlier = reply(3, m2, 1, { late: true, createdAt: at });
    const stopped = discussion({
      state: "ended",
      endReason: "stopped by operator",
      endedAt: "2026-10-19T00:05:00.000Z",
    });
    expect(lateLabel(withdrawnEarlier, stopped)).toBe("arrived after the round, not counted");
  });

  it("a reply after Stop shows as late in the panel, never as replied", () => {
    const stopped = discussion({ state: "ended", endReason: "stopped by operator", endedAt: at });
    const lateReply = reply(2, m1, 1, { late: true });
    const state = loaded({
      discussions: [stopped],
      messages: [prompt, lateReply],
      deliveries: [
        delivery(m1, 1, {
          state: "replied",
          replyMessageId: lateReply.id,
          withdrawn: "discussion stopped",
        }),
        delivery(m2, 1, { withdrawn: "discussion stopped" }),
      ],
    });
    const view = discussionView(viewOf(state), discussionId)!;
    expect(view.participants.map((p) => p.status._tag)).toEqual(["late", "open"]);
    expect(handles(view.replied)).toEqual([]);
    expect(handles(view.signedOff)).toEqual([]);
  });

  it("a stopped reply holds the round until Retry", () => {
    const state = loaded({
      deliveries: [
        delivery(m1, 1, { state: "replied", replyMessageId: "msg_2" as GroupChatMessageId }),
        delivery(m2, 1, {
          state: "failed",
          wait: { _tag: "stopped_in_t3" },
          error: "T3 run interrupted",
          retryable: true,
        }),
      ],
      messages: [prompt, reply(2, m1, 1)],
    });
    const view = discussionView(viewOf(state), discussionId)!;
    expect(view.participants.map((p) => p.status._tag)).toEqual(["replied", "paused"]);
    expect(handles(view.waitingOn)).toEqual(["bo"]);
    expect(handles(view.replied)).toEqual(["ana"]);
  });

  it("the panel shows the running discussion, then the ended one until dismissed or the chat moves on", () => {
    const running = loaded({ messages: [message(0), prompt] });
    expect(panelDiscussion(viewOf(running), null)?.id).toBe(discussionId);

    const ended = discussion({
      state: "ended",
      endReason: "stopped by operator",
      endedAt: at,
    });
    const stopped = applyPage(
      event(running, 1, { _tag: "discussion", discussion: head(ended) }),
      groupId,
      page({
        discussions: [ended],
        messages: [
          message(2, {
            author: { _tag: "system" },
            kind: "system",
            turnKey: `${discussionId}:r1`,
            discussionId,
            round: 1 as GroupChatMessage["round"],
            displayText: "Discussion ended: stopped by operator.",
          }),
          reply(3, m2, 1, { late: true }),
        ],
      }),
      "since",
    );
    expect(panelDiscussion(viewOf(stopped), null)?.id).toBe(discussionId);
    expect(panelDiscussion(viewOf(stopped), discussionId)).toBeNull();

    const movedOn = applyPage(
      stopped,
      groupId,
      page({ discussions: [ended], messages: [message(4)] }),
      "since",
    );
    expect(panelDiscussion(viewOf(movedOn), null)).toBeNull();
  });

  it("round markers and the end line become dividers", () => {
    const running = discussion({ round: 2 as GroupChatDiscussion["round"] });
    expect(roundDivider(prompt, running)).toEqual({
      _tag: "round",
      round: 1,
      maxRounds: 3,
      caption: "each participant sees the topic",
    });
    const marker = message(5, {
      author: { _tag: "system" },
      kind: "system",
      discussionId,
      round: 2 as GroupChatMessage["round"],
      displayText: "Discussion round 2 of 3.",
    });
    expect(roundDivider(marker, running)).toEqual({
      _tag: "round",
      round: 2,
      maxRounds: 3,
      caption: "each participant sees the others' round 1 replies",
    });
    const ended = discussion({ state: "ended", endReason: "stopped by operator", endedAt: at });
    const endLine = message(6, {
      author: { _tag: "system" },
      kind: "system",
      discussionId,
      round: 2 as GroupChatMessage["round"],
      displayText:
        "Discussion ended: stopped by operator. 1 reply was already in progress and may still arrive; no further rounds will start.",
    });
    expect(roundDivider(endLine, ended)).toEqual({
      _tag: "ended",
      endSentence: "Ended: stopped by operator.",
      note: "1 reply was already in progress and may still arrive; no further rounds will start.",
    });
    expect(roundDivider(endLine, undefined)).toBeNull();
    expect(roundDivider(reply(7, m1, 2), running)).toBeNull();
  });
});
