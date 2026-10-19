import { useLocation, useNavigate } from "@tanstack/react-router";
import type { GroupChatGroup } from "@t3tools/contracts";
import { useCallback } from "react";

import { SidebarUtilityMenu } from "../components/sidebar/SidebarChrome";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { useGroupChatSnapshot } from "./api";

function GroupChatList({ groups }: { groups: ReadonlyArray<GroupChatGroup> }) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const openGroup = useCallback(
    (groupId: GroupChatGroup["id"]) => {
      if (isMobile) setOpenMobile(false);
      void navigate({ to: "/group-chat/$groupId", params: { groupId } });
    },
    [isMobile, navigate, setOpenMobile],
  );
  return (
    <SidebarMenu>
      {groups.map((group) => (
        <SidebarMenuItem key={group.id}>
          <SidebarMenuButton
            isActive={pathname === `/group-chat/${group.id}`}
            onClick={() => openGroup(group.id)}
          >
            <span className="truncate">{group.title}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

export function GroupChatSidebar() {
  const snapshot = useGroupChatSnapshot();
  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          {snapshot.status !== "ready" ? null : snapshot.groups.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-sidebar-muted-foreground">No group chats yet</p>
          ) : (
            <GroupChatList groups={snapshot.groups} />
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarUtilityMenu />
      </SidebarFooter>
    </>
  );
}
