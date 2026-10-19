import { useAtomValue } from "@effect/atom-react";
import type {
  GroupChatDelivery,
  GroupChatDeliveryHead,
  GroupChatDeliveryId,
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
import { fetchGroupPage, refreshGroupChatSnapshot } from "./api";

export interface GroupView {
  readonly group: GroupChatGroup;
  readonly members: ReadonlyMap<GroupChatMemberId, GroupChatMember>;
  readonly discussions: ReadonlyMap<GroupChatDiscussionId, GroupChatDiscussion>;
  readonly messages: ReadonlyMap<GroupChatMessageId, GroupChatMessage>;
  readonly deliveries: ReadonlyMap<GroupChatDeliveryId, GroupChatDeliveryHead>;
  readonly lowSeq: number;
  readonly highSeq: number;
  readonly olderBefore: number | null;
  readonly loadingOlder: boolean;
  readonly fetchingAfter: number | null;
}

export interface StoreState {
  readonly lastEventSeq: number | null;
  readonly groups: ReadonlyMap<GroupChatGroupId, GroupView>;
}

export type PageMode = "latest" | "older" | "since";

/** `since` reads what arrived past a seq: message bodies and new discussions alike. */
export type FetchRequest =
  | { readonly _tag: "latest"; readonly groupId: GroupChatGroupId }
  | { readonly _tag: "since"; readonly groupId: GroupChatGroupId; readonly seq: number };

export interface Applied {
  readonly state: StoreState;
  readonly fetches: ReadonlyArray<FetchRequest>;
  readonly snapshotChanged: boolean;
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
  existing: GroupChatDeliveryHead | undefined,
  incoming: GroupChatDeliveryHead,
): GroupChatDeliveryHead =>
  existing !== undefined && existing.updatedAt > incoming.updatedAt ? existing : incoming;

const mergeDeliveries = (
  existing: ReadonlyMap<GroupChatDeliveryId, GroupChatDeliveryHead>,
  incoming: ReadonlyArray<GroupChatDeliveryHead>,
) => {
  const merged = new Map(existing);
  for (const d of incoming) merged.set(d.id, newerDelivery(existing.get(d.id), d));
  return merged;
};

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
  fetchingAfter: null,
});

export function applyPage(
  state: StoreState,
  groupId: GroupChatGroupId,
  page: GroupChatGroupPage,
  mode: PageMode,
): StoreState {
  const current = state.groups.get(groupId);
  const first = page.messages[0]?.seq ?? null;
  if (current === undefined || pageRelation(current, page, mode) === "replaces") {
    const deliveries =
      current === undefined || mode === "older"
        ? byId(page.deliveries)
        : mergeDeliveries(current.deliveries, page.deliveries);
    return withGroup(state, groupId, fromPage(page, deliveries));
  }
  const messages = new Map(current.messages);
  for (const m of page.messages) messages.set(m.id, m);
  const view: GroupView = {
    ...fromPage(page, mergeDeliveries(current.deliveries, page.deliveries)),
    messages,
    lowSeq: mode === "older" ? (first ?? current.lowSeq) : current.lowSeq,
    highSeq:
      mode === "older"
        ? current.highSeq
        : Math.max(current.highSeq, page.messages.at(-1)?.seq ?? 0),
    olderBefore: mode === "older" ? page.olderBefore : current.olderBefore,
  };
  return withGroup(state, groupId, view);
}

/**
 * A page joins what is loaded only when no unknown messages lie between them. An older page
 * joins below `lowSeq`; a latest or since page joins at or before `highSeq + 1`, unless the server
 * says more lie below it, which means the client fell more than a page behind.
 */
function pageRelation(
  current: GroupView,
  page: GroupChatGroupPage,
  mode: PageMode,
): "joins" | "replaces" {
  const first = page.messages[0]?.seq;
  if (first === undefined || current.highSeq === 0) return "replaces";
  if (mode === "older") return first < current.lowSeq ? "joins" : "replaces";
  if (page.olderBefore !== null && mode === "since") return "replaces";
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
  if (relation === "stale") return { state, fetches: [], snapshotChanged: false };
  const applied = applyOne({ ...state, lastEventSeq: event.seq }, event);
  if (relation !== "gap") return applied;
  const fetches: FetchRequest[] = [...applied.state.groups.keys()].map((groupId) => ({
    _tag: "latest",
    groupId,
  }));
  return { state: applied.state, fetches, snapshotChanged: true };
}

const readSince = (state: StoreState, current: GroupView, none: Applied): Applied =>
  current.fetchingAfter !== null && current.fetchingAfter >= current.highSeq
    ? none
    : {
        state: withGroup(state, current.group.id, { ...current, fetchingAfter: current.highSeq }),
        fetches: [{ _tag: "since", groupId: current.group.id, seq: current.highSeq }],
        snapshotChanged: false,
      };

