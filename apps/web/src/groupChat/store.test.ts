import type {
  GroupChatDeliveryHead,
  GroupChatDiscussion,
  GroupChatGroupPage,
  GroupChatPageDelivery,
  GroupChatMessage,
  GroupChatMessageHead,
  GroupChatStreamEvent,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
  fetchGroupPage: vi.fn<(groupId: string, query: unknown) => Promise<GroupChatGroupPage>>(),
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  fetchGroupPage: api.fetchGroupPage,
  refreshGroupChatSnapshot: () => undefined,
}));

import {
  applyEvent,
  applyPage,
  applyStreamEvent,
  emptyState,
  followUpRead,
  forgetGroup,
  leaveGroup,
  loadOlder,
  readFailed,
  readGroupView,
  retryDelayMs,
  showGroup,
  type StoreState,
  streamClosed,
  streamOpened,
  timelineRows,
  turnsOf,
} from "./store";

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
  state: GroupChatPageDelivery["state"],
  updatedAt: string,
): GroupChatPageDelivery => ({
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

  it("a reply's prompt line names a discussion round and never a count of the loaded page", () => {
    const discussionId = "dsc_1" as GroupChatDiscussion["id"];
    const discussion: GroupChatDiscussion = {
      id: discussionId,
      groupId,
      participants: [memberId],
      maxRounds: 3 as never,
      round: 1 as never,
      state: "running",
      endReason: null,
      promptMessageId: "msg_203" as never,
      signedOff: {},
      topic: "Names",
      createdAt: "2026-10-19T00:03:00.000Z",
      endedAt: null,
    };
    const reply = { author: { _tag: "member", memberId } } as const;
    const state = loaded([201, 202, 203, 204], {
      olderBefore: 201 as never,
      discussions: [discussion],
      messages: [
        message(201),
        message(202, {
          ...reply,
          kind: "reply",
          turnKey: "msg_201",
          triggerMessageId: "msg_201" as never,
        }),
        message(203, {
          kind: "discussion_prompt",
          discussionId,
          round: 1 as never,
          turnKey: "dsc_1:1",
        }),
        message(204, {
          ...reply,
          kind: "discussion_reply",
          discussionId,
          round: 1 as never,
          turnKey: "dsc_1:1",
        }),
      ],
    });
    const turns = turnsOf(state.groups.get(groupId)!);
    expect(turns.get("msg_201")).toEqual({ label: null, promptId: "msg_201" });
    expect(turns.get("dsc_1:1")).toEqual({ label: "Round 1", promptId: "msg_203" });
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

describe("group chat store, heads and rows at the edges", () => {
  it("a head seen while a body read is out is read once that read lands", () => {
    const start = loaded([1]);
    const first = applyEvent(start, event(1, { _tag: "message", message: messageHead(2) }));
    expect(first.fetches).toEqual([{ _tag: "since", groupId, seq: 1 }]);
    const second = applyEvent(first.state, event(2, { _tag: "message", message: messageHead(3) }));
    expect(second.fetches).toEqual([]);
    const landed = applyPage(second.state, groupId, page([2]), "since");
    const next = followUpRead(landed, groupId);
    expect(next.fetches).toEqual([{ _tag: "since", groupId, seq: 2 }]);
    const settled = applyPage(next.state, groupId, page([3]), "since");
    expect(followUpRead(settled, groupId).fetches).toEqual([]);
    expect(seqsOf(settled)).toEqual([1, 2, 3]);
  });

  it("an open delivery whose turn is not loaded keeps a row at the end", () => {
    const state = loaded([201, 202], {
      olderBefore: 201 as never,
      deliveries: [delivery("d-old", 5, "queued", "2026-10-19T00:05:00Z")],
    });
    const rows = timelineRows(state.groups.get(groupId)!);
    expect(rows.map((row) => row.id)).toEqual(["msg_201", "msg_202", "pending:d-old"]);
  });

  it("a failed delivery that can be retried keeps a row, one that cannot does not", () => {
    const retryable = {
      ...delivery("d-stop", 1, "failed", "2026-10-19T00:06:00Z"),
      retryable: true,
    };
    const dead = delivery("d-dead", 1, "failed", "2026-10-19T00:06:00Z");
    const state = loaded([1], { deliveries: [retryable, dead] });
    const rows = timelineRows(state.groups.get(groupId)!);
    expect(rows.map((row) => row.id)).toEqual(["msg_1", "pending:d-stop"]);
  });
});

describe("group chat store, questions", () => {
  const question = {
    _tag: "waiting_on_question",
    requestId: "req-1",
    questions: [
      { id: "q", header: null, question: "Red or blue?", options: [], multiSelect: false },
    ],
  } as const;
  const questionHead: GroupChatDeliveryHead = {
    ...delivery("d1", 1, "queued", "2026-10-19T00:02:00Z"),
    wait: { _tag: "waiting_on_question", requestId: "req-1" as never },
  };

  it("a head that names a question reads the page for its text, then keeps it", () => {
    const start = loaded([1]);
    const asked = applyEvent(start, event(1, { _tag: "delivery", delivery: questionHead }));
    expect(asked.fetches).toEqual([{ _tag: "since", groupId, seq: 1 }]);
    const waiting = asked.state.groups.get(groupId)!.deliveries.get("d1" as never)!.wait;
    expect(waiting).toEqual({ _tag: "waiting_on_question", requestId: "req-1", questions: [] });
    const read = applyPage(
      asked.state,
      groupId,
      page([1], {
        deliveries: [
          { ...delivery("d1", 1, "queued", "2026-10-19T00:02:00Z"), wait: question as never },
        ],
      }),
      "since",
    );
    expect(followUpRead(read, groupId).fetches).toEqual([]);
    const again = applyEvent(
      read,
      event(2, {
        _tag: "delivery",
        delivery: { ...questionHead, updatedAt: "2026-10-19T00:03:00Z" },
      }),
    );
    expect(again.fetches).toEqual([]);
    const kept = again.state.groups.get(groupId)!.deliveries.get("d1" as never)!.wait;
    expect(kept?._tag === "waiting_on_question" && kept.questions[0]!.question).toBe(
      "Red or blue?",
    );
  });

  it("a catch-up page with no messages keeps the timeline and takes the question", () => {
    const start = loaded([1, 2]);
    const asked = applyEvent(start, event(1, { _tag: "delivery", delivery: questionHead }));
    const read = applyPage(
      asked.state,
      groupId,
      page([], {
        deliveries: [
          { ...delivery("d1", 1, "queued", "2026-10-19T00:02:00Z"), wait: question as never },
        ],
      }),
      "since",
    );
    const view = read.groups.get(groupId)!;
    expect(seqsOf(read)).toEqual([1, 2]);
    expect([view.lowSeq, view.highSeq]).toEqual([1, 2]);
    const wait = view.deliveries.get("d1" as never)!.wait;
    expect(wait?._tag === "waiting_on_question" && wait.questions.length).toBe(1);
    expect(followUpRead(read, groupId).fetches).toEqual([]);
  });

  it("a failed catch-up read is read again", () => {
    const start = loaded([1]);
    const asked = applyEvent(start, event(1, { _tag: "message", message: messageHead(2) }));
    expect(asked.fetches).toEqual([{ _tag: "since", groupId, seq: 1 }]);
    const failed = readFailed(asked.state, groupId);
    expect(followUpRead(failed, groupId).fetches).toEqual([{ _tag: "since", groupId, seq: 1 }]);
    const landed = applyPage(failed, groupId, page([2]), "since");
    expect(followUpRead(landed, groupId).fetches).toEqual([]);
  });

  it("a head that arrives during a question's page read is still read after an empty page", () => {
    const start = loaded([1]);
    const asked = applyEvent(start, event(1, { _tag: "delivery", delivery: questionHead }));
    expect(asked.fetches).toEqual([{ _tag: "since", groupId, seq: 1 }]);
    const announced = applyEvent(
      asked.state,
      event(2, { _tag: "message", message: messageHead(2) }),
    );
    expect(announced.fetches).toEqual([]);
    const empty = applyPage(
      announced.state,
      groupId,
      page([], {
        deliveries: [
          { ...delivery("d1", 1, "queued", "2026-10-19T00:02:00Z"), wait: question as never },
        ],
      }),
      "since",
    );
    expect(seqsOf(empty)).toEqual([1]);
    expect(followUpRead(empty, groupId).fetches).toEqual([{ _tag: "since", groupId, seq: 1 }]);
    const landed = applyPage(followUpRead(empty, groupId).state, groupId, page([2]), "since");
    expect(seqsOf(landed)).toEqual([1, 2]);
    expect(followUpRead(landed, groupId).fetches).toEqual([]);
  });

  it("a failed latest-page read waits longer each time, up to half a minute", () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it("a page that raced the question is read once more", () => {
    const start = loaded([1]);
    const asked = applyEvent(start, event(1, { _tag: "delivery", delivery: questionHead }));
    const stale = applyPage(
      asked.state,
      groupId,
      page([1], { deliveries: [delivery("d1", 1, "queued", "2026-10-19T00:01:00Z")] }),
      "since",
    );
    expect(followUpRead(stale, groupId).fetches).toEqual([{ _tag: "since", groupId, seq: 1 }]);
  });
});

describe("group chat store, read retries", () => {
  const pageFor = (id: GroupChatGroupPage["group"]["id"], seqs: ReadonlyArray<number>) => ({
    ...page(seqs),
    group: { ...group, id },
    messages: seqs.map((seq) => message(seq, { groupId: id })),
  });

  const shown: GroupChatGroupPage["group"]["id"][] = [];
  const groupNamed = (name: string) => {
    const id = name as GroupChatGroupPage["group"]["id"];
    shown.push(id);
    return id;
  };

  /** A read that never settles until the test says so, as a tunnel's dropped request would. */
  const heldRead = () => {
    let settle!: { resolve: (page: GroupChatGroupPage) => void; reject: (error: Error) => void };
    api.fetchGroupPage.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          settle = { resolve, reject };
        }),
    );
    return () => settle;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    api.fetchGroupPage.mockReset();
    streamOpened();
  });

  afterEach(() => {
    for (const id of shown.splice(0)) {
      leaveGroup(id);
      forgetGroup(id);
    }
    streamClosed();
    vi.useRealTimers();
  });

  it("a failed first read of a group is read again after a spaced wait", async () => {
    const id = groupNamed("grp_first");
    api.fetchGroupPage
      .mockRejectedValueOnce(new Error("tunnel"))
      .mockResolvedValueOnce(pageFor(id, [1]));
    await expect(showGroup(id)).rejects.toThrow("tunnel");
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(2);
    expect(readGroupView(id)?.highSeq).toBe(1);
  });

  it("leaving the page stops its group's retry", async () => {
    const id = groupNamed("grp_left");
    api.fetchGroupPage.mockRejectedValue(new Error("tunnel"));
    await expect(showGroup(id)).rejects.toThrow("tunnel");
    leaveGroup(id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(1);
  });

  it("leaving the page while its first read is out stops its retry too", async () => {
    const id = groupNamed("grp_left_inflight");
    const held = heldRead();
    const first = showGroup(id);
    leaveGroup(id);
    held().reject(new Error("tunnel"));
    await expect(first).rejects.toThrow("tunnel");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(1);
  });

  it("a failed catch-up read is read again while the stream is up, and stops with it", async () => {
    const id = groupNamed("grp_catchup");
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    api.fetchGroupPage.mockRejectedValue(new Error("tunnel"));
    applyStreamEvent(event(1, { _tag: "message", message: messageHead(2, { groupId: id }) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(2);
    expect(api.fetchGroupPage).toHaveBeenLastCalledWith(id, { after: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(3);
    streamClosed();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(3);
  });

  it("a catch-up read that fails after the stream closed schedules nothing", async () => {
    const id = groupNamed("grp_inflight_stop");
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    const held = heldRead();
    applyStreamEvent(event(1, { _tag: "message", message: messageHead(2, { groupId: id }) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(2);
    streamClosed();
    api.fetchGroupPage.mockRejectedValue(new Error("still offline"));
    held().reject(new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(2);
  });

  it("a catch-up page that lands after the stream closed leaves the group to the reopen", async () => {
    const id = groupNamed("grp_inflight_ok");
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    const held = heldRead();
    applyStreamEvent(event(1, { _tag: "message", message: messageHead(2, { groupId: id }) }));
    applyStreamEvent(event(2, { _tag: "message", message: messageHead(3, { groupId: id }) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(2);
    streamClosed();
    held().resolve(pageFor(id, [2]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(2);
    expect(readGroupView(id)?.highSeq).toBe(1);
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1, 2, 3]));
    streamOpened();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(3);
    expect(api.fetchGroupPage).toHaveBeenLastCalledWith(id, {});
    expect(readGroupView(id)?.highSeq).toBe(3);
  });

  it("the stream's reopen reads a group whose first page failed", async () => {
    const id = groupNamed("grp_first_reconnect");
    api.fetchGroupPage
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(pageFor(id, [1]));
    await expect(showGroup(id)).rejects.toThrow("503");
    streamClosed();
    streamOpened();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(2);
    expect(readGroupView(id)?.highSeq).toBe(1);
  });

  const renamed = (id: GroupChatGroupPage["group"]["id"], seqs: ReadonlyArray<number>) => ({
    ...pageFor(id, seqs),
    group: { ...group, id, title: "After restart" },
  });

  it("a latest page read before the stream closed does not overwrite the reopen's page", async () => {
    const id = groupNamed("grp_stale_latest");
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    const held = heldRead();
    const stale = showGroup(id);
    streamClosed();
    api.fetchGroupPage.mockResolvedValueOnce(renamed(id, [1, 2, 3]));
    streamOpened();
    await vi.advanceTimersByTimeAsync(0);
    expect(readGroupView(id)?.group.title).toBe("After restart");
    held().resolve(pageFor(id, [2]));
    await stale;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(3);
    expect(readGroupView(id)?.group.title).toBe("After restart");
    expect(readGroupView(id)?.highSeq).toBe(3);
  });

  it("a catch-up page read before the stream closed does not overwrite the reopen's page", async () => {
    const id = groupNamed("grp_stale_catchup");
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    const held = heldRead();
    applyStreamEvent(event(1, { _tag: "message", message: messageHead(2, { groupId: id }) }));
    await vi.advanceTimersByTimeAsync(0);
    streamClosed();
    api.fetchGroupPage.mockResolvedValueOnce(renamed(id, [1, 2, 3]));
    streamOpened();
    await vi.advanceTimersByTimeAsync(0);
    expect(readGroupView(id)?.group.title).toBe("After restart");
    held().resolve(pageFor(id, [2]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(3);
    expect(readGroupView(id)?.group.title).toBe("After restart");
  });

  it("a catch-up read that fails after the stream reopened leaves the reopen's read in flight", async () => {
    const id = groupNamed("grp_stale_failure");
    api.fetchGroupPage.mockRejectedValue(new Error("a read the test did not expect"));
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    const stale = heldRead();
    applyStreamEvent(event(1, { _tag: "message", message: messageHead(2, { groupId: id }) }));
    await vi.advanceTimersByTimeAsync(0);
    streamClosed();
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1, 2]));
    streamOpened();
    await vi.advanceTimersByTimeAsync(0);
    const current = heldRead();
    applyStreamEvent(event(1, { _tag: "message", message: messageHead(3, { groupId: id }) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(4);
    stale().reject(new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(0);
    applyStreamEvent(event(2, { _tag: "message", message: messageHead(4, { groupId: id }) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(4);
    current().resolve(pageFor(id, [3, 4]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(4);
    expect(readGroupView(id)?.highSeq).toBe(4);
  });

  it("an older page read before the stream closed does not overwrite the reopen's page", async () => {
    const id = groupNamed("grp_stale_older");
    api.fetchGroupPage.mockResolvedValueOnce({
      ...pageFor(id, [201, 202]),
      olderBefore: 201 as never,
    });
    await showGroup(id);
    const held = heldRead();
    const older = loadOlder(id);
    streamClosed();
    api.fetchGroupPage.mockResolvedValueOnce(renamed(id, [201, 202, 203]));
    streamOpened();
    await vi.advanceTimersByTimeAsync(0);
    held().resolve(pageFor(id, [199, 200]));
    await expect(older).resolves.toBe(false);
    expect(readGroupView(id)?.group.title).toBe("After restart");
    expect(readGroupView(id)?.loadingOlder).toBe(false);
  });
});
