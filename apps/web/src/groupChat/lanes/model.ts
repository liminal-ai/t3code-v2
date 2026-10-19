import type {
  GroupChatDiscussion,
  GroupChatMember,
  GroupChatMemberId,
  GroupChatMessage,
  GroupChatMessageId,
  GroupChatPageDelivery,
} from "@t3tools/contracts";

import { type RoundDivider, roundDivider } from "../discussion/discussionView";
import { type GroupView, timelineRows } from "../store";

export const OPERATOR_LANE = "operator";
export const CARD_GAP = 10;

export type LaneId = typeof OPERATOR_LANE | GroupChatMemberId;

export interface Lane {
  readonly id: LaneId;
  readonly member: GroupChatMember | null;
}

export interface Turn {
  readonly key: string;
  readonly index: number;
  readonly messages: ReadonlyArray<GroupChatMessage>;
  readonly discussion: GroupChatDiscussion | null;
  readonly round: number | null;
  /** The message that opened the turn: an operator message, or the topic for round 1. */
  readonly prompt: GroupChatMessageId | null;
  /** A later round's topic. It started the discussion but did not open this turn. */
  readonly topic: GroupChatMessageId | null;
  readonly label: string;
}

export type LaneItem =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly message: GroupChatMessage;
      readonly lane: LaneId;
      readonly turnKey: string;
    }
  | {
      readonly kind: "pending";
      readonly id: string;
      readonly delivery: GroupChatPageDelivery;
      readonly lane: LaneId;
      readonly turnKey: string;
    };

export type Block =
  | { readonly kind: "packed"; readonly key: string; readonly items: ReadonlyArray<LaneItem> }
  | {
      readonly kind: "divider";
      readonly key: string;
      readonly turnKey: string;
      readonly label: string;
      readonly detail: string | null;
      readonly tone: "round" | "ended" | "note";
    };

export interface Model {
  readonly lanes: ReadonlyArray<Lane>;
  readonly turns: ReadonlyArray<Turn>;
  readonly turnByKey: ReadonlyMap<string, Turn>;
  readonly blocks: ReadonlyArray<Block>;
  readonly messageById: ReadonlyMap<GroupChatMessageId, GroupChatMessage>;
}

const laneOf = (message: GroupChatMessage): LaneId =>
  message.author._tag === "member" ? message.author.memberId : OPERATOR_LANE;

const opening = (
  message: GroupChatMessage,
  discussion: GroupChatDiscussion | undefined,
): Pick<Turn, "prompt" | "topic"> => {
  if (discussion === undefined) {
    return {
      prompt: message.author._tag === "operator" ? message.id : message.triggerMessageId,
      topic: null,
    };
  }
  return message.round === 1
    ? { prompt: discussion.promptMessageId, topic: null }
    : { prompt: null, topic: discussion.promptMessageId };
};

function dividerOf(
  message: GroupChatMessage,
  divider: RoundDivider | null,
  discussion: GroupChatDiscussion | undefined,
): Extract<Block, { kind: "divider" }> {
  const base = { kind: "divider", key: `d-${message.id}`, turnKey: message.turnKey } as const;
  if (divider?._tag === "round") {
    return {
      ...base,
      label: `Round ${divider.round} of ${divider.maxRounds}`,
      detail: divider.caption,
      tone: "round",
    };
  }
  if (divider?._tag === "ended") {
    const reason = discussion?.endReason ?? divider.endSentence;
    return {
      ...base,
      label: "Ended",
      detail: divider.note === null ? reason : `${reason} · ${divider.note}`,
      tone: "ended",
    };
  }
  return { ...base, label: message.displayText, detail: null, tone: "note" };
}

