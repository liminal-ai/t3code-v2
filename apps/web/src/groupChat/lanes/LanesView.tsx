import type { GroupChatGroupId } from "@t3tools/contracts";
import { useMemo } from "react";

import { Composer } from "../Composer";
import { DiscussionPanel } from "../discussion/DiscussionPanel";
import { runningDiscussion } from "../discussion/discussionView";
import type { GroupView } from "../store";
import { SwimLanes } from "./SwimLanes";

const noop = () => undefined;

/** The lanes with the composer under them, so a message can go out from either view. */
export function LanesView({ groupId, view }: { groupId: GroupChatGroupId; view: GroupView }) {
  const running = runningDiscussion(view);
  const activeMembers = useMemo(
    () =>
      [...view.members.values()]
        .filter((m) => m.removedAt === null)
        .sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
    [view.members],
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="lanes-view">
      <SwimLanes groupId={groupId} view={view} />
      <div className="flex min-h-0 flex-col px-5 pt-1 pb-4">
        {running === null ? null : (
          <DiscussionPanel view={view} discussion={running} onDismiss={noop} />
        )}
        <Composer groupId={groupId} members={activeMembers} view={view} />
      </div>
    </div>
  );
}
