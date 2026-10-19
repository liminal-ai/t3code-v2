import type { GroupChatDelivery, GroupChatPageDelivery } from "@t3tools/contracts";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
  fetchDelivery: vi.fn<(deliveryId: string) => Promise<GroupChatDelivery>>(),
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  fetchDelivery: api.fetchDelivery,
}));

import { describeDelivery, useEnvelope } from "./DeliveryStatus";

const head = (overrides: Partial<GroupChatPageDelivery>): GroupChatPageDelivery =>
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
  }) as GroupChatPageDelivery;

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

  it("Stop is offered while an envelope has not replied, and not after", () => {
    for (const state of ["pending", "queued", "running"] as const) {
      expect(describeDelivery(head({ state })).stoppable).toBe(true);
    }
    for (const state of ["replied", "failed", "cancelled"] as const) {
      expect(describeDelivery(head({ state })).stoppable).toBe(false);
    }
  });

  it("Stop is offered on a reply stopped in T3, so a round can move on without a resend", () => {
    const stopped = describeDelivery(
      head({ state: "failed", wait: { _tag: "stopped_in_t3" }, retryable: true }),
    );
    expect(stopped.stoppable).toBe(true);
    expect(stopped.retry).toBe(true);
    expect(stopped.label).toBe("stopped in T3");
  });

  it("a failed refresh never shows the envelope read for an earlier head", async () => {
    function Probe({ delivery }: { delivery: GroupChatPageDelivery }) {
      const { body, failure } = useEnvelope(delivery);
      return createElement("output", null, JSON.stringify({ body, failure }));
    }
    const shown = (renderer: ReactTestRenderer) => {
      const rendered = renderer.toJSON();
      const text = rendered !== null && !Array.isArray(rendered) ? rendered.children?.[0] : null;
      return JSON.parse(String(text)) as {
        readonly body: GroupChatDelivery | null;
        readonly failure: string | null;
      };
    };
    const first = head({ updatedAt: "2026-10-19T00:00:01.000Z" });
    api.fetchDelivery.mockResolvedValueOnce({
      ...first,
      envelope: "Hello @a",
      sentText: null,
    } as GroupChatDelivery);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Probe, { delivery: first }));
    });
    expect(shown(renderer).body?.envelope).toBe("Hello @a");

    let fail!: (error: Error) => void;
    api.fetchDelivery.mockImplementationOnce(
      () =>
        new Promise<GroupChatDelivery>((_, reject) => {
          fail = reject;
        }),
    );
    const later = head({ updatedAt: "2026-10-19T00:00:02.000Z", attempt: 2 as never });
    await act(async () => {
      renderer.update(createElement(Probe, { delivery: later }));
    });
    expect(shown(renderer)).toEqual({ body: null, failure: null });

    await act(async () => {
      fail(new Error("The server did not answer in time."));
      await Promise.resolve();
    });
    expect(shown(renderer)).toEqual({ body: null, failure: "The server did not answer in time." });
    renderer.unmount();
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
