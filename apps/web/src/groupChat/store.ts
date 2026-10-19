import { useAtomValue } from "@effect/atom-react";
import type {
  GroupChatDelivery,
  GroupChatDeliveryHead,
  GroupChatDeliveryId,
  GroupChatPageDelivery,
  GroupChatDiscussion,
  GroupChatDiscussionId,
  GroupChatGroup,
  GroupChatGroupId,
  GroupChatGroupPage,
  GroupChatMember,
  GroupChatMemberId,
  GroupChatMessage,
  GroupChatMessageId,
  GroupChatStreamEvent,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { fetchGroupPage, GroupChatRequestError, refreshGroupChatSnapshot } from "./api";

export interface GroupView {
  readonly group: GroupChatGroup;
  readonly members: ReadonlyMap<GroupChatMemberId, GroupChatMember>;
  readonly discussions: ReadonlyMap<GroupChatDiscussionId, GroupChatDiscussion>;
  readonly messages: ReadonlyMap<GroupChatMessageId, GroupChatMessage>;
  readonly deliveries: ReadonlyMap<GroupChatDeliveryId, GroupChatPageDelivery>;
  readonly lowSeq: number;
  readonly highSeq: number;
  readonly olderBefore: number | null;
  readonly loadingOlder: boolean;
}

export interface StoreState {
  readonly lastEventSeq: number | null;
  readonly groups: ReadonlyMap<GroupChatGroupId, GroupView>;
}

export type PageMode = "latest" | "older" | "since";

interface Changed {
  readonly state: StoreState;
  readonly owedReads: ReadonlyArray<GroupChatGroupId>;
  readonly snapshotChanged: boolean;
}

export interface Applied extends Changed {
  readonly gap: boolean;
}

export const emptyState: StoreState = { lastEventSeq: null, groups: new Map() };

const byId = <T extends { readonly id: string }>(items: ReadonlyArray<T>) =>
  new Map(items.map((item) => [item.id, item] as const)) as ReadonlyMap<T["id"], T>;

const withGroup = (
  state: StoreState,
  groupId: GroupChatGroupId,
  view: GroupView | null,
): StoreState => {
  const groups = new Map(state.groups);
  if (view === null) groups.delete(groupId);
  else groups.set(groupId, view);
  return { ...state, groups };
};

const newerDelivery = (
  existing: GroupChatPageDelivery | undefined,
  incoming: GroupChatPageDelivery,
): GroupChatPageDelivery =>
  existing !== undefined && existing.updatedAt > incoming.updatedAt ? existing : incoming;

const mergeDeliveries = (
  existing: ReadonlyMap<GroupChatDeliveryId, GroupChatPageDelivery>,
  incoming: ReadonlyArray<GroupChatPageDelivery>,
) => {
  const merged = new Map(existing);
  for (const d of incoming) merged.set(d.id, newerDelivery(existing.get(d.id), d));
  return merged;
};

/**
 * A stream head names a question by its request id only. The text stays when the store already
 * holds it for that request; otherwise the delivery waits with no questions until a page read.
 */
const fromHead = (
  existing: GroupChatPageDelivery | undefined,
  head: GroupChatDeliveryHead,
): GroupChatPageDelivery => {
  if (head.wait?._tag !== "waiting_on_question") return { ...head, wait: head.wait };
  const known = existing?.wait;
  return {
    ...head,
    wait:
      known?._tag === "waiting_on_question" && known.requestId === head.wait.requestId
        ? known
        : { _tag: "waiting_on_question", requestId: head.wait.requestId, questions: [] },
  };
};

const questionTextMissing = (d: GroupChatPageDelivery) =>
  d.wait?._tag === "waiting_on_question" && d.wait.questions.length === 0;

const fromPage = (page: GroupChatGroupPage, deliveries: GroupView["deliveries"]): GroupView => ({
  group: page.group,
  members: byId(page.members),
  discussions: byId(page.discussions),
  messages: byId(page.messages),
  deliveries,
  lowSeq: page.messages[0]?.seq ?? 0,
  highSeq: page.messages.at(-1)?.seq ?? 0,
  olderBefore: page.olderBefore,
  loadingOlder: false,
});

const withOlder = (
  current: GroupView,
  page: Pick<GroupChatGroupPage, "messages" | "deliveries" | "olderBefore">,
): GroupView => {
  const messages = new Map(current.messages);
  for (const m of page.messages) messages.set(m.id, m);
  return {
    ...current,
    messages,
    deliveries: mergeDeliveries(current.deliveries, page.deliveries),
    lowSeq: page.messages[0]?.seq ?? current.lowSeq,
    olderBefore: page.olderBefore,
  };
};

export function applyPage(
  state: StoreState,
  groupId: GroupChatGroupId,
  page: GroupChatGroupPage,
  mode: PageMode,
): StoreState {
  const current = state.groups.get(groupId);
  if (mode === "older") {
    return current === undefined ? state : withGroup(state, groupId, withOlder(current, page));
  }
  const first = page.messages[0]?.seq ?? null;
  if (current !== undefined && first === null && current.highSeq > 0) {
    // A page with no messages still carries the group, its members, discussions and open
    // deliveries, such as a question a member just asked. What is loaded stays.
    return withGroup(state, groupId, {
      ...current,
      group: page.group,
      members: byId(page.members),
      discussions: byId(page.discussions),
      deliveries: mergeDeliveries(current.deliveries, page.deliveries),
    });
  }
  if (current === undefined || pageRelation(current, page, mode) === "replaces") {
    const deliveries =
      current === undefined
        ? byId(page.deliveries)
        : mergeDeliveries(current.deliveries, page.deliveries);
    return withGroup(state, groupId, fromPage(page, deliveries));
  }
  const messages = new Map(current.messages);
  for (const m of page.messages) messages.set(m.id, m);
  return withGroup(state, groupId, {
    ...fromPage(page, mergeDeliveries(current.deliveries, page.deliveries)),
    messages,
    lowSeq: current.lowSeq,
    highSeq: Math.max(current.highSeq, page.messages.at(-1)?.seq ?? 0),
    olderBefore: current.olderBefore,
  });
}

const eventGroupId = (event: GroupChatStreamEvent): GroupChatGroupId => {
  switch (event._tag) {
    case "group":
      return event.group.id;
    case "group.deleted":
      return event.groupId;
    case "member":
      return event.member.groupId;
    case "message":
      return event.message.groupId;
    case "delivery":
      return event.delivery.groupId;
    case "discussion":
      return event.discussion.groupId;
  }
};

function pageRelation(
  current: GroupView,
  page: GroupChatGroupPage,
  mode: PageMode,
): "joins" | "replaces" {
  const first = page.messages[0]?.seq;
  if (first === undefined || current.highSeq === 0) return "replaces";
  const fellAPageBehind = mode === "since" && page.olderBefore !== null;
  if (fellAPageBehind) return "replaces";
  return first <= current.highSeq + 1 ? "joins" : "replaces";
}

function applyMessage(state: StoreState, message: GroupChatMessage): StoreState {
  const current = state.groups.get(message.groupId);
  if (current === undefined) return state;
  if (current.messages.has(message.id)) return state;
  if (current.highSeq !== 0 && message.seq !== current.highSeq + 1) return state;
  const messages = new Map(current.messages);
  messages.set(message.id, message);
  return withGroup(state, message.groupId, {
    ...current,
    messages,
    lowSeq: current.highSeq === 0 ? message.seq : current.lowSeq,
    highSeq: message.seq,
  });
}

function setLoadingOlder(
  state: StoreState,
  groupId: GroupChatGroupId,
  loadingOlder: boolean,
): StoreState {
  const current = state.groups.get(groupId);
  return current === undefined ? state : withGroup(state, groupId, { ...current, loadingOlder });
}

/**
 * Where an event falls against the last one applied. The stream's seq begins again when the
 * server restarts; the reconnect that follows clears `lastEventSeq`, so a lower seq here is a
 * replay, not a reset.
 */
function eventRelation(
  lastEventSeq: number | null,
  seq: number,
): "first" | "next" | "stale" | "gap" {
  if (lastEventSeq === null) return "first";
  if (seq <= lastEventSeq) return "stale";
  return seq === lastEventSeq + 1 ? "next" : "gap";
}

export function applyEvent(state: StoreState, event: GroupChatStreamEvent): Applied {
  const relation = eventRelation(state.lastEventSeq, event.seq);
  if (relation === "stale") return { state, owedReads: [], snapshotChanged: false, gap: false };
  const applied = applyOne({ ...state, lastEventSeq: event.seq }, event);
  if (relation !== "gap") return { ...applied, gap: false };
  return { state: applied.state, owedReads: [], snapshotChanged: true, gap: true };
}

function applyOne(state: StoreState, event: GroupChatStreamEvent): Changed {
  const none = { state, owedReads: [], snapshotChanged: false } as const;
  switch (event._tag) {
    case "group": {
      const current = state.groups.get(event.group.id);
      return {
        state:
          current === undefined
            ? state
            : withGroup(state, event.group.id, { ...current, group: event.group }),
        owedReads: [],
        snapshotChanged: true,
      };
    }
    case "group.deleted":
      return { state: withGroup(state, event.groupId, null), owedReads: [], snapshotChanged: true };
    case "member": {
      const current = state.groups.get(event.member.groupId);
      if (current === undefined) return { ...none, snapshotChanged: true };
      const members = new Map(current.members);
      members.set(event.member.id, event.member);
      return {
        state: withGroup(state, event.member.groupId, { ...current, members }),
        owedReads: [],
        snapshotChanged: true,
      };
    }
    case "message": {
      const current = state.groups.get(event.message.groupId);
      if (current === undefined) return none;
      const known = current.messages.get(event.message.id);
      if (known !== undefined) {
        const messages = new Map(current.messages);
        messages.set(event.message.id, { ...known, ...event.message });
        return {
          ...none,
          state: withGroup(state, event.message.groupId, { ...current, messages }),
        };
      }
      if (event.message.seq <= current.highSeq) return none;
      return { ...none, owedReads: [event.message.groupId] };
    }
    case "delivery": {
      const current = state.groups.get(event.delivery.groupId);
      if (current === undefined) return none;
      const existing = current.deliveries.get(event.delivery.id);
      const kept = newerDelivery(existing, fromHead(existing, event.delivery));
      const deliveries = new Map(current.deliveries);
      deliveries.set(event.delivery.id, kept);
      return {
        state: withGroup(state, event.delivery.groupId, { ...current, deliveries }),
        owedReads: questionTextMissing(kept) ? [event.delivery.groupId] : [],
        snapshotChanged: false,
      };
    }
    case "discussion": {
      const current = state.groups.get(event.discussion.groupId);
      if (current === undefined) return none;
      const known = current.discussions.get(event.discussion.id);
      if (known === undefined) return { ...none, owedReads: [event.discussion.groupId] };
      const discussions = new Map(current.discussions);
      discussions.set(event.discussion.id, { ...known, ...event.discussion });
      return {
        ...none,
        state: withGroup(state, event.discussion.groupId, { ...current, discussions }),
      };
    }
  }
}

export type TimelineRow =
  | { readonly kind: "message"; readonly id: string; readonly message: GroupChatMessage }
  | { readonly kind: "pending"; readonly id: string; readonly delivery: GroupChatPageDelivery };

const OPEN_STATES: ReadonlySet<GroupChatPageDelivery["state"]> = new Set([
  "pending",
  "queued",
  "running",
]);

const isOpenDelivery = (d: GroupChatPageDelivery) => OPEN_STATES.has(d.state);

/** A delivery still worth a row: open, or failed where Retry would do something. */
const needsRow = (d: GroupChatPageDelivery) =>
  isOpenDelivery(d) || (d.state === "failed" && d.retryable);

/**
 * Messages by seq, each unfinished delivery after the last message of its turn. A delivery whose
 * turn lies on a page not loaded goes at the end, so its wait and Retry stay reachable.
 */
export function timelineRows(view: GroupView): ReadonlyArray<TimelineRow> {
  const messages = [...view.messages.values()].sort((a, b) => a.seq - b.seq);
  const lastOfTurn = new Map<string, number>();
  messages.forEach((m, i) => lastOfTurn.set(m.turnKey, i));
  const byTurn = new Map<string, GroupChatPageDelivery[]>();
  const unplaced: GroupChatPageDelivery[] = [];
  for (const d of [...view.deliveries.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )) {
    if (!needsRow(d)) continue;
    if (!lastOfTurn.has(d.turnKey)) {
      unplaced.push(d);
      continue;
    }
    const list = byTurn.get(d.turnKey) ?? [];
    list.push(d);
    byTurn.set(d.turnKey, list);
  }
  const rows: TimelineRow[] = [];
  const pending = (delivery: GroupChatPageDelivery): TimelineRow => ({
    kind: "pending",
    id: `pending:${delivery.id}`,
    delivery,
  });
  messages.forEach((message, i) => {
    rows.push({ kind: "message", id: message.id, message });
    if (lastOfTurn.get(message.turnKey) !== i) return;
    for (const delivery of byTurn.get(message.turnKey) ?? []) rows.push(pending(delivery));
  });
  for (const delivery of unplaced) rows.push(pending(delivery));
  return rows;
}

export interface TurnInfo {
  /** A discussion round's name. A chat turn has none, since a loaded page cannot count turns. */
  readonly label: string | null;
  readonly promptId: GroupChatMessageId | null;
}

export function turnsOf(view: GroupView): ReadonlyMap<string, TurnInfo> {
  const out = new Map<string, TurnInfo>();
  for (const m of [...view.messages.values()].sort((a, b) => a.seq - b.seq)) {
    if (out.has(m.turnKey)) continue;
    const discussion = m.discussionId === null ? undefined : view.discussions.get(m.discussionId);
    out.set(m.turnKey, {
      label: discussion !== undefined && m.round !== null ? `Round ${m.round}` : null,
      promptId:
        discussion !== undefined
          ? discussion.promptMessageId
          : m.author._tag === "operator"
            ? m.id
            : m.triggerMessageId,
    });
  }
  return out;
}

export function deliveriesByTrigger(view: GroupView) {
  const map = new Map<GroupChatMessageId, GroupChatPageDelivery[]>();
  for (const d of [...view.deliveries.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )) {
    const list = map.get(d.triggerMessageId) ?? [];
    list.push(d);
    map.set(d.triggerMessageId, list);
  }
  return map;
}

export function openDeliveryByMember(view: GroupView) {
  const map = new Map<GroupChatMemberId, GroupChatPageDelivery>();
  for (const d of view.deliveries.values()) {
    if (!isOpenDelivery(d)) continue;
    const existing = map.get(d.memberId);
    if (existing === undefined || existing.createdAt < d.createdAt) map.set(d.memberId, d);
  }
  return map;
}

const storeAtom = Atom.make<StoreState>(emptyState).pipe(
  Atom.keepAlive,
  Atom.withLabel("group-chat-store"),
);

const groupViewAtom = Atom.family((groupId: GroupChatGroupId) =>
  Atom.make((get) => get(storeAtom).groups.get(groupId) ?? null).pipe(
    Atom.withLabel(`group-chat-view:${groupId}`),
  ),
);

export function useGroupView(groupId: GroupChatGroupId): GroupView | null {
  return useAtomValue(groupViewAtom(groupId));
}

const update = (next: (state: StoreState) => StoreState) =>
  appAtomRegistry.set(storeAtom, next(appAtomRegistry.get(storeAtom)));

/** A read that failed is tried again after this long; a tunnel drops requests now and then. */
const READ_RETRY_DELAY_MS = 2_000;
const READ_RETRY_MAX_DELAY_MS = 30_000;

/** The wait before the next try of a failed page read: doubling from two seconds, capped. */
export function retryDelayMs(failures: number): number {
  return Math.min(READ_RETRY_DELAY_MS * 2 ** Math.max(0, failures - 1), READ_RETRY_MAX_DELAY_MS);
}

type Timer = ReturnType<typeof setTimeout>;
type ReadKind = "latest" | "since";

const retryKey = (kind: ReadKind, groupId: GroupChatGroupId) => `${kind}:${groupId}` as const;
const retryTimers = new Map<ReturnType<typeof retryKey>, Timer>();

/** Groups the page shows. A group whose first page has not landed is known here and nowhere else. */
const shownGroups = new Set<GroupChatGroupId>();

const wanted = (groupId: GroupChatGroupId) =>
  shownGroups.has(groupId) || appAtomRegistry.get(storeAtom).groups.has(groupId);

interface Reader {
  owed: boolean;
  readsOut: number;
}

const readers = new Map<GroupChatGroupId, Reader>();

const readerOf = (groupId: GroupChatGroupId): Reader => {
  const existing = readers.get(groupId);
  if (existing !== undefined) return existing;
  const reader: Reader = { owed: false, readsOut: 0 };
  readers.set(groupId, reader);
  return reader;
};

const dropped = (reader: Reader, groupId: GroupChatGroupId) => readers.get(groupId) !== reader;

const stillWanted = (reader: Reader, groupId: GroupChatGroupId) =>
  !dropped(reader, groupId) && wanted(groupId);

const clearRetry = (key: ReturnType<typeof retryKey>) => {
  const timer = retryTimers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  retryTimers.delete(key);
};

const endReader = (groupId: GroupChatGroupId) => {
  readers.delete(groupId);
  clearRetry(retryKey("latest", groupId));
  clearRetry(retryKey("since", groupId));
};

const endReaders = () => {
  readers.clear();
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
};

const retryLater = (
  reader: Reader,
  kind: ReadKind,
  groupId: GroupChatGroupId,
  delayMs: number,
  run: () => void,
) => {
  if (!stillWanted(reader, groupId)) return;
  const key = retryKey(kind, groupId);
  clearRetry(key);
  retryTimers.set(
    key,
    setTimeout(() => {
      retryTimers.delete(key);
      if (stillWanted(reader, groupId)) run();
    }, delayMs),
  );
};

const ignore = () => undefined;

const isNotFound = (error: unknown) => error instanceof GroupChatRequestError && error.notFound;

function readOwed(groupId: GroupChatGroupId): void {
  const reader = readers.get(groupId);
  if (reader === undefined || !reader.owed || reader.readsOut > 0) return;
  const view = readGroupView(groupId);
  if (view === null) return;
  reader.owed = false;
  reader.readsOut += 1;
  fetchGroupPage(groupId, { after: view.highSeq }).then(
    (page) => {
      if (dropped(reader, groupId)) return;
      reader.readsOut -= 1;
      update((state) => applyPage(state, groupId, page, "since"));
      readOwed(groupId);
    },
    (error: unknown) => {
      if (dropped(reader, groupId)) return;
      reader.readsOut -= 1;
      if (isNotFound(error)) {
        forgetGroup(groupId);
        return;
      }
      reader.owed = true;
      retryLater(reader, "since", groupId, READ_RETRY_DELAY_MS, () => readOwed(groupId));
    },
  );
}

const oweRead = (groupId: GroupChatGroupId) => {
  if (!wanted(groupId)) return;
  readerOf(groupId).owed = true;
  readOwed(groupId);
};

/**
 * Reads a group's latest page. The promise is the first try alone, so a page can show why it
 * failed; every later try is spaced out and silent.
 */
function readLatest(groupId: GroupChatGroupId, failures: number): Promise<void> {
  clearRetry(retryKey("latest", groupId));
  const reader = readerOf(groupId);
  reader.readsOut += 1;
  return fetchGroupPage(groupId, {}).then(
    (page) => {
      if (dropped(reader, groupId)) return;
      reader.readsOut -= 1;
      update((state) => applyPage(state, groupId, page, "latest"));
      readOwed(groupId);
    },
    (error: unknown) => {
      if (!dropped(reader, groupId)) {
        reader.readsOut -= 1;
        if (isNotFound(error)) {
          forgetGroup(groupId);
        } else {
          retryLater(reader, "latest", groupId, retryDelayMs(failures + 1), () => {
            void readLatest(groupId, failures + 1).catch(ignore);
          });
        }
      }
      throw error;
    },
  );
}

/** The page shows this group: its latest page is read now and again on every reopen of the stream. */
export function showGroup(groupId: GroupChatGroupId): Promise<void> {
  shownGroups.add(groupId);
  return readLatest(groupId, 0);
}

/** The page left this group. A retry for it runs only while the store still holds it. */
export function leaveGroup(groupId: GroupChatGroupId): void {
  shownGroups.delete(groupId);
}

export function applyStreamEvent(event: GroupChatStreamEvent): void {
  const groupId = eventGroupId(event);
  const applied = applyEvent(appAtomRegistry.get(storeAtom), event);
  appAtomRegistry.set(storeAtom, applied.state);
  if (applied.snapshotChanged) refreshGroupChatSnapshot();
  const pageMayPredateEvent =
    (readers.get(groupId)?.readsOut ?? 0) > 0 ||
    (shownGroups.has(groupId) && !applied.state.groups.has(groupId));
  const owed = new Set(applied.owedReads);
  if (event._tag === "group.deleted") endReader(groupId);
  else if (pageMayPredateEvent) owed.add(groupId);
  if (applied.gap) readWantedLatest();
  for (const id of owed) oweRead(id);
}

export function noteMessage(message: GroupChatMessage): void {
  update((state) => applyMessage(state, message));
}

export function readGroupView(groupId: GroupChatGroupId): GroupView | null {
  return appAtomRegistry.get(storeAtom).groups.get(groupId) ?? null;
}

export async function loadOlder(groupId: GroupChatGroupId): Promise<boolean> {
  const current = readGroupView(groupId);
  if (current === null || current.olderBefore === null || current.loadingOlder) return false;
  const reader = readerOf(groupId);
  update((state) => setLoadingOlder(state, groupId, true));
  try {
    const page = await fetchGroupPage(groupId, { before: current.olderBefore });
    if (dropped(reader, groupId)) return false;
    update((state) => applyPage(state, groupId, page, "older"));
    return true;
  } finally {
    update((state) => setLoadingOlder(state, groupId, false));
  }
}

const readWantedLatest = () => {
  const held = appAtomRegistry.get(storeAtom).groups.keys();
  for (const groupId of new Set([...shownGroups, ...held])) {
    void readLatest(groupId, 0).catch(ignore);
  }
};

export function streamOpened(): void {
  endReaders();
  update((state) => ({ ...state, lastEventSeq: null }));
  refreshGroupChatSnapshot();
  readWantedLatest();
}

/** The stream closed. Reads under it take no next step, and its reopen starts the ones needed. */
export function streamClosed(): void {
  endReaders();
}

export function forgetGroup(groupId: GroupChatGroupId): void {
  update((state) => withGroup(state, groupId, null));
  endReader(groupId);
}

export type { GroupChatDelivery };
