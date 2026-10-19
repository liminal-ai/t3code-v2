import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type {
  GroupChatDiscussion,
  GroupChatDiscussionId,
  GroupChatPageDelivery,
  GroupChatGroupId,
  GroupChatMember,
  GroupChatMessage,
  GroupChatMessageId,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  TYPE_TO_FOCUS_EDITABLE_SELECTOR,
  TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR,
} from "../components/chat/composerFocusRedirect";
import { isTimelineScrollTarget } from "../components/chat/timelineScrollTarget";
import { useStableCallback } from "../hooks/useStableCallback";
import { cn } from "../lib/utils";
import { Composer } from "./Composer";
import { PendingReply } from "./DeliveryStatus";
import { DiscussionPanel } from "./discussion/DiscussionPanel";
import { panelDiscussion, roundDivider } from "./discussion/discussionView";
import {
  followAfterScroll,
  geometryOf,
  gestureLeavesEnd,
  keyTowardStart,
  type ReaderGesture,
} from "./followEnd";
import { MemberMessage, OperatorMessage, SystemDivider } from "./MessageRow";
import {
  deliveriesByTrigger,
  type GroupView,
  loadOlder,
  readGroupView,
  type TimelineRow,
  timelineRows,
  type TurnInfo,
  turnsOf,
} from "./store";

const ESTIMATED_ROW_HEIGHT = 88;
const FLASH_MS = 1_600;
/** How far back a jump to a prompt pages before it gives up. */
const MAX_PAGES_PER_JUMP = 10;

function ListHeader({ view }: { view: GroupView }) {
  if (view.loadingOlder) {
    return (
      <p className="py-3 text-center text-2xs text-muted-foreground/70">Reading older messages…</p>
    );
  }
  if (view.olderBefore !== null) return <div className="h-3" />;
  return (
    <p className="py-3 text-center text-2xs text-muted-foreground/70">
      {view.messages.size === 0
        ? "No messages yet. Tick members below, or type @, and say hello."
        : "The start of this group chat"}
    </p>
  );
}

/**
 * Keeps the list pinned to its end while the reader stays there, the way the thread timeline
 * does. LegendList's own threshold band is too narrow: a reply measured taller than its pending
 * row drifted the viewport past it in one step and nothing re-pinned. So the band is the whole
 * viewport, and only a reader's gesture turns following off.
 */
function useFollowEnd(listRef: React.RefObject<LegendListRef | null>) {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const update = useStableCallback((next: boolean) => {
    if (followingRef.current === next) return;
    followingRef.current = next;
    setFollowing(next);
  });
  const onScroll = useStableCallback(() => {
    const node = listRef.current?.getScrollableNode();
    if (node) update(followAfterScroll(followingRef.current, geometryOf(node)));
  });
  const leave = useStableCallback(() => update(false));

  useEffect(() => {
    const node = listRef.current?.getScrollableNode();
    if (!node) return;
    const onGesture = (gesture: ReaderGesture) => {
      if (gestureLeavesEnd(gesture, geometryOf(node))) update(false);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || !isTimelineScrollTarget(event.target, node, event.deltaY)) return;
      onGesture({ kind: "wheel", deltaY: event.deltaY });
    };
    const onTouchMove = () => onGesture({ kind: "touch" });
    // A scrollbar drag is the one pointerdown whose target is the scroll node itself.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === node) onGesture({ kind: "scrollbar" });
    };
    // A click on message text can leave focus on the body, so scroll keys are heard there too.
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !keyTowardStart(event.key) ||
        !(event.target instanceof Node) ||
        (!node.contains(event.target) &&
          event.target !== document.body &&
          event.target !== document.documentElement) ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.target instanceof Element &&
          event.target.closest(TYPE_TO_FOCUS_EDITABLE_SELECTOR)) ||
        document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)
      ) {
        return;
      }
      onGesture({ kind: "key", key: event.key });
    };
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [listRef, update]);

  return { following, onScroll, leave };
}

const dismissedKey = (groupId: GroupChatGroupId) => `t3.groupChat.dismissedDiscussion.${groupId}`;

const readDismissed = (groupId: GroupChatGroupId) => ({
  groupId,
  id: sessionStorage.getItem(dismissedKey(groupId)),
});

interface RowContext {
  readonly members: ReadonlyMap<string, GroupChatMember>;
  readonly messages: ReadonlyMap<GroupChatMessageId, GroupChatMessage>;
  readonly discussions: ReadonlyMap<GroupChatDiscussionId, GroupChatDiscussion>;
  readonly turns: ReadonlyMap<string, TurnInfo>;
  readonly byTrigger: ReadonlyMap<GroupChatMessageId, ReadonlyArray<GroupChatPageDelivery>>;
  readonly flashId: GroupChatMessageId | null;
  readonly jumpTo: (messageId: GroupChatMessageId) => Promise<void>;
}

