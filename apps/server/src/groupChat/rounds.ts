import type {
  GroupChatDeliveryState,
  GroupChatDiscussionState,
  GroupChatDispatchState,
} from "@t3tools/contracts";

import { isSignOff } from "./text.ts";

export type RoundDecision =
  | { action: "wait" }
  | { action: "end"; reason: string; signedOff: Record<string, number> }
  | { action: "next"; round: number; signedOff: Record<string, number> };

const OPEN: ReadonlySet<GroupChatDeliveryState> = new Set(["pending", "queued", "running"]);

export function decideRound(input: {
  round: number;
  maxRounds: number;
  stillIn: ReadonlyArray<string>;
  signedOff: Readonly<Record<string, number>>;
  deliveries: ReadonlyArray<{
    memberId: string;
    state: GroupChatDeliveryState;
    signOff: boolean;
    /** A participant whose reply the operator stopped in T3 holds the round until Retry or Stop. */
    paused?: boolean;
  }>;
}): RoundDecision | { action: "end"; reason: string } {
  const { round, maxRounds, stillIn } = input;
  if (stillIn.length < 2) {
    return {
      action: "end",
      reason:
        stillIn.length === 0
          ? "no participants left (all were removed)"
          : "fewer than two participants left after removals",
    };
  }
  const mine = input.deliveries.filter((d) => stillIn.includes(d.memberId));
  if (mine.length === 0 || mine.some((d) => OPEN.has(d.state) || d.paused === true)) {
    return { action: "wait" };
  }
  const signedOff = { ...input.signedOff };
  for (const d of mine) if (d.signOff) signedOff[d.memberId] = round;
  if (stillIn.every((id) => signedOff[id] === round))
    return { action: "end", reason: `all signed off in round ${round}`, signedOff };
  if (round >= maxRounds)
    return {
      action: "end",
      reason: `reached ${maxRounds} round${maxRounds === 1 ? "" : "s"}`,
      signedOff,
    };
  return { action: "next", round: round + 1, signedOff };
}

export function countsAsSignOff(input: {
  discussion: { state: GroupChatDiscussionState; round: number } | null;
  replyRound: number | null;
  memberRemoved: boolean;
  /** The operator stopped wanting this reply; it is shown late and ends nothing. */
  withdrawn: boolean;
  text: string;
}): boolean {
  const { discussion } = input;
  return Boolean(
    discussion &&
    discussion.state === "running" &&
    discussion.round === input.replyRound &&
    !input.memberRemoved &&
    !input.withdrawn &&
    isSignOff(input.text),
  );
}

export function gateSend(input: {
  state: GroupChatDeliveryState;
  withdrawn: string | null;
  memberRemoved: boolean;
  discussion: { state: GroupChatDiscussionState; round: number } | null;
  round: number | null;
}): { send: true } | { send: false; reason: string } {
  if (input.state !== "pending") return { send: false, reason: `delivery is ${input.state}` };
  if (input.withdrawn !== null) return { send: false, reason: `withdrawn: ${input.withdrawn}` };
  if (input.memberRemoved) return { send: false, reason: "member removed" };
  if (input.discussion && input.discussion.state !== "running")
    return { send: false, reason: "discussion ended" };
  if (input.discussion && input.discussion.round !== input.round)
    return { send: false, reason: "discussion moved past this round" };
  return { send: true };
}

export type WithdrawAction = "cancel" | "cancel-queued" | "keep";

export function onWithdraw(input: {
  state: GroupChatDeliveryState;
  dispatch: GroupChatDispatchState;
}): WithdrawAction {
  if (input.state === "pending" && input.dispatch === "unsent") return "cancel";
  if (input.state === "queued") return "cancel-queued";
  return "keep";
}
