import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import type { SidebarThreadStatus } from "./Sidebar.logic";

type AttentionThread = Pick<
  EnvironmentThreadShell,
  "latestRun" | "hasPendingUserInput" | "pendingSubagentRequest"
>;

/**
 * Orders question ids across workflows: `w2.q1` comes after `w1.q5`, because a new workflow starts
 * its questions at `q1` again. Returns the later of the two, or null for none.
 */
export function laterWorkflowQuestion(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null {
  const rank = (id: string | null | undefined): readonly [number, number] | null => {
    const match = /^w(\d+)\.q(\d+)$/.exec(id ?? "");
    return match === null ? null : [Number(match[1]), Number(match[2])];
  };
  const leftRank = rank(left);
  const rightRank = rank(right);
  if (leftRank === null) return rightRank === null ? null : (right ?? null);
  if (rightRank === null) return left ?? null;
  const rightIsLater =
    rightRank[0] > leftRank[0] || (rightRank[0] === leftRank[0] && rightRank[1] > leftRank[1]);
  return rightIsLater ? (right ?? null) : (left ?? null);
}

const needsUser = (status: SidebarThreadStatus) =>
  status === "input" || status === "approval" || status === "failed" || status === "limited";

const inputIsOnlyWorkflowQuestions = (status: SidebarThreadStatus, thread: AttentionThread) =>
  status === "input" &&
  !thread.hasPendingUserInput &&
  thread.pendingSubagentRequest !== "user_input";

/** Changes once per new question on the thread, and not on a new run or an answer. */
const workflowQuestionKey = (workflowHighWater: string | null) =>
  `workflow:${workflowHighWater ?? ""}`;

/** Changes with the run that needs the user, and with a new workflow question. */
const runStatusKey = (
  status: SidebarThreadStatus,
  thread: AttentionThread,
  workflowHighWater: string | null,
) => `${thread.latestRun?.runId ?? ""}:${status}:${workflowHighWater ?? ""}`;

/**
 * What a notification keys on: the thread notifies once per change of this. `workflowHighWater`
 * is the latest workflow question id the thread has shown, by `laterWorkflowQuestion`.
 */
export function threadAttentionKey(
  status: SidebarThreadStatus,
  thread: AttentionThread,
  workflowHighWater: string | null,
): string | null {
  if (!needsUser(status)) return null;
  return inputIsOnlyWorkflowQuestions(status, thread)
    ? workflowQuestionKey(workflowHighWater)
    : runStatusKey(status, thread, workflowHighWater);
}
