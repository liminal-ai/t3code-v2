/* oxlint-disable t3code/no-untranslated-copy -- fork copy stays English, so the catalogs stay upstream's */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";

import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import { useThreadShell } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { isAgentThread } from "./agentThreads";
import { THREAD_DETAILS_FOOT_ROW_CLASS } from "./threadDetailsFootStyles";
import { useAgentPin } from "./useAgentPin";

/** One foot row of the details card: the thread is an agent, and Unpin undoes it. */
export function ThreadAgentRow(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useThreadShell(ref);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const { unpinAgent } = useAgentPin();
  if (thread === null || !isAgentThread(thread)) return null;
  return (
    <div className={THREAD_DETAILS_FOOT_ROW_CLASS} data-testid="thread-details-agent-row">
      <span className="min-w-0 truncate text-muted-foreground">Pinned as agent</span>
      <ThreadDetailsControl
        part="meta"
        className="-me-1.5"
        disabled={!canOperate}
        onClick={() => void unpinAgent(ref)}
      >
        Unpin
      </ThreadDetailsControl>
    </div>
  );
}
