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
  /** The operator message that opened the turn, or the topic of a discussion round. */
  readonly promptId: GroupChatMessageId | null;
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

const promptOf = (
  message: GroupChatMessage,
  discussion: GroupChatDiscussion | undefined,
): GroupChatMessageId | null =>
  discussion !== undefined
    ? discussion.promptMessageId
    : message.author._tag === "operator"
      ? message.id
      : message.triggerMessageId;

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

/**
 * Lanes, turns and blocks for one loaded group. The operator lane is first, then the active
 * members in the order they joined, then any removed member whose messages are loaded. A
 * discussion is a section: its topic sits alone above a round 1 divider, every later round marker
 * and the end marker divide all lanes, and everything else packs per lane in time order.
 */
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
      promptId: promptOf(message, discussion),
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
  /** The stroke. A chain, named or seen link takes the colour of the member it points at or comes from. */
  readonly color: string;
}

export interface Focus {
  readonly emphasis: ReadonlyMap<GroupChatMessageId, Emphasis>;
  readonly links: ReadonlyArray<Link>;
  /** Message ids in the order their highlight lights up, following the links. */
  readonly order: ReadonlyArray<GroupChatMessageId>;
  /** For a discussion reply, what it responded to, for the status line. */
  readonly summary: string | null;
}

const NO_FOCUS: Focus = { emphasis: new Map(), links: [], order: [], summary: null };

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

/**
 * What a selection emphasises and which links it draws. An ordinary turn chains from the prompt
 * to its replies in lane order. A discussion reply draws a line from each previous-round reply it
 * saw: solid when it names the author with `@`, dashed when it only saw the reply.
 */
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
  const order: GroupChatMessageId[] = [];
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
    if (turn.round === 1) {
      emphasis.set(discussion.promptMessageId, "anchor");
      links.push({
        from: discussion.promptMessageId,
        to: focused.id,
        style: "primary",
        color: accent,
      });
      order.push(discussion.promptMessageId, focused.id);
      return { emphasis, links, order, summary: "round 1 reply · responded to the topic" };
    }
    emphasis.set(discussion.promptMessageId, "started");
    const previous = model.turnByKey.get(`${discussion.id}:r${turn.round - 1}`);
    const sources = (previous?.messages ?? [])
      .filter((m) => m.kind === "discussion_reply" && memberOf(m) !== null && memberOf(m) !== self)
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
      order.push(source.id);
    }
    order.push(focused.id);
    const summary =
      sources.length === 0
        ? `round ${turn.round} reply`
        : `names ${named} of the ${sources.length} round ${turn.round - 1} ${
            sources.length === 1 ? "reply" : "replies"
          } it saw`;
    return { emphasis, links, order, summary };
  }

  // A later round has no prompt of its own, so its topic is only marked as started.
  const promptId = turn.round !== null && turn.round > 1 ? null : turn.promptId;
  if (turn.promptId !== null) emphasis.set(turn.promptId, promptId === null ? "started" : "anchor");
  const chain = [...(promptId === null ? [] : [promptId]), ...replies.map((m) => m.id)];
  for (let i = 1; i < chain.length; i++) {
    const to = model.messageById.get(chain[i]!)!;
    const primary = i === 1 && promptId !== null;
    links.push({
      from: chain[i - 1]!,
      to: chain[i]!,
      style: primary ? "primary" : "chain",
      color: primary ? accent : colorOf(memberOf(to)!),
    });
  }
  order.push(...chain);
  return { emphasis, links, order, summary: null };
}

export type AlignMode = "packed" | "line";
export type AlignStrategy = "lowest" | "least-travel";

export interface Spacer {
  readonly lane: LaneId;
  /** The index in the lane's items of the block, before which the spacer sits. */
  readonly before: number;
  readonly height: number;
}

/** Where each item of a lane sits in its block with no spacers: cumulative heights plus gaps. */
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
  /** Measured heights, one per item. A collapsed card measures as its preview. */
  readonly heights: ReadonlyArray<number>;
}

/**
 * Spacers that bring one turn's items onto one line inside one block. With `lowest`, the line
 * is the lowest of the turn's items and lanes only move down. With `least-travel`, the line is
 * where the focused item already sits, so the clicked card never moves.
 */
export function alignTurn(input: {
  readonly lanesItems: ReadonlyArray<LaneItems>;
  readonly turnKey: string;
  readonly focusMessageId: GroupChatMessageId | null;
  readonly strategy: AlignStrategy;
}): Spacer[] {
  const perLane = input.lanesItems.map((lane) => ({
    ...lane,
    tops: naturalTops(lane.heights),
    first: lane.items.findIndex((item) => item.turnKey === input.turnKey),
  }));
  const inTurn = perLane.filter((lane) => lane.first >= 0);
  if (inTurn.length === 0) return [];
  let line = Math.max(...inTurn.map((lane) => lane.tops[lane.first]!));
  if (input.strategy === "least-travel" && input.focusMessageId !== null) {
    const focusLane = perLane.find((lane) =>
      lane.items.some((item) => item.id === input.focusMessageId && item.turnKey === input.turnKey),
    );
    if (focusLane !== undefined) line = focusLane.tops[focusLane.first]!;
  }
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
      if (height > 0.5) spacers.push({ lane: lane.lane, before: lane.first, height });
      continue;
    }
    // A lane with nothing in this turn: its next later item sits just under the turn's band.
    const next = lane.items.findIndex((item) =>
      item.kind === "message" ? item.message.seq > lastSeq : true,
    );
    if (next < 0) continue;
    const height = line + band - lane.tops[next]!;
    if (height > 0.5) spacers.push({ lane: lane.lane, before: next, height });
  }
  return spacers;
}

/** The turn a keyboard step lands on. A later discussion round has no prompt, so it focuses its first reply. */
export function stepSelection(
  model: Model,
  current: Selection | null,
  delta: 1 | -1,
): Selection | null {
  if (model.turns.length === 0) return null;
  const turn = current === null ? undefined : model.turnByKey.get(current.turnKey);
  const index = turn?.index ?? (delta > 0 ? -1 : model.turns.length);
  const next = model.turns[Math.max(0, Math.min(model.turns.length - 1, index + delta))]!;
  return { turnKey: next.key, messageId: firstReplyOfLaterRound(next) };
}

export const firstReplyOfLaterRound = (turn: Turn): GroupChatMessageId | null =>
  turn.round !== null && turn.round > 1
    ? (turn.messages.find((m) => m.kind === "discussion_reply")?.id ?? null)
    : null;
