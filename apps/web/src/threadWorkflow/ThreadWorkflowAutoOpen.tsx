import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { readThreadWorkflowState, threadWorkflowStateAtom } from "../state/threadWorkflow";
import {
  INITIAL_THREAD_WORKFLOW_AUTO_OPEN,
  nextThreadWorkflowAutoOpen,
} from "./threadWorkflowAutoOpen";

/**
 * Renders nothing. Mounted per thread (keyed by the thread) so the chat view itself never
 * subscribes to workflow updates. Opens the Workflow tab on the first snapshot that shows an
 * active instance; the sheet layout opens the same way because the panel store drives both.
 */
export function ThreadWorkflowAutoOpen({ threadRef }: { threadRef: ScopedThreadRef }) {
  const snapshot = readThreadWorkflowState(useAtomValue(threadWorkflowStateAtom(threadRef)));
  const autoOpen = useRef(INITIAL_THREAD_WORKFLOW_AUTO_OPEN);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the panel opens on a server-pushed snapshot, which no handler in this tree receives.
  useEffect(() => {
    const next = nextThreadWorkflowAutoOpen(autoOpen.current, snapshot);
    autoOpen.current = next.state;
    if (!next.open) return;
    const panels = useRightPanelStore.getState();
    panels.openProactive(
      threadRef,
      { id: "workflow", kind: "workflow" },
      panels.getUserActionRevision(threadRef),
    );
  }, [snapshot, threadRef]);
  return null;
}
