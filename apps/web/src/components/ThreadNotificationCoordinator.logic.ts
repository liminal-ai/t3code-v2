import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";

import type { SidebarThreadStatus } from "./Sidebar.logic";

export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
}

/**
 * Attention notifies at once. Completion waits out the Working shelf's exit grace,
 * because an orchestrator run can end moments before its continuation starts. Any
 * observation that is not settled during the wait cancels it.
 */
export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
) {
  const pending = new Map<Key, { at: number; timer: ReturnType<typeof setTimeout> }>();
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  // The newest completion seen settled, kept while the thread works or waits.
  const lastSettled = new Map<Key, number>();
  const cancel = (key: Key) => {
    clearTimeout(pending.get(key)?.timer);
    pending.delete(key);
  };
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: { readonly archived: boolean; readonly quiet: boolean },
    ): void {
      if (next.settled && next.completedAt !== null) lastSettled.set(key, next.completedAt);
      if (!next.settled || options.archived || options.quiet) cancel(key);
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      if (!prior || options.archived) return;
      if (next.attention && next.attention !== prior.attention) {
        // Attention replaces the completion before it, so that run must not notify later.
        skip(key, lastSettled.get(key) ?? null);
        cancel(key);
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      if (pending.get(key)?.at === at) return;
      cancel(key);
      pending.set(key, {
        at,
        timer: setTimeout(() => {
          pending.delete(key);
          handled.set(key, at);
          notify(key, "completion");
        }, WORKING_EXIT_GRACE_MS),
      });
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of pending.keys()) if (!keys.has(key)) cancel(key);
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
      for (const key of lastSettled.keys()) if (!keys.has(key)) lastSettled.delete(key);
    },
    clear(): void {
      for (const key of pending.keys()) cancel(key);
      handled.clear();
      lastSettled.clear();
    },
  };
}

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
  status === "input" ||
  status === "request" ||
  status === "approval" ||
  status === "failed" ||
  status === "limited";

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
