import { Empty, EmptyHeader, EmptyTitle } from "../components/ui/empty";
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
import { type GroupChatSnapshotState, useGroupChatSnapshot } from "./api";
import { useGroupChatEvents } from "./events";

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

export function GroupChatPage({ groupId }: { readonly groupId?: string }) {
  useEscapeToGoBack();
  const snapshot = useGroupChatSnapshot();
  useGroupChatEvents(snapshot.status === "ready");
  const group =
    snapshot.status === "ready" ? snapshot.groups.find((entry) => entry.id === groupId) : undefined;
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
                  <WorkspaceBreadcrumbText>{group.title}</WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbItem>
              </>
            )}
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {shown === null ? null : (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>{shown}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </SidebarInset>
  );
}
