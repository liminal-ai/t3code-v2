import { createFileRoute } from "@tanstack/react-router";

import { GroupChatPage } from "../groupChat/GroupChatPage";

function GroupChatGroupRoute() {
  const { groupId } = Route.useParams();
  return <GroupChatPage groupId={groupId} />;
}

export const Route = createFileRoute("/group-chat/$groupId")({
  component: GroupChatGroupRoute,
});
