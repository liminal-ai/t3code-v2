import { useLocation, useNavigate } from "@tanstack/react-router";
import type { GroupChatGroup, GroupChatMember } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { SidebarUtilityMenu } from "../components/sidebar/SidebarChrome";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../components/ThreadHoverCard";
import { Badge } from "../components/ui/badge";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { Tooltip, TooltipTrigger } from "../components/ui/tooltip";
import { useThreadShell } from "../state/entities";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { useGroupChatSnapshot } from "./api";
import { CreateGroupDialog } from "./CreateGroupDialog";
import {
  isExternalMember,
  MemberDot,
  memberColor,
  memberSubtitle,
  memberThreadRef,
  runtimeLabel,
} from "./MemberChip";

function MemberStatusRow({ member }: { member: GroupChatMember }) {
  const shell = useThreadShell(memberThreadRef(member));
  return (
    <div className="flex items-center gap-2" data-testid="hover-member" data-handle={member.handle}>
      <MemberDot member={member} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium" style={{ color: memberColor(member.color) }}>
          @{member.handle}
        </span>
        <span className="text-muted-foreground"> · {memberSubtitle(member, shell?.title)}</span>
      </span>
      <Badge variant="outline" size="sm">
        {isExternalMember(member) ? "external" : runtimeLabel(shell?.runtime?.status)}
      </Badge>
      {shell?.settledAt ? (
        <Badge variant="outline" size="sm">
          settled
        </Badge>
      ) : null}
    </div>
  );
}

function GroupRow({
  group,
  members,
  active,
  onSelect,
}: {
  group: GroupChatGroup;
  members: ReadonlyArray<GroupChatMember>;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              isActive={active}
              onClick={onSelect}
              size="lg"
              data-testid="group-row"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1 text-2xs text-sidebar-muted-foreground">
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
                    {members.slice(0, 5).map((member) => (
                      <span key={member.id} className="flex shrink-0 items-center gap-0.5">
                        <MemberDot member={member} className="size-1.5" />@{member.handle}
                      </span>
                    ))}
                    {members.length > 5 ? <span>+{members.length - 5}</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatRelativeTimeLabel(group.lastActivityAt).replace(" ago", "")}
                  </span>
                </span>
                <span className="truncate text-sm text-sidebar-foreground">{group.title}</span>
              </span>
            </SidebarMenuButton>
          }
        />
        <ThreadHoverCardPopup side="right" align="start">
          <ThreadHoverCard title={group.title}>
            {members.length === 0 ? (
              <span>No members</span>
            ) : (
              members.map((member) => <MemberStatusRow key={member.id} member={member} />)
            )}
          </ThreadHoverCard>
        </ThreadHoverCardPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

function GroupList({
  groups,
  members,
}: {
  groups: ReadonlyArray<GroupChatGroup>;
  members: ReadonlyArray<GroupChatMember>;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const openGroup = (groupId: GroupChatGroup["id"]) => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/group-chat/$groupId", params: { groupId } });
  };
  return (
    <SidebarMenu>
      {groups.map((group) => (
        <GroupRow
          key={group.id}
          group={group}
          members={members.filter((m) => m.groupId === group.id)}
          active={pathname === `/group-chat/${group.id}`}
          onSelect={() => openGroup(group.id)}
        />
      ))}
    </SidebarMenu>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="px-2 pb-1 text-2xs font-medium uppercase tracking-wide text-sidebar-muted-foreground">
      {children}
    </p>
  );
}

const byActivity = (a: GroupChatGroup, b: GroupChatGroup) =>
  b.lastActivityAt.localeCompare(a.lastActivityAt);

export function GroupChatSidebar() {
  const snapshot = useGroupChatSnapshot();
  const [creating, setCreating] = useState(false);
  const groups = snapshot.status === "ready" ? [...snapshot.groups].sort(byActivity) : [];
  const members = snapshot.status === "ready" ? snapshot.members : [];
  const active = groups.filter((group) => group.settledAt === null);
  const settled = groups.filter((group) => group.settledAt !== null);
  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => setCreating(true)}
                disabled={snapshot.status !== "ready"}
                data-testid="new-group-chat"
              >
                <PlusIcon />
                New group chat
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {snapshot.status !== "ready" ? null : (
          <>
            <SidebarGroup data-testid="active-groups">
              <SectionLabel>Active</SectionLabel>
              {active.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-sidebar-muted-foreground">
                  No active group chats
                </p>
              ) : (
                <GroupList groups={active} members={members} />
              )}
            </SidebarGroup>
            {settled.length === 0 ? null : (
              <SidebarGroup data-testid="settled-groups">
                <SectionLabel>Settled</SectionLabel>
                <GroupList groups={settled} members={members} />
              </SidebarGroup>
            )}
          </>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarUtilityMenu />
      </SidebarFooter>
      {creating ? <CreateGroupDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
