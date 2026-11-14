import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { PinIcon } from "lucide-react";

import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "../components/chat/threadDetailsPanelStyles";
import { cn } from "../lib/utils";
import { useThreadShell } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { isAgentThread } from "./agentThreads";
import { useAgentPin } from "./useAgentPin";

export function ThreadAgentRow(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useThreadShell(ref);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const { unpinAgent } = useAgentPin();
  if (thread === null || !isAgentThread(thread)) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-agent-heading"
      title="Agent"
      showHeading={false}
      data-testid="thread-details-agent-row"
    >
      <div className={cn("flex items-center", THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS)}>
        <PinIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          Pinned as agent
        </span>
        <ThreadDetailsControl
          part="meta"
          disabled={!canOperate}
          onClick={() => void unpinAgent(ref)}
        >
          Unpin
        </ThreadDetailsControl>
      </div>
    </ThreadDetailsSection>
  );
}
