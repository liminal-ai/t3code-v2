import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadWorkflowQuestionId } from "@t3tools/contracts";
import { create } from "zustand";

import { useRightPanelStore } from "../rightPanelStore";

interface PendingReveal {
  readonly threadKey: string;
  readonly questionId: ThreadWorkflowQuestionId;
}

/** The question the chat column asked the Workflow tab to show, until its row has shown it. */
const useRevealStore = create<{ readonly pending: PendingReveal | null }>(() => ({
  pending: null,
}));

/** Opens the Workflow tab on the question: expanded, scrolled to, its answer field focused. */
export function revealThreadWorkflowQuestion(
  ref: ScopedThreadRef,
  questionId: ThreadWorkflowQuestionId,
): void {
  useRevealStore.setState({ pending: { threadKey: scopedThreadKey(ref), questionId } });
  useRightPanelStore.getState().open(ref, "workflow");
}

export function usePendingThreadWorkflowReveal(
  ref: ScopedThreadRef,
): ThreadWorkflowQuestionId | null {
  const threadKey = scopedThreadKey(ref);
  return useRevealStore((state) =>
    state.pending?.threadKey === threadKey ? state.pending.questionId : null,
  );
}

export function clearThreadWorkflowReveal(): void {
  useRevealStore.setState({ pending: null });
}
