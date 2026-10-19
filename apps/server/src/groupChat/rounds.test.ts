import type { GroupChatDeliveryState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shorten } from "./envelope.ts";
import { countsAsSignOff, decideRound, gateSend, onWithdraw } from "./rounds.ts";
import { isSignOff } from "./text.ts";

const d = (memberId: string, state: GroupChatDeliveryState, signOff = false) => ({
  memberId,
  state,
  signOff,
});

describe("group chat rounds", () => {
  it("decideRound waits for open deliveries, ends on all sign-offs or round N, and ignores removed members", () => {
    const base = { round: 2, maxRounds: 3, stillIn: ["a", "b"], signedOff: {} };
    expect(decideRound({ ...base, deliveries: [d("a", "replied"), d("b", "queued")] })).toEqual({
      action: "wait",
    });
    expect(
      decideRound({
        ...base,
        deliveries: [d("a", "replied"), { ...d("b", "failed"), paused: true }],
      }),
    ).toEqual({ action: "wait" });
    expect(decideRound({ ...base, deliveries: [d("a", "replied"), d("b", "running")] })).toEqual({
      action: "wait",
    });
    expect(decideRound({ ...base, deliveries: [] })).toEqual({ action: "wait" });
    expect(
      decideRound({
        ...base,
        deliveries: [d("a", "replied"), { ...d("b", "failed"), paused: true }],
      }),
    ).toEqual({ action: "wait" });
    expect(
      decideRound({ ...base, deliveries: [d("a", "replied", true), d("b", "replied", true)] }),
    ).toEqual({
      action: "end",
      reason: "all signed off in round 2",
      signedOff: { a: 2, b: 2 },
    });
    expect(
      decideRound({ ...base, deliveries: [d("a", "replied", true), d("b", "failed")] }),
    ).toEqual({ action: "next", round: 3, signedOff: { a: 2 } });
    expect(
      (
        decideRound({
          ...base,
          round: 3,
          deliveries: [d("a", "replied"), d("b", "replied")],
        }) as { reason: string }
      ).reason,
    ).toBe("reached 3 rounds");
    expect(
      decideRound({
        ...base,
        stillIn: ["a", "b"],
        deliveries: [d("a", "replied"), d("b", "replied"), d("c", "running")],
      }).action,
    ).toBe("next");
    expect(
      (decideRound({ ...base, stillIn: ["a"], deliveries: [] }) as { reason: string }).reason,
    ).toBe("fewer than two participants left after removals");
    expect(
      (decideRound({ ...base, stillIn: [], deliveries: [] }) as { reason: string }).reason,
    ).toBe("no participants left (all were removed)");
    expect(
      decideRound({
        ...base,
        signedOff: { b: 1 },
        deliveries: [d("a", "replied", true), d("b", "replied")],
      }).action,
    ).toBe("next");
  });

  it("gateSend lets only a pending, wanted delivery out", () => {
    const ok = {
      state: "pending" as const,
      withdrawn: null,
      memberRemoved: false,
      discussion: { state: "running" as const, round: 2 },
      round: 2,
    };
    expect(gateSend(ok)).toEqual({ send: true });
    expect(gateSend({ ...ok, discussion: null, round: null })).toEqual({ send: true });
    expect(gateSend({ ...ok, state: "cancelled" }).send).toBe(false);
    expect(gateSend({ ...ok, withdrawn: "operator stopped it" })).toEqual({
      send: false,
      reason: "withdrawn: operator stopped it",
    });
    expect(gateSend({ ...ok, memberRemoved: true })).toEqual({
      send: false,
      reason: "member removed",
    });
    expect(gateSend({ ...ok, discussion: { state: "ended", round: 2 } })).toEqual({
      send: false,
      reason: "discussion ended",
    });
    expect(gateSend({ ...ok, round: 1 }).send).toBe(false);
  });

  it("onWithdraw: unsent is cancelled, queued in T3 is cancelled there, anything else is kept", () => {
    expect(onWithdraw({ state: "pending", dispatch: "unsent" })).toBe("cancel");
    expect(onWithdraw({ state: "pending", dispatch: "sending" })).toBe("keep");
    expect(onWithdraw({ state: "pending", dispatch: "unknown" })).toBe("keep");
    expect(onWithdraw({ state: "queued", dispatch: "accepted" })).toBe("cancel-queued");
    expect(onWithdraw({ state: "running", dispatch: "accepted" })).toBe("keep");
    expect(onWithdraw({ state: "replied", dispatch: "accepted" })).toBe("keep");
    expect(onWithdraw({ state: "failed", dispatch: "unknown" })).toBe("keep");
    expect(onWithdraw({ state: "cancelled", dispatch: "unsent" })).toBe("keep");
  });

  it("countsAsSignOff only inside the open round of a running discussion", () => {
    const text = "Done.\n[[SIGN-OFF]]";
    const running = { state: "running" as const, round: 2 };
    expect(
      countsAsSignOff({ discussion: running, replyRound: 2, memberRemoved: false, text }),
    ).toBe(true);
    expect(
      countsAsSignOff({ discussion: running, replyRound: 1, memberRemoved: false, text }),
    ).toBe(false);
    expect(
      countsAsSignOff({
        discussion: { state: "ended", round: 2 },
        replyRound: 2,
        memberRemoved: false,
        text,
      }),
    ).toBe(false);
    expect(countsAsSignOff({ discussion: running, replyRound: 2, memberRemoved: true, text })).toBe(
      false,
    );
    expect(
      countsAsSignOff({ discussion: null, replyRound: null, memberRemoved: false, text }),
    ).toBe(false);
  });

  it("item 5: the sign-off marker inside a code fence or an HTML comment is quoted text", () => {
    expect(isSignOff("Agreed.\n[[SIGN-OFF]]")).toBe(true);
    expect(
      isSignOff("```js\nx()\n```\nAgreed.\n[[SIGN-OFF]]"),
      "a closed fence before it is fine",
    ).toBe(true);
    expect(
      isSignOff("Here is how to sign off:\n```\n[[SIGN-OFF]]"),
      "inside an unclosed backtick fence",
    ).toBe(false);
    expect(
      isSignOff("Example:\n~~~~\nreply\n[[SIGN-OFF]]\n"),
      "inside an unclosed tilde fence",
    ).toBe(false);
    expect(
      isSignOff("```\nnot closed by ~~~\n~~~\n[[SIGN-OFF]]"),
      "a different fence character does not close it",
    ).toBe(false);
    expect(isSignOff("Draft follows <!--\n[[SIGN-OFF]]"), "inside an open HTML comment").toBe(
      false,
    );
    expect(isSignOff("<!-- note --> ok\n[[SIGN-OFF]]"), "a closed comment before it is fine").toBe(
      true,
    );
    expect(isSignOff("Still going [[SIGN-OFF]] maybe later")).toBe(false);
  });

  it("item 7: a shortened message keeps its head and its tail, with a note", () => {
    const text = `HEAD ${"x".repeat(20_000)} TAIL-CONCLUSION`;
    const out = shorten(text, 6000);
    expect(out.startsWith("HEAD ")).toBe(true);
    expect(out.endsWith("TAIL-CONCLUSION")).toBe(true);
    expect(out).toMatch(
      /\[shortened by the group-chat app: 14021 of 20021 characters left out here; the start and the end are shown\]/,
    );
    expect(out.length).toBeLessThan(6200);
  });
});
