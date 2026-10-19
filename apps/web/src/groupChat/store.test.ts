import type {
  GroupChatDeliveryHead,
  GroupChatGroupPage,
  GroupChatMessage,
  GroupChatMessageHead,
  GroupChatStreamEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyEvent, applyPage, emptyState, type StoreState, timelineRows } from "./store";

const groupId = "grp_1" as GroupChatGroupPage["group"]["id"];
const memberId = "mem_a" as GroupChatDeliveryHead["memberId"];

const group: GroupChatGroupPage["group"] = {
  id: groupId,
  title: "Crew",
  settledAt: null,
  createdAt: "2026-10-19T00:00:00.000Z",
  lastActivityAt: "2026-10-19T00:00:00.000Z",
};

const messageHead = (
  seq: number,
  overrides: Partial<GroupChatMessageHead> = {},
): GroupChatMessageHead => ({
  id: `msg_${seq}` as GroupChatMessageHead["id"],
  groupId,
  seq: seq as GroupChatMessageHead["seq"],
  author: { _tag: "operator" },
  kind: "chat",
  recipients: [memberId],
  turnKey: `msg_${seq}`,
  triggerMessageId: null,
  discussionId: null,
  round: null,
  signOff: false,
  late: false,
  createdAt: `2026-10-19T00:00:${String(seq).padStart(2, "0")}.000Z`,
  ...overrides,
});

const message = (seq: number, overrides: Partial<GroupChatMessage> = {}): GroupChatMessage => ({
  ...messageHead(seq),
  text: `message ${seq}`,
  displayText: `message ${seq}`,
  ...overrides,
});

const delivery = (
  id: string,
  seq: number,
  state: GroupChatDeliveryHead["state"],
  updatedAt: string,
): GroupChatDeliveryHead => ({
  id: id as GroupChatDeliveryHead["id"],
  groupId,
  memberId,
  triggerMessageId: `msg_${seq}` as GroupChatDeliveryHead["triggerMessageId"],
  turnKey: `msg_${seq}`,
  discussionId: null,
  round: null,
  state,
  dispatch: "accepted",
  attempt: 1 as GroupChatDeliveryHead["attempt"],
  fromSeq: 0 as GroupChatDeliveryHead["fromSeq"],
  toSeq: seq as GroupChatDeliveryHead["toSeq"],
  runId: null,
  messageId: null,
  wait: null,
  withdrawn: null,
  replyMessageId: null,
  error: null,
  retryable: false,
  createdAt: updatedAt,
  updatedAt,
});

const page = (
  seqs: ReadonlyArray<number>,
  extra: Partial<GroupChatGroupPage> = {},
): GroupChatGroupPage => ({
  group,
  members: [],
  discussions: [],
  messages: seqs.map((seq) => message(seq)),
  deliveries: [],
  olderBefore: null,
  ...extra,
});

const loaded = (seqs: ReadonlyArray<number>, extra: Partial<GroupChatGroupPage> = {}) =>
  applyPage(emptyState, groupId, page(seqs, extra), "latest");

const seqsOf = (state: StoreState) =>
  [...state.groups.get(groupId)!.messages.values()].map((m) => m.seq).sort((a, b) => a - b);

type EventBody = GroupChatStreamEvent extends infer E
  ? E extends { readonly seq: number }
    ? Omit<E, "seq">
    : never
  : never;

const event = (seq: number, body: EventBody): GroupChatStreamEvent =>
  ({ ...body, seq }) as GroupChatStreamEvent;