export function buildModel(view: GroupView): Model {
  const rows = timelineRows(view);
  const messageById = new Map<GroupChatMessageId, GroupChatMessage>();
  const laneIds: LaneId[] = [OPERATOR_LANE];
  for (const member of [...view.members.values()].sort((a, b) =>
    a.addedAt.localeCompare(b.addedAt),
  )) {
    if (member.removedAt === null) laneIds.push(member.id);
  }
  const addLane = (id: LaneId) => {
    if (!laneIds.includes(id)) laneIds.push(id);
  };

  const turns: Turn[] = [];
  const turnByKey = new Map<string, Turn>();
  const blocks: Block[] = [];
  let items: LaneItem[] = [];
  const open = () => {
    items = [];
    blocks.push({ kind: "packed", key: `b${blocks.length}`, items });
  };
  open();

  for (const row of rows) {
    if (row.kind === "pending") {
      addLane(row.delivery.memberId);
      items.push({
        kind: "pending",
        id: row.id,
        delivery: row.delivery,
        lane: row.delivery.memberId,
        turnKey: row.delivery.turnKey,
      });
      continue;
    }
    const message = row.message;
    messageById.set(message.id, message);
    const discussion =
      message.discussionId === null ? undefined : view.discussions.get(message.discussionId);
    const turn = turnByKey.get(message.turnKey) ?? {
      key: message.turnKey,
      index: turns.length,
      messages: [],
      discussion: discussion ?? null,
      round: discussion === undefined ? null : message.round,
      ...opening(message, discussion),
      label: discussion !== undefined && message.round !== null ? `Round ${message.round}` : "Turn",
    };
    if (!turnByKey.has(turn.key)) {
      turnByKey.set(turn.key, turn);
      turns.push(turn);
    }
    (turn.messages as GroupChatMessage[]).push(message);

    const divider = roundDivider(message, discussion);
    if (message.kind === "discussion_prompt") {
      open();
      items.push({
        kind: "message",
        id: message.id,
        message,
        lane: OPERATOR_LANE,
        turnKey: message.turnKey,
      });
      blocks.push(dividerOf(message, divider, discussion));
      open();
      continue;
    }
    if (message.kind === "system") {
      blocks.push(dividerOf(message, divider, discussion));
      open();
      continue;
    }
    const lane = laneOf(message);
    addLane(lane);
    items.push({ kind: "message", id: message.id, message, lane, turnKey: message.turnKey });
  }

  const lanes = laneIds.map((id) => ({
    id,
    member: id === OPERATOR_LANE ? null : (view.members.get(id) ?? null),
  }));
  return {
    lanes,
    turns,
    turnByKey,
    blocks: blocks.filter((b) => b.kind !== "packed" || b.items.length > 0),
    messageById,
  };
}

export interface Selection {
  readonly turnKey: string;
  readonly messageId: GroupChatMessageId | null;
}

export type Emphasis = "anchor" | "started" | "in" | "round" | "selected" | "source" | "seen";

export interface Link {
  readonly from: GroupChatMessageId;
  readonly to: GroupChatMessageId;
  readonly style: "primary" | "chain" | "named" | "seen";
  readonly color: string;
}

export interface Focus {
  readonly emphasis: ReadonlyMap<GroupChatMessageId, Emphasis>;
  readonly links: ReadonlyArray<Link>;
  readonly lightOrder: ReadonlyArray<GroupChatMessageId>;
  readonly statusLine: string | null;
}

const NO_FOCUS: Focus = { emphasis: new Map(), links: [], lightOrder: [], statusLine: null };

const laneIndex = (model: Model, message: GroupChatMessage) =>
  model.lanes.findIndex((lane) => lane.id === laneOf(message));

const byLane = (model: Model) => (a: GroupChatMessage, b: GroupChatMessage) =>
  laneIndex(model, a) - laneIndex(model, b) || a.seq - b.seq;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function mentions(text: string, member: GroupChatMember): boolean {
  return [member.handle, ...member.handleHistory].some((handle) =>
    new RegExp(`(^|[^\\w])@${escapeRegExp(handle)}(?![\\w-])`, "i").test(text),
  );
}

const memberOf = (message: GroupChatMessage): GroupChatMemberId | null =>
  message.author._tag === "member" ? message.author.memberId : null;

