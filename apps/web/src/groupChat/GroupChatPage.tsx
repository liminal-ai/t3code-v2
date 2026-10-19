import type { GroupChatGroupId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useEscapeToGoBack } from "../hooks/useNavigateBack";
import {
  attempt,
  dispatchGroupChat,
  type GroupChatSnapshotState,
  useGroupChatSnapshot,
} from "./api";
import { ChatView } from "./ChatView";
import { runningDiscussion } from "./discussion/discussionView";
import { StartDiscussionDialog } from "./discussion/StartDiscussionDialog";
import { useGroupChatEvents } from "./events";
import { ManageGroupDialog } from "./ManageGroupDialog";
import { MemberChip } from "./MemberChip";
import { type GroupView, leaveGroup, openDeliveryByMember, showGroup, useGroupView } from "./store";

function notice(snapshot: GroupChatSnapshotState, groupId: string | undefined): string | null {
  switch (snapshot.status) {
    case "loading":
      return null;
    case "failed":
      return snapshot.message;
    case "unavailable":
      switch (snapshot.reason) {
        case "disabled":
          return "Group chat is turned off on this server.";
        case "store_unavailable":
          return "Group chat could not open its data. The server log says why.";
        case "not_ready":
          return "This server does not support group chat yet.";
      }
      break;
    case "ready":
      if (groupId !== undefined) {
        return snapshot.groups.some((group) => group.id === groupId)
          ? null
          : "This group chat does not exist.";
      }
      return snapshot.groups.length === 0 ? "No group chats yet" : "Pick a group chat";
  }
}

function GroupHeaderActions({ view }: { view: GroupView }) {
  const [manageOpen, setManageOpen] = useState(false);
  const [discussOpen, setDiscussOpen] = useState(false);
  const members = [...view.members.values()]
    .filter((m) => m.removedAt === null)
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  const open = openDeliveryByMember(view);
  const settled = view.group.settledAt !== null;
  const canDiscuss = members.length >= 2 && runningDiscussion(view) === null;
  return (
    <div className="flex flex-1 items-center justify-end gap-2">
      <div className="hidden min-w-0 flex-wrap items-center gap-1 sm:flex">
        {members.map((member) => (
          <MemberChip key={member.id} member={member} wait={open.get(member.id)?.wait ?? null} />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() =>
            void attempt(() =>
              dispatchGroupChat({
                _tag: settled ? "group.unsettle" : "group.settle",
                groupId: view.group.id,
              }),
            )
          }
        >
          {settled ? "Unsettle" : "Settle"}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!canDiscuss}
          onClick={() => setDiscussOpen(true)}
          data-testid="discuss"
        >
          Discuss
        </Button>
        <Button size="xs" variant="outline" onClick={() => setManageOpen(true)}>
          Manage
        </Button>
      </div>
      {discussOpen ? (
        <StartDiscussionDialog view={view} onClose={() => setDiscussOpen(false)} />
      ) : null}
      {manageOpen ? <ManageGroupDialog view={view} onClose={() => setManageOpen(false)} /> : null}
    </div>
  );
}

function GroupBody({ groupId }: { groupId: GroupChatGroupId }) {
  const view = useGroupView(groupId);
  const [failed, setFailed] = useState<{
    readonly groupId: GroupChatGroupId;
    readonly message: string;
  } | null>(null);
  const failure = failed?.groupId === groupId ? failed.message : null;
  useEffect(() => {
    let alive = true;
    showGroup(groupId).catch((error: unknown) => {
      if (alive) {
        setFailed({ groupId, message: error instanceof Error ? error.message : String(error) });
      }
    });
    return () => {
      alive = false;
      leaveGroup(groupId);
    };
  }, [groupId]);
  if (view === null) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          {failure === null ? (
            <EmptyTitle>Reading this group chat…</EmptyTitle>
          ) : (
            <>
              <EmptyTitle>Could not load this group chat</EmptyTitle>
              <EmptyDescription>{failure}</EmptyDescription>
              <EmptyDescription>Trying again…</EmptyDescription>
            </>
          )}
        </EmptyHeader>
      </Empty>
    );
  }
  return <ChatView key={groupId} groupId={groupId} view={view} />;
}

export function GroupChatPage({ groupId }: { readonly groupId?: string }) {
  useEscapeToGoBack();
  const snapshot = useGroupChatSnapshot();
  useGroupChatEvents(snapshot.status === "ready");
  const group =
    snapshot.status === "ready" ? snapshot.groups.find((entry) => entry.id === groupId) : undefined;
  const view = useGroupView((groupId ?? "") as GroupChatGroupId);
  const shown = notice(snapshot, groupId);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Group chat breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current={group === undefined}>
              <h1>Group chat</h1>
            </WorkspaceBreadcrumbItem>
            {group === undefined ? null : (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current className="min-w-10">
                  <WorkspaceBreadcrumbText data-testid="group-title">
                    {group.title}
                  </WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbItem>
              </>
            )}
          </WorkspaceBreadcrumb>
          {group !== undefined && view !== null ? <GroupHeaderActions view={view} /> : null}
        </WorkspacePageHeader>
        {shown !== null ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>{shown}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : group === undefined ? null : (
          <GroupBody groupId={group.id} />
        )}
      </div>
    </SidebarInset>
  );
}
