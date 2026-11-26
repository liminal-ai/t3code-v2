/* oxlint-disable t3code/no-untranslated-copy -- fork copy stays English, so the catalogs stay upstream's */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";

import { cn } from "../lib/utils";
import { useThreadShell } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { isAgentThread } from "./agentThreads";
import { THREAD_DETAILS_FOOT_ROW_CLASS } from "./threadDetailsFootStyles";
import { useAgentPin } from "./useAgentPin";

/** One foot row of the details card: the thread is an agent, and Unpin undoes it. */
export function ThreadAgentRow(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  className?: string;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useThreadShell(ref);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const { unpinAgent } = useAgentPin();
  if (thread === null || !isAgentThread(thread)) return null;
  return (
    <div
      className={cn(THREAD_DETAILS_FOOT_ROW_CLASS, props.className)}
      data-testid="thread-details-agent-row"
    >
      <span className="min-w-0 truncate text-muted-foreground">Pinned as agent</span>
      {/* The block's one control: stronger than the values beside it, the row's full height,
          with the panel rows' hover fill and focus ring. */}
      <button
        type="button"
        className="-me-1.5 h-6 shrink-0 cursor-pointer rounded-md px-1.5 font-medium text-foreground/80 outline-none hover:bg-black/[0.035] hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 dark:hover:bg-white/[0.08]"
        disabled={!canOperate}
        onClick={() => void unpinAgent(ref)}
      >
        Unpin
      </button>
    </div>
  );
}