describe("group chat store", () => {
  it("deltas apply in sequence order", () => {
    const start = loaded([1]);
    const first = applyEvent(
      start,
      event(1, { _tag: "delivery", delivery: delivery("d1", 1, "queued", "2026-10-19T00:01:00Z") }),
    );
    const second = applyEvent(
      first.state,
      event(2, {
        _tag: "delivery",
        delivery: delivery("d1", 1, "running", "2026-10-19T00:02:00Z"),
      }),
    );
    const stale = applyEvent(
      second.state,
      event(1, { _tag: "delivery", delivery: delivery("d1", 1, "queued", "2026-10-19T00:01:00Z") }),
    );
    expect(stale.state).toBe(second.state);
    expect(stale.fetches).toEqual([]);
    expect(stale.state.groups.get(groupId)!.deliveries.get("d1" as never)!.state).toBe("running");
  });

  it("a sequence gap triggers one refetch", () => {
    const start = loaded([1, 2]);
    const first = applyEvent(start, event(7, { _tag: "group", group }));
    expect(first.fetches).toEqual([]);
    const gapped = applyEvent(first.state, event(9, { _tag: "group", group }));
    expect(gapped.fetches).toEqual([{ _tag: "latest", groupId }]);
    const next = applyEvent(gapped.state, event(10, { _tag: "group", group }));
    expect(next.fetches).toEqual([]);
  });

  it("a message head past the loaded end asks for the bodies after it, once", () => {
    const start = loaded([1, 2]);
    const first = applyEvent(start, event(1, { _tag: "message", message: messageHead(3) }));
    expect(first.fetches).toEqual([{ _tag: "since", groupId, seq: 2 }]);
    expect(seqsOf(first.state)).toEqual([1, 2]);
    const second = applyEvent(first.state, event(2, { _tag: "message", message: messageHead(4) }));
    expect(second.fetches).toEqual([]);
    const filled = applyPage(second.state, groupId, page([3, 4]), "since");
    expect(seqsOf(filled)).toEqual([1, 2, 3, 4]);
    expect(filled.groups.get(groupId)!.messages.get("msg_3" as never)!.text).toBe("message 3");
    expect(filled.groups.get(groupId)!.highSeq).toBe(4);
  });

  it("a head for a known message updates its flags and keeps its body", () => {
    const start = loaded([1, 2]);
    const applied = applyEvent(
      start,
      event(1, { _tag: "message", message: messageHead(2, { late: true }) }),
    );
    const updated = applied.state.groups.get(groupId)!.messages.get("msg_2" as never)!;
    expect(updated.late).toBe(true);
    expect(updated.text).toBe("message 2");
    expect(applied.fetches).toEqual([]);
  });

  it("an older page joins below the loaded range and moves the cursor", () => {
    const start = loaded([201, 202], { olderBefore: 201 as never });
    const withOlder = applyPage(
      start,
      groupId,
      page([199, 200], { olderBefore: 199 as never }),
      "older",
    );
    const view = withOlder.groups.get(groupId)!;
    expect(seqsOf(withOlder)).toEqual([199, 200, 201, 202]);
    expect([view.lowSeq, view.highSeq, view.olderBefore]).toEqual([199, 202, 199]);
  });

  it("a catch-up page that skips messages replaces what was loaded", () => {
    const start = loaded([1, 2]);
    const replaced = applyPage(
      start,
      groupId,
      page([300, 301], { olderBefore: 300 as never }),
      "since",
    );
    expect(seqsOf(replaced)).toEqual([300, 301]);
    expect(replaced.groups.get(groupId)!.olderBefore).toBe(300);
  });

  it("a page keeps the newer of its delivery and a delivery the stream already brought", () => {
    const start = applyEvent(
      loaded([1]),
      event(1, {
        _tag: "delivery",
        delivery: delivery("d1", 1, "replied", "2026-10-19T00:05:00Z"),
      }),
    ).state;
    const refreshed = applyPage(
      start,
      groupId,
      page([1], { deliveries: [delivery("d1", 1, "running", "2026-10-19T00:04:00Z")] }),
      "latest",
    );
    expect(refreshed.groups.get(groupId)!.deliveries.get("d1" as never)!.state).toBe("replied");
  });

  it("open deliveries sit after the last message of their turn", () => {
    const state = loaded([1, 2, 3], {
      deliveries: [
        delivery("d1", 1, "replied", "2026-10-19T00:01:00Z"),
        delivery("d2", 2, "running", "2026-10-19T00:02:00Z"),
      ],
      messages: [
        message(1),
        message(2),
        message(3, { turnKey: "msg_2", author: { _tag: "member", memberId } }),
      ],
    });
    const rows = timelineRows(state.groups.get(groupId)!);
    expect(rows.map((row) => row.id)).toEqual(["msg_1", "msg_2", "msg_3", "pending:d2"]);
  });
});
