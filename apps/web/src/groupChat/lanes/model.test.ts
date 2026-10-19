import type {
  GroupChatDiscussion,
  GroupChatMember,
  GroupChatMemberId,
  GroupChatMessage,
  GroupChatMessageId,
  GroupChatPageDelivery,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { GroupView } from "../store";
import {
  alignTurn,
  buildModel,
  CARD_GAP,
  focusFor,
  type LaneItems,
  mentions,
  OPERATOR_LANE,
  stepSelection,
} from "./model";

const groupId = "grp_1" as GroupView["group"]["id"];
const at = (n: number) => `2026-10-19T00:00:${String(n).padStart(2, "0")}.000Z`;
const mid = (id: string) => id as GroupChatMemberId;
const msgId = (id: string) => id as GroupChatMessageId;

const member = (id: string, handle: string, index: number): GroupChatMember => ({
  id: mid(id),
  groupId,
  handle,
  handleHistory: [],
  color: index,
  kind: {
    _tag: "t3",
    thread: { environmentId: "env" as never, threadId: `thr_${id}` as never, title: handle },
  },
  seenSeq: 0,
  introduced: true,
  toldRoster: null,
  addedAt: at(index),
  removedAt: null,
});

const alpha = member("mem_a", "alpha", 0);
const beta = member("mem_b", "beta", 1);
const gamma = member("mem_c", "gamma", 2);

const message = (
  seq: number,
  overrides: Partial<GroupChatMessage> & { readonly text?: string },
): GroupChatMessage => ({
  id: msgId(`msg_${seq}`),
  groupId,
  seq: seq as GroupChatMessage["seq"],
  author: { _tag: "operator" },
  kind: "chat",
  recipients: [alpha.id, beta.id, gamma.id],
  turnKey: `msg_${seq}`,
  triggerMessageId: null,
  discussionId: null,
  round: null,
  signOff: false,
  late: false,
  createdAt: at(seq),
  text: `message ${seq}`,
  displayText: `message ${seq}`,
  ...overrides,
});

const prompt = (seq: number) => message(seq, {});
const reply = (seq: number, from: GroupChatMember, promptSeq: number, text = `reply ${seq}`) =>
  message(seq, {
    author: { _tag: "member", memberId: from.id },
    kind: "reply",
    recipients: [],
    turnKey: `msg_${promptSeq}`,
    triggerMessageId: msgId(`msg_${promptSeq}`),
    text,
    displayText: text,
  });

const viewOf = (input: {
  readonly members?: ReadonlyArray<GroupChatMember>;
  readonly messages: ReadonlyArray<GroupChatMessage>;
  readonly deliveries?: ReadonlyArray<GroupChatPageDelivery>;
  readonly discussions?: ReadonlyArray<GroupChatDiscussion>;
}): GroupView => ({
  group: {
    id: groupId,
    title: "Crew",
    settledAt: null,
    createdAt: at(0),
    lastActivityAt: at(0),
  },
  members: new Map((input.members ?? [alpha, beta, gamma]).map((m) => [m.id, m])),
  discussions: new Map((input.discussions ?? []).map((d) => [d.id, d])),
  messages: new Map(input.messages.map((m) => [m.id, m])),
  deliveries: new Map((input.deliveries ?? []).map((d) => [d.id, d])),
  lowSeq: input.messages[0]?.seq ?? 0,
  highSeq: input.messages.at(-1)?.seq ?? 0,
  olderBefore: null,
  loadingOlder: false,
});

const packedItems = (view: GroupView) =>
  buildModel(view).blocks.flatMap((b) => (b.kind === "packed" ? b.items : []));

const turnIndexOf = (view: GroupView) =>
  new Map(buildModel(view).turns.map((turn) => [turn.key, turn.index] as const));

const pendingFor = (member: GroupChatMember, promptSeq: number): GroupChatPageDelivery => ({
  id: `dlv_${member.handle}_${promptSeq}` as GroupChatPageDelivery["id"],
  groupId,
  memberId: member.id,
  triggerMessageId: msgId(`msg_${promptSeq}`),
  turnKey: `msg_${promptSeq}`,
  discussionId: null,
  round: null,
  state: "running",
  dispatch: "accepted",
  attempt: 1 as GroupChatPageDelivery["attempt"],
  fromSeq: 0 as GroupChatPageDelivery["fromSeq"],
  toSeq: promptSeq as GroupChatPageDelivery["toSeq"],
  runId: null,
  messageId: null,
  withdrawn: null,
  replyMessageId: null,
  error: null,
  retryable: false,
  wait: null,
  createdAt: at(promptSeq),
  updatedAt: at(promptSeq),
});

describe("lanes model", () => {
  it("packing keeps each lane in time order", () => {
    const view = viewOf({
      messages: [
        prompt(1),
        reply(2, gamma, 1),
        reply(3, alpha, 1),
        prompt(4),
        reply(5, alpha, 4),
        reply(6, gamma, 4),
        reply(7, beta, 4),
      ],
    });
    const model = buildModel(view);
    expect(model.lanes.map((l) => l.id)).toEqual([OPERATOR_LANE, alpha.id, beta.id, gamma.id]);
    const seqsIn = (lane: string) =>
      packedItems(view)
        .filter((item) => item.lane === lane)
        .map((item) => (item.kind === "message" ? item.message.seq : -1));
    expect(seqsIn(OPERATOR_LANE)).toEqual([1, 4]);
    expect(seqsIn(alpha.id)).toEqual([3, 5]);
    expect(seqsIn(beta.id)).toEqual([7]);
    expect(seqsIn(gamma.id)).toEqual([2, 6]);
  });

  it("a turn groups the prompt with every reply it triggered", () => {
    const view = viewOf({
      messages: [prompt(1), reply(2, beta, 1), prompt(3), reply(4, alpha, 1), reply(5, alpha, 3)],
    });
    const model = buildModel(view);
    expect(model.turns.map((t) => t.messages.map((m) => m.seq))).toEqual([
      [1, 2, 4],
      [3, 5],
    ]);
    expect(model.turns[0]!.prompt).toBe(msgId("msg_1"));
    const focus = focusFor(model, { turnKey: "msg_1", messageId: msgId("msg_4") }, () => "c", "a");
    expect(focus.emphasis.get(msgId("msg_1"))).toBe("anchor");
    expect(focus.emphasis.get(msgId("msg_2"))).toBe("in");
    expect(focus.emphasis.get(msgId("msg_4"))).toBe("in");
    expect(focus.emphasis.has(msgId("msg_3"))).toBe(false);
    expect(focus.links.map((l) => [l.from, l.to, l.style])).toEqual([
      ["msg_1", "msg_4", "primary"],
      ["msg_4", "msg_2", "chain"],
    ]);
  });

  it("a discussion round is one turn", () => {
    const discussion: GroupChatDiscussion = {
      id: "dsc_1" as GroupChatDiscussion["id"],
      groupId,
      participants: [alpha.id, beta.id],
      maxRounds: 2,
      round: 2,
      state: "ended",
      endReason: "reached 2 rounds",
      promptMessageId: msgId("msg_1"),
      signedOff: {},
      topic: "tea or coffee",
      createdAt: at(1),
      endedAt: at(9),
    };
    const inRound = (seq: number, from: GroupChatMember, round: number, text: string) =>
      message(seq, {
        author: { _tag: "member", memberId: from.id },
        kind: "discussion_reply",
        recipients: [],
        turnKey: `dsc_1:r${round}`,
        triggerMessageId: msgId("msg_1"),
        discussionId: discussion.id,
        round: round as GroupChatMessage["round"],
        text,
        displayText: text,
      });
    const view = viewOf({
      discussions: [discussion],
      messages: [
        message(1, {
          kind: "discussion_prompt",
          turnKey: "dsc_1:r1",
          discussionId: discussion.id,
          round: 1 as GroupChatMessage["round"],
          recipients: [alpha.id, beta.id],
        }),
        inRound(2, alpha, 1, "coffee"),
        inRound(3, beta, 1, "tea"),
        message(4, {
          author: { _tag: "system" },
          kind: "system",
          turnKey: "dsc_1:r2",
          triggerMessageId: msgId("msg_1"),
          discussionId: discussion.id,
          round: 2 as GroupChatMessage["round"],
          displayText: "Discussion round 2 of 2.",
        }),
        inRound(5, alpha, 2, "tea then, as @beta said"),
        inRound(6, beta, 2, "tea"),
        message(7, {
          author: { _tag: "system" },
          kind: "system",
          turnKey: "dsc_1:r2",
          discussionId: discussion.id,
          round: 2 as GroupChatMessage["round"],
          displayText: "Discussion ended: reached 2 rounds.",
        }),
      ],
    });
    const model = buildModel(view);
    expect(model.turns.map((t) => [t.key, t.label, t.messages.map((m) => m.seq)])).toEqual([
      ["dsc_1:r1", "Round 1", [1, 2, 3]],
      ["dsc_1:r2", "Round 2", [4, 5, 6, 7]],
    ]);
    expect(
      model.blocks.map((b) => (b.kind === "divider" ? [b.label, b.detail] : "packed")),
    ).toEqual([
      "packed",
      ["Round 1 of 2", "each participant sees the topic"],
      "packed",
      ["Round 2 of 2", "each participant sees the others' round 1 replies"],
      "packed",
      ["Ended", "reached 2 rounds"],
    ]);
    const colorOf = (memberId: GroupChatMemberId) => `colour-${memberId}`;
    const focus = focusFor(model, { turnKey: "dsc_1:r2", messageId: msgId("msg_5") }, colorOf, "a");
    expect(focus.emphasis.get(msgId("msg_5"))).toBe("selected");
    expect(focus.emphasis.get(msgId("msg_3"))).toBe("source");
    expect(focus.emphasis.get(msgId("msg_1"))).toBe("started");
    expect(focus.links).toEqual([
      { from: "msg_3", to: "msg_5", style: "named", color: `colour-${beta.id}` },
    ]);
    expect(focus.statusLine).toBe("names 1 of the 1 round 1 reply it saw");
    const seen = focusFor(model, { turnKey: "dsc_1:r2", messageId: msgId("msg_6") }, colorOf, "a");
    expect(seen.links.map((l) => l.style)).toEqual(["seen"]);
    expect(seen.statusLine).toBe("names 0 of the 1 round 1 reply it saw");
    // A reply the engine left out of the envelopes, because it arrived late, is not a source.
    const lateView = viewOf({
      discussions: [discussion],
      messages: [...view.messages.values()].map((m) =>
        m.id === "msg_2" ? { ...m, late: true } : m,
      ),
    });
    const withLate = focusFor(
      buildModel(lateView),
      { turnKey: "dsc_1:r2", messageId: msgId("msg_6") },
      colorOf,
      "a",
    );
    expect(withLate.links).toEqual([]);
    expect(withLate.statusLine).toBe("round 2 reply");
    expect(stepSelection(model, { turnKey: "dsc_1:r1", messageId: null }, 1)).toEqual({
      turnKey: "dsc_1:r2",
      messageId: "msg_5",
    });
  });

  it("line-up offsets align the selected turn", () => {
    const view = viewOf({
      messages: [
        prompt(1),
        reply(2, alpha, 1),
        reply(3, beta, 1),
        prompt(4),
        reply(5, alpha, 4),
        reply(6, beta, 4),
      ],
    });
    const items = packedItems(view);
    const turnIndex = turnIndexOf(view);
    const lanesItems = (heights: Record<string, number[]>): LaneItems[] =>
      ([OPERATOR_LANE, alpha.id, beta.id, gamma.id] as const).map((lane) => ({
        lane,
        items: items.filter((item) => item.lane === lane),
        heights: heights[lane] ?? [],
      }));
    const spacers = alignTurn({
      lanesItems: lanesItems({
        [OPERATOR_LANE]: [40, 40],
        [alpha.id]: [200, 60],
        [beta.id]: [100, 60],
      }),
      turnKey: "msg_4",
      turnIndex,
    });
    expect(spacers).toEqual([
      { lane: OPERATOR_LANE, beforeIndex: 1, height: 160 },
      { lane: beta.id, beforeIndex: 1, height: 100 },
    ]);
  });

  it("a collapsed card's measured height feeds the layout", () => {
    const view = viewOf({
      messages: [prompt(1), reply(2, alpha, 1), prompt(3), reply(4, beta, 3), reply(5, alpha, 3)],
    });
    const items = packedItems(view);
    const align = (longCardHeight: number) =>
      alignTurn({
        lanesItems: ([OPERATOR_LANE, alpha.id, beta.id] as const).map((lane) => ({
          lane,
          items: items.filter((item) => item.lane === lane),
          heights: lane === alpha.id ? [longCardHeight, 50] : lane === beta.id ? [50] : [30, 30],
        })),
        turnKey: "msg_3",
        turnIndex: turnIndexOf(view),
      });
    expect(align(3_000)).toEqual([
      { lane: OPERATOR_LANE, beforeIndex: 1, height: 3_000 + CARD_GAP - (30 + CARD_GAP) },
      { lane: beta.id, beforeIndex: 0, height: 3_000 + CARD_GAP },
    ]);
    expect(align(400)).toEqual([
      { lane: OPERATOR_LANE, beforeIndex: 1, height: 400 + CARD_GAP - (30 + CARD_GAP) },
      { lane: beta.id, beforeIndex: 0, height: 400 + CARD_GAP },
    ]);
  });

  it("line-up leaves a pending reply to an earlier turn above the selected band", () => {
    // Beta is still answering turn 1 when turn 2 (prompt 3, alpha's reply 4) is selected.
    const view = viewOf({
      members: [alpha, beta],
      messages: [prompt(1), reply(2, alpha, 1), prompt(3), reply(4, alpha, 3)],
      deliveries: [pendingFor(beta, 1)],
    });
    const items = packedItems(view);
    const spacers = alignTurn({
      lanesItems: ([OPERATOR_LANE, alpha.id, beta.id] as const).map((lane) => ({
        lane,
        items: items.filter((item) => item.lane === lane),
        heights: lane === beta.id ? [40] : [30, 30],
      })),
      turnKey: "msg_3",
      turnIndex: turnIndexOf(view),
    });
    expect(spacers.find((s) => s.lane === beta.id)).toBeUndefined();
  });

  it("a removed member keeps a lane while its messages are loaded, and a pending delivery sits in its turn", () => {
    const gone = { ...gamma, removedAt: at(9) };
    const pending: GroupChatPageDelivery = {
      id: "dlv_1" as GroupChatPageDelivery["id"],
      groupId,
      memberId: beta.id,
      triggerMessageId: msgId("msg_3"),
      turnKey: "msg_3",
      discussionId: null,
      round: null,
      state: "running",
      dispatch: "accepted",
      attempt: 1 as GroupChatPageDelivery["attempt"],
      fromSeq: 0 as GroupChatPageDelivery["fromSeq"],
      toSeq: 3 as GroupChatPageDelivery["toSeq"],
      runId: null,
      messageId: null,
      withdrawn: null,
      replyMessageId: null,
      error: null,
      retryable: false,
      wait: null,
      createdAt: at(3),
      updatedAt: at(3),
    };
    const view = viewOf({
      members: [alpha, beta, gone],
      messages: [prompt(1), reply(2, gone, 1), prompt(3), reply(4, alpha, 3)],
      deliveries: [pending],
    });
    const model = buildModel(view);
    expect(model.lanes.map((l) => l.id)).toEqual([OPERATOR_LANE, alpha.id, beta.id, gone.id]);
    const betaItems = packedItems(view).filter((item) => item.lane === beta.id);
    expect(betaItems).toHaveLength(1);
    expect(betaItems[0]).toMatchObject({ kind: "pending", turnKey: "msg_3" });
  });

  it("mentions match a handle or a past handle as a whole word", () => {
    const renamed = { ...beta, handle: "bee", handleHistory: ["beta"] };
    expect(mentions("thanks @bee", renamed)).toBe(true);
    expect(mentions("as @beta said", renamed)).toBe(true);
    expect(mentions("@beta-2 said", renamed)).toBe(false);
    expect(mentions("email me@beta.example", renamed)).toBe(false);
  });
});