// LegendList calls this while rendering its rows, so it closes over the context alone and not
// over the render that made it, per docs/internals/web-ui.md.
const makeRenderItem =
  (ctx: RowContext) =>
  ({ item }: { item: TimelineRow }) => {
    if (item.kind === "pending") {
      return (
        <div className="mx-auto w-full max-w-(--chat-content-max-width) px-5 py-2">
          <PendingReply delivery={item.delivery} member={ctx.members.get(item.delivery.memberId)} />
        </div>
      );
    }
    const message = item.message;
    const turn = ctx.turns.get(message.turnKey);
    const promptId = turn?.promptId ?? null;
    const discussion =
      message.discussionId === null ? undefined : ctx.discussions.get(message.discussionId);
    const body =
      message.author._tag === "operator" ? (
        <OperatorMessage
          message={message}
          members={ctx.members}
          deliveries={ctx.byTrigger.get(message.id) ?? []}
          discussion={discussion}
        />
      ) : message.author._tag === "member" ? (
        <MemberMessage
          message={message}
          member={ctx.members.get(message.author.memberId)}
          turn={turn}
          prompt={promptId === null ? undefined : ctx.messages.get(promptId)}
          discussion={discussion}
          onJump={ctx.jumpTo}
        />
      ) : (
        <SystemDivider
          message={message}
          members={ctx.members}
          deliveries={ctx.byTrigger.get(message.id) ?? []}
          divider={roundDivider(message, discussion)}
        />
      );
    return (
      <div className="mx-auto w-full max-w-(--chat-content-max-width) px-5 py-1">
        <div
          className={cn(
            "rounded-xl p-1 transition-colors duration-500",
            ctx.flashId === message.id && "bg-accent",
          )}
        >
          {body}
        </div>
      </div>
    );
  };

export function ChatView({ groupId, view }: { groupId: GroupChatGroupId; view: GroupView }) {
  const listRef = useRef<LegendListRef>(null);
  const follow = useFollowEnd(listRef);
  const [flashId, setFlashId] = useState<GroupChatMessageId | null>(null);
  const [dismissed, setDismissed] = useState(() => readDismissed(groupId));
  if (dismissed.groupId !== groupId) setDismissed(readDismissed(groupId));
  const panel = panelDiscussion(view, dismissed.id);
  const rows = useMemo(() => timelineRows(view), [view]);
  const turns = useMemo(() => turnsOf(view), [view]);
  const byTrigger = useMemo(() => deliveriesByTrigger(view), [view]);
  const activeMembers = useMemo(
    () =>
      [...view.members.values()]
        .filter((m) => m.removedAt === null)
        .sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
    [view.members],
  );

  useEffect(() => {
    if (flashId === null) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);

  const jumpTo = useStableCallback(async (messageId: GroupChatMessageId) => {
    for (let pages = 0; pages < MAX_PAGES_PER_JUMP; pages++) {
      const current = readGroupView(groupId);
      if (current === null) return;
      const index = timelineRows(current).findIndex(
        (row) => row.kind === "message" && row.message.id === messageId,
      );
      if (index !== -1) {
        follow.leave();
        await listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
        setFlashId(messageId);
        return;
      }
      if (!(await loadOlder(groupId))) return;
    }
  });

  const loadOlderPage = useStableCallback(() => {
    if (view.olderBefore !== null && !view.loadingOlder) void loadOlder(groupId);
  });

  const dismissPanel = () => {
    if (panel === null) return;
    sessionStorage.setItem(dismissedKey(groupId), panel.id);
    setDismissed({ groupId, id: panel.id });
  };

  const renderItem = useMemo(
    () =>
      makeRenderItem({
        members: view.members,
        messages: view.messages,
        discussions: view.discussions,
        turns,
        byTrigger,
        flashId,
        jumpTo,
      }),
    [view.members, view.messages, view.discussions, turns, byTrigger, flashId, jumpTo],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <LegendList<TimelineRow>
        ref={listRef}
        data={rows}
        extraData={renderItem}
        keyExtractor={rowKey}
        getItemType={rowType}
        renderItem={renderItem}
        estimatedItemSize={ESTIMATED_ROW_HEIGHT}
        initialScrollAtEnd
        maintainScrollAtEnd={follow.following}
        maintainScrollAtEndThreshold={1}
        maintainVisibleContentPosition
        onScroll={follow.onScroll}
        onStartReached={loadOlderPage}
        onStartReachedThreshold={0.5}
        ListHeaderComponent={<ListHeader view={view} />}
        className="h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]"
        data-testid="group-chat-timeline"
      />
      <div className="shrink-0 px-5 pt-1 pb-4">
        {panel === null ? null : (
          <DiscussionPanel view={view} discussion={panel} onDismiss={dismissPanel} />
        )}
        <Composer groupId={groupId} members={activeMembers} view={view} />
      </div>
    </div>
  );
}

const rowKey = (row: TimelineRow) => row.id;
const rowType = (row: TimelineRow) =>
  row.kind === "pending" ? "pending" : row.message.author._tag;