export function focusFor(
  model: Model,
  selection: Selection | null,
  colorOf: (memberId: GroupChatMemberId) => string,
  accent: string,
): Focus {
  if (selection === null) return NO_FOCUS;
  const turn = model.turnByKey.get(selection.turnKey);
  if (turn === undefined) return NO_FOCUS;
  const emphasis = new Map<GroupChatMessageId, Emphasis>();
  const links: Link[] = [];
  const lightOrder: GroupChatMessageId[] = [];
  const replies = turn.messages.filter((m) => m.author._tag === "member").sort(byLane(model));
  for (const m of turn.messages) if (m.kind !== "system") emphasis.set(m.id, "in");
  const discussion = turn.discussion;
  const focused =
    selection.messageId === null ? undefined : model.messageById.get(selection.messageId);
  const self = focused === undefined ? null : memberOf(focused);

  if (
    discussion !== null &&
    turn.round !== null &&
    focused !== undefined &&
    focused.kind === "discussion_reply" &&
    self !== null
  ) {
    for (const m of replies) if (m.id !== focused.id) emphasis.set(m.id, "round");
    emphasis.set(focused.id, "selected");
    if (turn.prompt !== null) {
      emphasis.set(turn.prompt, "anchor");
      links.push({ from: turn.prompt, to: focused.id, style: "primary", color: accent });
      lightOrder.push(turn.prompt, focused.id);
      return { emphasis, links, lightOrder, statusLine: "round 1 reply · responded to the topic" };
    }
    if (turn.topic !== null) emphasis.set(turn.topic, "started");
    const previous = model.turnByKey.get(`${discussion.id}:r${turn.round - 1}`);
    const sources = (previous?.messages ?? [])
      .filter(
        (m) =>
          m.kind === "discussion_reply" && !m.late && memberOf(m) !== null && memberOf(m) !== self,
      )
      .sort(byLane(model));
    let named = 0;
    for (const source of sources) {
      const memberId = memberOf(source)!;
      const member = model.lanes.find((lane) => lane.id === memberId)?.member;
      const isNamed = member !== null && member !== undefined && mentions(focused.text, member);
      if (isNamed) named += 1;
      emphasis.set(source.id, isNamed ? "source" : "seen");
      links.push({
        from: source.id,
        to: focused.id,
        style: isNamed ? "named" : "seen",
        color: colorOf(memberId),
      });
      lightOrder.push(source.id);
    }
    lightOrder.push(focused.id);
    const statusLine =
      sources.length === 0
        ? `round ${turn.round} reply`
        : `names ${named} of the ${sources.length} round ${turn.round - 1} ${
            sources.length === 1 ? "reply" : "replies"
          } it saw`;
    return { emphasis, links, lightOrder, statusLine };
  }

  if (turn.prompt !== null) emphasis.set(turn.prompt, "anchor");
  if (turn.topic !== null) emphasis.set(turn.topic, "started");
  const chain = [...(turn.prompt === null ? [] : [turn.prompt]), ...replies.map((m) => m.id)];
  for (let i = 1; i < chain.length; i++) {
    const to = model.messageById.get(chain[i]!)!;
    const primary = i === 1 && turn.prompt !== null;
    links.push({
      from: chain[i - 1]!,
      to: chain[i]!,
      style: primary ? "primary" : "chain",
      color: primary ? accent : colorOf(memberOf(to)!),
    });
  }
  lightOrder.push(...chain);
  return { emphasis, links, lightOrder, statusLine: null };
}

export type AlignMode = "packed" | "line";

export interface Spacer {
  readonly lane: LaneId;
  readonly beforeIndex: number;
  readonly height: number;
}

export function naturalTops(heights: ReadonlyArray<number>): number[] {
  const tops: number[] = [];
  let y = 0;
  for (const h of heights) {
    tops.push(y);
    y += h + CARD_GAP;
  }
  return tops;
}

export interface LaneItems {
  readonly lane: LaneId;
  readonly items: ReadonlyArray<LaneItem>;
  readonly heights: ReadonlyArray<number>;
}

export function alignTurn(input: {
  readonly lanesItems: ReadonlyArray<LaneItems>;
  readonly turnKey: string;
}): Spacer[] {
  const perLane = input.lanesItems.map((lane) => ({
    ...lane,
    tops: naturalTops(lane.heights),
    first: lane.items.findIndex((item) => item.turnKey === input.turnKey),
  }));
  const inTurn = perLane.filter((lane) => lane.first >= 0);
  if (inTurn.length === 0) return [];
  const line = Math.max(...inTurn.map((lane) => lane.tops[lane.first]!));
  const band = Math.max(...inTurn.map((lane) => lane.heights[lane.first]!)) + CARD_GAP;
  const lastSeq = Math.max(
    -1,
    ...inTurn.flatMap((lane) =>
      lane.items.flatMap((item) =>
        item.turnKey === input.turnKey && item.kind === "message" ? [item.message.seq] : [],
      ),
    ),
  );
  const spacers: Spacer[] = [];
  for (const lane of perLane) {
    if (lane.first >= 0) {
      const height = line - lane.tops[lane.first]!;
      if (height > 0.5) spacers.push({ lane: lane.lane, beforeIndex: lane.first, height });
      continue;
    }
    const next = lane.items.findIndex((item) =>
      item.kind === "message" ? item.message.seq > lastSeq : true,
    );
    if (next < 0) continue;
    const height = line + band - lane.tops[next]!;
    if (height > 0.5) spacers.push({ lane: lane.lane, beforeIndex: next, height });
  }
  return spacers;
}

export function stepSelection(
  model: Model,
  current: Selection | null,
  delta: 1 | -1,
): Selection | null {
  if (model.turns.length === 0) return null;
  const turn = current === null ? undefined : model.turnByKey.get(current.turnKey);
  const index = turn?.index ?? (delta > 0 ? -1 : model.turns.length);
  const next = model.turns[Math.max(0, Math.min(model.turns.length - 1, index + delta))]!;
  return { turnKey: next.key, messageId: focalOf(next) };
}

/** What a selection of the whole turn focuses: its prompt, or without one its first reply. */
export const focalOf = (turn: Turn): GroupChatMessageId | null =>
  turn.prompt ?? turn.messages.find((m) => m.kind === "discussion_reply")?.id ?? null;
