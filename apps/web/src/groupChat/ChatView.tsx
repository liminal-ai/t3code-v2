import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type {
  GroupChatDeliveryHead,
  GroupChatGroupId,
  GroupChatMember,
  GroupChatMessage,
  GroupChatMessageId,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { cn } from "../lib/utils";
import { Composer } from "./Composer";
import { PendingReply } from "./DeliveryStatus";
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

interface RowContext {
  readonly members: ReadonlyMap<string, GroupChatMember>;
  readonly messages: ReadonlyMap<GroupChatMessageId, GroupChatMessage>;
  readonly turns: ReadonlyMap<string, TurnInfo>;
  readonly byTrigger: ReadonlyMap<GroupChatMessageId, ReadonlyArray<GroupChatDeliveryHead>>;
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
    const body =
      message.author._tag === "operator" ? (
        <OperatorMessage
          message={message}
          members={ctx.members}
          deliveries={ctx.byTrigger.get(message.id) ?? []}
        />
      ) : message.author._tag === "member" ? (
        <MemberMessage
          message={message}
          member={ctx.members.get(message.author.memberId)}
          turn={turn}
          prompt={promptId === null ? undefined : ctx.messages.get(promptId)}
          onJump={ctx.jumpTo}
        />
      ) : (
        <SystemDivider
          message={message}
          members={ctx.members}
          deliveries={ctx.byTrigger.get(message.id) ?? []}
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
  const [flashId, setFlashId] = useState<GroupChatMessageId | null>(null);
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

  const renderItem = useMemo(
    () =>
      makeRenderItem({
        members: view.members,
        messages: view.messages,
        turns,
        byTrigger,
        flashId,
        jumpTo,
      }),
    [view.members, view.messages, turns, byTrigger, flashId, jumpTo],
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
        maintainScrollAtEnd
        maintainScrollAtEndThreshold={0.15}
        maintainVisibleContentPosition
        onStartReached={loadOlderPage}
        onStartReachedThreshold={0.5}
        ListHeaderComponent={<ListHeader view={view} />}
        className="h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]"
        data-testid="group-chat-timeline"
      />
      <div className="shrink-0 px-5 pt-1 pb-4">
        <Composer groupId={groupId} members={activeMembers} view={view} />
      </div>
    </div>
  );
}

const rowKey = (row: TimelineRow) => row.id;
const rowType = (row: TimelineRow) =>
  row.kind === "pending" ? "pending" : row.message.author._tag;
