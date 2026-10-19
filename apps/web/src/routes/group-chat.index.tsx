import { createFileRoute } from "@tanstack/react-router";

import { GroupChatPage } from "../groupChat/GroupChatPage";

export const Route = createFileRoute("/group-chat/")({
  component: () => <GroupChatPage />,
});
