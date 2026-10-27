import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import type { SidebarThreadStatus } from "./Sidebar.logic";

type AttentionThread = Pick<
  EnvironmentThreadShell,
  "latestRun" | "hasPendingUserInput" | "pendingSubagentRequest"
>;

/** The counter of `w2.q3`; 0 for no question. */
export function workflowQuestionNumber(questionId: string | null | undefined): number {
  const match = /\.q(\d+)$/.exec(questionId ?? "");
  return match === null ? 0 : Number(match[1]);
}

const needsUser = (status: SidebarThreadStatus) =>
  status === "input" || status === "approval" || status === "failed" || status === "limited";

const inputIsOnlyWorkflowQuestions = (status: SidebarThreadStatus, thread: AttentionThread) =>
  status === "input" &&
  !thread.hasPendingUserInput &&
  thread.pendingSubagentRequest !== "user_input";

/** Changes once per new question on the thread, and not on a new run or an answer. */
const workflowQuestionKey = (workflowHighWater: number) => `workflow:${workflowHighWater}`;

/** Changes with the run that needs the user, and with a new workflow question. */
const runStatusKey = (
  status: SidebarThreadStatus,
  thread: AttentionThread,
  workflowHighWater: number,
) => `${thread.latestRun?.runId ?? ""}:${status}:${workflowHighWater}`;

/**
 * What a notification keys on: the thread notifies once per change of this. `workflowHighWater`
 * is the highest workflow question number the thread has shown.
 */
export function threadAttentionKey(
  status: SidebarThreadStatus,
  thread: AttentionThread,
  workflowHighWater: number,
): string | null {
  if (!needsUser(status)) return null;
  return inputIsOnlyWorkflowQuestions(status, thread)
    ? workflowQuestionKey(workflowHighWater)
    : runStatusKey(status, thread, workflowHighWater);
}
