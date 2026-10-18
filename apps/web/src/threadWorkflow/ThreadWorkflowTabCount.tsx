import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { threadWorkflowOpenAskCountAtom } from "~/state/threadWorkflow";

/** The open-ask count beside the Workflow tab title, so an ask shows while another tab is active. */
export function ThreadWorkflowTabCount({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const count = useAtomValue(threadWorkflowOpenAskCountAtom(threadRef));
  if (count === 0) return null;
  return (
    <span className="ms-1 inline-flex min-w-4 items-center justify-center rounded-sm bg-warning/16 px-1 font-medium text-3xs text-warning-foreground tabular-nums">
      {count}
    </span>
  );
}
