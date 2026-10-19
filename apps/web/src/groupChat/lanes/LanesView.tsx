import type { GroupChatGroupId } from "@t3tools/contracts";

import { DiscussionPanel } from "../discussion/DiscussionPanel";
import { runningDiscussion } from "../discussion/discussionView";
import type { GroupView } from "../store";
import { SwimLanes } from "./SwimLanes";

const noop = () => undefined;

export function LanesView({ groupId, view }: { groupId: GroupChatGroupId; view: GroupView }) {
  const running = runningDiscussion(view);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="lanes-view">
      <SwimLanes groupId={groupId} view={view} />
      {running === null ? null : (
        <div className="flex min-h-0 flex-col px-5 pt-1 pb-4">
          <DiscussionPanel view={view} discussion={running} onDismiss={noop} />
        </div>
      )}
    </div>
  );
}
