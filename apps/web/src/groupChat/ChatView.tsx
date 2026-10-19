import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { GroupChatGroupId, GroupChatMessageId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { Spinner } from "../components/ui/spinner";
import { useStableCallback } from "../hooks/useStableCallback";
import { cn } from "../lib/utils";
import { Composer } from "./Composer";
import { PendingReply } from "./DeliveryStatus";
import { MemberMessage, OperatorMessage, SystemDivider } from "./MessageRow";
import {
  deliveriesByTrigger,
  type GroupView,
  loadOlder,
  type TimelineRow,
  timelineRows,
  turnsOf,
} from "./store";

const ESTIMATED_ROW_HEIGHT = 88;
const FLASH_MS = 1_600;

function ListHeader({ view }: { view: GroupView }) {
  if (view.loadingOlder) {
    return (
      <div className="flex justify-center py-3">
        <Spinner size="sm" />
      </div>
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

  const jumpTo = useStableCallback((messageId: GroupChatMessageId) => {
    const index = rows.findIndex((row) => row.kind === "message" && row.message.id === messageId);
    if (index === -1) {
      // The prompt sits on a page not loaded yet; load one and let the next click find it.
      void loadOlder(groupId);
      return;
    }
    void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
    setFlashId(messageId);
  });

  const loadOlderPage = useStableCallback(() => {
    if (view.olderBefore !== null && !view.loadingOlder) void loadOlder(groupId);
  });

  const renderItem = useStableCallback(({ item }: { item: TimelineRow }) => {
    if (item.kind === "pending") {
      return (
        <div className="mx-auto w-full max-w-(--chat-content-max-width) px-5 py-2">
          <PendingReply
            delivery={item.delivery}
            member={view.members.get(item.delivery.memberId)}
          />
        </div>
      );
    }
    const message = item.message;
    const flash = flashId === message.id;
    const body =
      message.author._tag === "operator" ? (
        <OperatorMessage
          message={message}
          members={view.members}
          deliveries={byTrigger.get(message.id) ?? []}
        />
      ) : message.author._tag === "member" ? (
        <MemberMessage
          message={message}
          member={view.members.get(message.author.memberId)}
          turn={turns.get(message.turnKey)}
          prompt={
            turns.get(message.turnKey)?.promptId === null
              ? undefined
              : view.messages.get(turns.get(message.turnKey)!.promptId!)
          }
          onJump={jumpTo}
        />
      ) : (
        <SystemDivider
          message={message}
          members={view.members}
          deliveries={byTrigger.get(message.id) ?? []}
        />
      );
    return (
      <div className="mx-auto w-full max-w-(--chat-content-max-width) px-5 py-1">
        <div className={cn("rounded-xl p-1 transition-colors duration-500", flash && "bg-accent")}>
          {body}
        </div>
      </div>
    );
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <LegendList<TimelineRow>
        ref={listRef}
        data={rows}
        extraData={`${flashId ?? ""}:${view.members.size}:${view.deliveries.size}`}
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
