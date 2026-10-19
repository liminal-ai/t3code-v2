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

import { GroupChatRequestError } from "./api";
import {
  applyEvent,
  applyPage,
  applyStreamEvent,
  emptyState,
  forgetGroup,
  leaveGroup,
  loadOlder,
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
    expect(stale.owedReads).toEqual([]);
    expect(stale.state.groups.get(groupId)!.deliveries.get("d1" as never)!.state).toBe("running");
  });

  it("a sequence gap is reported once, and owes no catch-up read of its own", () => {
    const start = loaded([1, 2]);
    const first = applyEvent(start, event(7, { _tag: "group", group }));
    expect(first.gap).toBe(false);
    const gapped = applyEvent(first.state, event(9, { _tag: "message", message: messageHead(3) }));
    expect([gapped.gap, gapped.owedReads]).toEqual([true, []]);
    const next = applyEvent(gapped.state, event(10, { _tag: "group", group }));
    expect(next.gap).toBe(false);
  });

  it("a message head past the loaded end owes a read, and the bodies join when the page lands", () => {
    const start = loaded([1, 2]);
    const first = applyEvent(start, event(1, { _tag: "message", message: messageHead(3) }));
    expect(first.owedReads).toEqual([groupId]);
    expect(seqsOf(first.state)).toEqual([1, 2]);
    const second = applyEvent(first.state, event(2, { _tag: "message", message: messageHead(4) }));
    expect(second.owedReads).toEqual([groupId]);
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
    expect(applied.owedReads).toEqual([]);
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
    expect(asked.owedReads).toEqual([groupId]);
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
    const again = applyEvent(
      read,
      event(2, {
        _tag: "delivery",
        delivery: { ...questionHead, updatedAt: "2026-10-19T00:03:00Z" },
      }),
    );
    expect(again.owedReads).toEqual([]);
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
  });

  it("a failed latest-page read waits longer each time, up to half a minute", () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
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
    api.fetchGroupPage.mockResolvedValue(pageFor(id, []));
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
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(5);
    expect(api.fetchGroupPage).toHaveBeenLastCalledWith(id, { after: 4 });
    expect(readGroupView(id)?.highSeq).toBe(4);
  });

  it("a failed question read whose retry finds nothing new stops reading", async () => {
    const id = groupNamed("grp_question_retry");
    let reads = 0;
    api.fetchGroupPage.mockImplementation(() => {
      reads += 1;
      return reads > 20 ? new Promise(() => undefined) : Promise.resolve(pageFor(id, []));
    });
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    api.fetchGroupPage.mockRejectedValueOnce(new Error("tunnel"));
    applyStreamEvent(
      event(1, {
        _tag: "delivery",
        delivery: {
          ...delivery("d1", 1, "queued", "2026-10-19T00:02:00Z"),
          groupId: id,
          wait: { _tag: "waiting_on_question", requestId: "req-1" as never },
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(3);
  });

  it("a message head that arrives while a group's first page is out is read once the page lands", async () => {
    const id = groupNamed("grp_first_race");
    const held = heldRead();
    const first = showGroup(id);
    applyStreamEvent(event(1, { _tag: "message", message: messageHead(2, { groupId: id }) }));
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [2]));
    held().resolve(pageFor(id, [1]));
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(2);
    expect(api.fetchGroupPage).toHaveBeenLastCalledWith(id, { after: 1 });
    expect(readGroupView(id)?.highSeq).toBe(2);
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

  it("a head during a reconnect's latest read is read once that page lands, not lost behind the old catch-up", async () => {
    const id = groupNamed("grp_reopen_latest_head");
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    const old = heldRead();
    applyStreamEvent(event(1, { _tag: "message", message: messageHead(2, { groupId: id }) }));
    streamClosed();
    const fresh = heldRead();
    streamOpened();
    applyStreamEvent(event(1, { _tag: "message", message: messageHead(3, { groupId: id }) }));
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [3]));
    fresh().resolve(pageFor(id, [1, 2]));
    old().resolve(pageFor(id, [2]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readGroupView(id)?.highSeq).toBe(3);
  });

  it("a failed read of the heads that arrived during a group's first page is read again", async () => {
    const id = groupNamed("grp_first_heads_retry");
    const held = heldRead();
    const first = showGroup(id);
    applyStreamEvent(event(1, { _tag: "message", message: messageHead(2, { groupId: id }) }));
    api.fetchGroupPage.mockRejectedValueOnce(new Error("one dropped catch-up"));
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [2]));
    held().resolve(pageFor(id, [1]));
    await first;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readGroupView(id)?.highSeq).toBe(2);
  });

  it("a new question on the same delivery during its text read gets its own read", async () => {
    const id = groupNamed("grp_question_swapped");
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    const held = heldRead();
    const q1 = {
      ...delivery("dq", 1, "queued", "2026-10-19T00:01:00Z"),
      groupId: id,
      wait: { _tag: "waiting_on_question" as const, requestId: "q1" as never },
    };
    applyStreamEvent(event(1, { _tag: "delivery", delivery: q1 }));
    const q2 = {
      ...q1,
      updatedAt: "2026-10-19T00:02:00Z",
      wait: { ...q1.wait, requestId: "q2" as never },
    };
    applyStreamEvent(event(2, { _tag: "delivery", delivery: q2 }));
    const withText = (d: typeof q1) => ({
      ...d,
      wait: {
        ...d.wait,
        questions: [{ id: "q", header: null, question: "Which?", options: [], multiSelect: false }],
      },
    });
    api.fetchGroupPage.mockResolvedValueOnce({ ...pageFor(id, []), deliveries: [withText(q2)] });
    held().resolve({ ...pageFor(id, []), deliveries: [withText(q1)] });
    await vi.advanceTimersByTimeAsync(60_000);
    const wait = readGroupView(id)?.deliveries.get("dq" as never)?.wait;
    expect(wait?._tag === "waiting_on_question" && wait.requestId).toBe("q2");
    expect(wait?._tag === "waiting_on_question" && wait.questions.length).toBe(1);
  });

  it("a head seen while a body read is out is read once that read lands", async () => {
    const id = groupNamed("grp_head_during_read");
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    const held = heldRead();
    applyStreamEvent(event(1, { _tag: "message", message: messageHead(2, { groupId: id }) }));
    applyStreamEvent(event(2, { _tag: "message", message: messageHead(3, { groupId: id }) }));
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(2);
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [3]));
    held().resolve(pageFor(id, [2]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(3);
    expect(api.fetchGroupPage).toHaveBeenLastCalledWith(id, { after: 2 });
    expect(readGroupView(id)?.highSeq).toBe(3);
  });

  it("a head that arrives during a question's page read is still read after an empty page", async () => {
    const id = groupNamed("grp_head_during_question");
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    const held = heldRead();
    const asked = {
      ...delivery("d1", 1, "queued", "2026-10-19T00:02:00Z"),
      groupId: id,
      wait: { _tag: "waiting_on_question" as const, requestId: "req-1" as never },
    };
    applyStreamEvent(event(1, { _tag: "delivery", delivery: asked }));
    applyStreamEvent(event(2, { _tag: "message", message: messageHead(2, { groupId: id }) }));
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [2]));
    held().resolve({
      ...pageFor(id, []),
      deliveries: [
        {
          ...asked,
          wait: {
            ...asked.wait,
            questions: [
              { id: "q", header: null, question: "Red or blue?", options: [], multiSelect: false },
            ],
          },
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(3);
    expect(readGroupView(id)?.highSeq).toBe(2);
    const wait = readGroupView(id)?.deliveries.get("d1" as never)?.wait;
    expect(wait?._tag === "waiting_on_question" && wait.questions.length).toBe(1);
  });

  it("a latest read started while the stream was down does not overwrite the reopen's page", async () => {
    const id = groupNamed("grp_during_outage");
    streamClosed();
    const held = heldRead();
    const first = showGroup(id);
    api.fetchGroupPage.mockResolvedValueOnce(renamed(id, [1, 2]));
    streamOpened();
    await vi.advanceTimersByTimeAsync(0);
    expect(readGroupView(id)?.group.title).toBe("After restart");
    held().resolve(pageFor(id, [1]));
    await first;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readGroupView(id)?.group.title).toBe("After restart");
    expect(readGroupView(id)?.highSeq).toBe(2);
  });

  it("a stream gap reads the latest page, so a missed terminal delivery state lands", async () => {
    const id = groupNamed("grp_gap_terminal");
    const queued = { ...delivery("d1", 1, "queued", "2026-10-19T00:01:00Z"), groupId: id };
    const failed = { ...queued, state: "failed" as const, updatedAt: "2026-10-19T00:02:00Z" };
    api.fetchGroupPage.mockResolvedValueOnce({ ...pageFor(id, [1]), deliveries: [queued] });
    await showGroup(id);
    applyStreamEvent(event(1, { _tag: "group", group: { ...group, id } }));
    api.fetchGroupPage.mockImplementation((_groupId, query) =>
      Promise.resolve(
        (query as { after?: number }).after === undefined
          ? { ...pageFor(id, [1]), deliveries: [failed] }
          : pageFor(id, []),
      ),
    );
    applyStreamEvent(event(3, { _tag: "group", group: { ...group, id } }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readGroupView(id)?.deliveries.get("d1" as never)?.state).toBe("failed");
  });

  it("an older page adds its messages without undoing a streamed group rename", async () => {
    const id = groupNamed("grp_older_rename");
    api.fetchGroupPage.mockResolvedValueOnce({
      ...pageFor(id, [201, 202]),
      olderBefore: 201 as never,
    });
    await showGroup(id);
    const held = heldRead();
    const older = loadOlder(id);
    applyStreamEvent(event(1, { _tag: "group", group: { ...group, id, title: "New title" } }));
    held().resolve({ ...pageFor(id, [199, 200]), olderBefore: 199 as never });
    await expect(older).resolves.toBe(true);
    const view = readGroupView(id)!;
    expect(view.group.title).toBe("New title");
    expect([...view.messages.values()].map((m) => m.seq).sort((a, b) => a - b)).toEqual([
      199, 200, 201, 202,
    ]);
    expect([view.lowSeq, view.highSeq, view.olderBefore]).toEqual([199, 202, 199]);
  });

  it("a page that lands after the stream deleted its group writes nothing and stops its reads", async () => {
    const id = groupNamed("grp_deleted_read");
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    const held = heldRead();
    const late = showGroup(id);
    applyStreamEvent(event(1, { _tag: "group.deleted", groupId: id }));
    leaveGroup(id);
    api.fetchGroupPage.mockRejectedValue(new Error("no such group"));
    held().resolve(pageFor(id, [1]));
    await late;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readGroupView(id)).toBeNull();
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(2);
  });

  it("a read the server answers with no such group drops the group and reads it no more", async () => {
    const id = groupNamed("grp_gone");
    api.fetchGroupPage.mockResolvedValueOnce(pageFor(id, [1]));
    await showGroup(id);
    api.fetchGroupPage.mockRejectedValue(new GroupChatRequestError("No group chat group.", true));
    applyStreamEvent(event(1, { _tag: "message", message: messageHead(2, { groupId: id }) }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readGroupView(id)).toBeNull();
    expect(api.fetchGroupPage).toHaveBeenCalledTimes(2);
  });

  it("under arbitrary failures and reconnects, reads stay within one per event, failure and open, and the view catches up", async () => {
    const id = groupNamed("grp_bound");
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const PAGE = 4;
    let serverSeq = 0;
    let failures = 0;
    api.fetchGroupPage.mockImplementation((_groupId, query) => {
      if (random() < 0.3) {
        failures += 1;
        return Promise.reject(new Error("dropped"));
      }
      const after = (query as { after?: number }).after ?? 0;
      const from = Math.max(after + 1, serverSeq - PAGE + 1);
      const seqs = Array.from({ length: serverSeq - from + 1 }, (_, i) => from + i);
      return Promise.resolve({
        ...pageFor(id, seqs),
        olderBefore: from > after + 1 && from > 1 ? (from as never) : null,
      });
    });
    serverSeq = 1;
    await showGroup(id).catch(() => undefined);
    let events = 0;
    let opens = 1;
    let streamSeq = 0;
    for (let step = 0; step < 300; step += 1) {
      const roll = random();
      if (roll < 0.5) {
        serverSeq += 1;
        streamSeq += 1;
        events += 1;
        applyStreamEvent(
          event(streamSeq, { _tag: "message", message: messageHead(serverSeq, { groupId: id }) }),
        );
      } else if (roll < 0.6) {
        streamSeq += 2;
        events += 1;
        applyStreamEvent(event(streamSeq, { _tag: "group", group: { ...group, id } }));
      } else if (roll < 0.7) {
        streamClosed();
        streamOpened();
        streamSeq = 0;
        opens += 1;
      } else {
        await vi.advanceTimersByTimeAsync(roll < 0.85 ? 1 : 2_000);
      }
    }
    await vi.advanceTimersByTimeAsync(120_000);
    expect(readGroupView(id)?.highSeq).toBe(serverSeq);
    expect(api.fetchGroupPage.mock.calls.length).toBeLessThanOrEqual(events + failures + opens);
    expect(failures).toBeGreaterThan(10);
  });
});
