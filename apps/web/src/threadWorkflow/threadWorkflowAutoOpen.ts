import type { ThreadWorkflowSubscriptionState } from "@t3tools/contracts";

/**
 * Only the first snapshot after a thread mounts may open the tab, so a later change never
 * steals focus from a tab Lee chose. `decided` is set once that snapshot has been seen.
 */
export interface ThreadWorkflowAutoOpenState {
  readonly decided: boolean;
}

export const INITIAL_THREAD_WORKFLOW_AUTO_OPEN: ThreadWorkflowAutoOpenState = { decided: false };

export function nextThreadWorkflowAutoOpen(
  state: ThreadWorkflowAutoOpenState,
  snapshot: ThreadWorkflowSubscriptionState | null,
): { readonly state: ThreadWorkflowAutoOpenState; readonly open: boolean } {
  if (state.decided || snapshot === null) return { state, open: false };
  return { state: { decided: true }, open: snapshot.view.activeInstanceId !== null };
}