function applyOne(state: StoreState, event: GroupChatStreamEvent): Applied {
  const none = { state, fetches: [], snapshotChanged: false } as const;
  switch (event._tag) {
    case "group": {
      const current = state.groups.get(event.group.id);
      return {
        state:
          current === undefined
            ? state
            : withGroup(state, event.group.id, { ...current, group: event.group }),
        fetches: [],
        snapshotChanged: true,
      };
    }
    case "group.deleted":
      return { state: withGroup(state, event.groupId, null), fetches: [], snapshotChanged: true };
    case "member": {
      const current = state.groups.get(event.member.groupId);
      if (current === undefined) return { ...none, snapshotChanged: true };
      const members = new Map(current.members);
      members.set(event.member.id, event.member);
      return {
        state: withGroup(state, event.member.groupId, { ...current, members }),
        fetches: [],
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
      return readSince(state, current, none);
    }
    case "delivery": {
      const current = state.groups.get(event.delivery.groupId);
      if (current === undefined) return none;
      return {
        ...none,
        state: withGroup(state, event.delivery.groupId, {
          ...current,
          deliveries: mergeDeliveries(current.deliveries, [event.delivery]),
        }),
      };
    }
    case "discussion": {
      const current = state.groups.get(event.discussion.groupId);
      if (current === undefined) return none;
      const known = current.discussions.get(event.discussion.id);
      if (known === undefined) return readSince(state, current, none);
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
  | { readonly kind: "pending"; readonly id: string; readonly delivery: GroupChatDeliveryHead };

const OPEN_STATES: ReadonlySet<GroupChatDeliveryHead["state"]> = new Set([
  "pending",
  "queued",
  "running",
]);

const isOpenDelivery = (d: GroupChatDeliveryHead) => OPEN_STATES.has(d.state);

export function timelineRows(view: GroupView): ReadonlyArray<TimelineRow> {
  const messages = [...view.messages.values()].sort((a, b) => a.seq - b.seq);
  const lastOfTurn = new Map<string, number>();
  messages.forEach((m, i) => lastOfTurn.set(m.turnKey, i));
  const openByTurn = new Map<string, GroupChatDeliveryHead[]>();
  for (const d of view.deliveries.values()) {
    if (!isOpenDelivery(d)) continue;
    const list = openByTurn.get(d.turnKey) ?? [];
    list.push(d);
    openByTurn.set(d.turnKey, list);
  }
  const rows: TimelineRow[] = [];
  messages.forEach((message, i) => {
    rows.push({ kind: "message", id: message.id, message });
    if (lastOfTurn.get(message.turnKey) !== i) return;
    for (const delivery of openByTurn.get(message.turnKey) ?? []) {
      rows.push({ kind: "pending", id: `pending:${delivery.id}`, delivery });
    }
  });
  return rows;
}

export interface TurnInfo {
  readonly index: number;
  readonly label: string;
  readonly promptId: GroupChatMessageId | null;
}

export function turnsOf(view: GroupView): ReadonlyMap<string, TurnInfo> {
  const out = new Map<string, TurnInfo>();
  for (const m of [...view.messages.values()].sort((a, b) => a.seq - b.seq)) {
    if (out.has(m.turnKey)) continue;
    const discussion = m.discussionId === null ? undefined : view.discussions.get(m.discussionId);
    const index = out.size;
    out.set(m.turnKey, {
      index,
      label:
        discussion !== undefined && m.round !== null ? `Round ${m.round}` : `Turn ${index + 1}`,
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
  const map = new Map<GroupChatMessageId, GroupChatDeliveryHead[]>();
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
  const map = new Map<GroupChatMemberId, GroupChatDeliveryHead>();
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

const runFetches = (fetches: ReadonlyArray<FetchRequest>) => {
  for (const fetch of fetches) {
    if (fetch._tag === "latest") void loadGroup(fetch.groupId);
    else {
      void fetchGroupPage(fetch.groupId, { after: fetch.seq })
        .then((page) => update((state) => applyPage(state, fetch.groupId, page, "since")))
        .catch(() =>
          update((state) => {
            const current = state.groups.get(fetch.groupId);
            return current === undefined
              ? state
              : {
                  ...state,
                  groups: new Map(state.groups).set(fetch.groupId, {
                    ...current,
                    fetchingAfter: null,
                  }),
                };
          }),
        );
    }
  }
};

export function applyStreamEvent(event: GroupChatStreamEvent): void {
  const applied = applyEvent(appAtomRegistry.get(storeAtom), event);
  appAtomRegistry.set(storeAtom, applied.state);
  if (applied.snapshotChanged) refreshGroupChatSnapshot();
  runFetches(applied.fetches);
}

export function noteMessage(message: GroupChatMessage): void {
  update((state) => applyMessage(state, message));
}

export async function loadGroup(groupId: GroupChatGroupId): Promise<void> {
  const page = await fetchGroupPage(groupId, {});
  update((state) => applyPage(state, groupId, page, "latest"));
}

export function readGroupView(groupId: GroupChatGroupId): GroupView | null {
  return appAtomRegistry.get(storeAtom).groups.get(groupId) ?? null;
}

/** Resolves true when an older page was loaded, false when the group has no more. */
export async function loadOlder(groupId: GroupChatGroupId): Promise<boolean> {
  const current = readGroupView(groupId);
  if (current === null || current.olderBefore === null || current.loadingOlder) return false;
  update((state) => setLoadingOlder(state, groupId, true));
  try {
    const page = await fetchGroupPage(groupId, { before: current.olderBefore });
    update((state) => applyPage(state, groupId, page, "older"));
    return true;
  } finally {
    update((state) => setLoadingOlder(state, groupId, false));
  }
}

export function resyncAll(): void {
  const state = appAtomRegistry.get(storeAtom);
  appAtomRegistry.set(storeAtom, { ...state, lastEventSeq: null });
  refreshGroupChatSnapshot();
  for (const groupId of state.groups.keys()) void loadGroup(groupId);
}

export function forgetGroup(groupId: GroupChatGroupId): void {
  update((state) => withGroup(state, groupId, null));
}

export type { GroupChatDelivery };
