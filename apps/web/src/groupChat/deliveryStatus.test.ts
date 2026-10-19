import type { GroupChatDeliveryHead } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeDelivery } from "./DeliveryStatus";

const head = (overrides: Partial<GroupChatDeliveryHead>): GroupChatDeliveryHead =>
  ({
    id: "d1",
    groupId: "g1",
    memberId: "m1",
    triggerMessageId: "msg_1",
    turnKey: "msg_1",
    discussionId: null,
    round: null,
    state: "pending",
    dispatch: "accepted",
    attempt: 1,
    fromSeq: 0,
    toSeq: 1,
    runId: null,
    messageId: null,
    wait: null,
    withdrawn: null,
    replyMessageId: null,
    error: null,
    retryable: false,
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...overrides,
  }) as GroupChatDeliveryHead;

const question = {
  _tag: "waiting_on_question",
  requestId: "req-1",
  questions: [{ id: "q", header: null, question: "Red or blue?", options: [], multiSelect: false }],
} as const;

describe("delivery status", () => {
  it("a member's question can be answered whatever the run's state", () => {
    for (const state of ["pending", "queued", "running"] as const) {
      const view = describeDelivery(head({ state, wait: question as never }));
      expect(view.answerable).toBe(true);
      expect(view.threadLink).toBe(true);
      expect(view.label).toBe("waiting on a question");
    }
  });

  it("a delivery stopped in T3 offers Retry, a failed one that cannot be retried does not", () => {
    const stopped = describeDelivery(
      head({
        state: "failed",
        wait: { _tag: "stopped_in_t3" },
        retryable: true,
        error: "T3 run interrupted",
      }),
    );
    expect(stopped.retry).toBe(true);
    expect(stopped.label).toBe("stopped in T3");
    const dead = describeDelivery(head({ state: "failed", error: "refused", retryable: false }));
    expect(dead.retry).toBe(false);
    const replied = describeDelivery(head({ state: "replied", retryable: true }));
    expect(replied.retry).toBe(false);
  });

  it("a held queue shows the engine's note", () => {
    const view = describeDelivery(
      head({
        state: "queued",
        wait: { _tag: "queue_held", note: "Resume thread releases the whole queue." },
      }),
    );
    expect(view.detail).toBe("Resume thread releases the whole queue.");
    expect(view.tone).toBe("warning");
  });
});
