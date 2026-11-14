import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";

export const AGENT_THREAD_TAG = "agent";

type AgentThreadCandidate = Pick<EnvironmentThreadShell, "pinnedAt"> & {
  readonly source: { readonly tags?: ReadonlyArray<string> | undefined };
};

export function isAgentThread(thread: AgentThreadCandidate): boolean {
  return thread.pinnedAt != null && (thread.source.tags?.includes(AGENT_THREAD_TAG) ?? false);
}

type AgentSortable = Pick<
  EnvironmentThreadShell,
  "id" | "latestUserMessageAt" | "latestRun" | "updatedAt"
>;

function activityMs(thread: AgentSortable): number {
  const timestamp = resolveThreadActivityTimestamp(thread);
  return timestamp === null ? 0 : Date.parse(timestamp);
}

function sortAgentThreads<T extends AgentSortable>(threads: readonly T[]): T[] {
  return threads
    .map((thread) => ({ thread, ms: activityMs(thread) }))
    .sort(
      (left, right) =>
        right.ms - left.ms ||
        (left.thread.id < right.thread.id ? -1 : left.thread.id > right.thread.id ? 1 : 0),
    )
    .map(({ thread }) => thread);
}

export function splitAgentThreads<T extends AgentThreadCandidate & AgentSortable>(
  threads: readonly T[],
): { readonly agents: readonly T[]; readonly others: readonly T[] } {
  if (!threads.some(isAgentThread)) return { agents: [], others: threads };
  const agents: T[] = [];
  const others: T[] = [];
  for (const thread of threads) (isAgentThread(thread) ? agents : others).push(thread);
  return { agents: sortAgentThreads(agents), others };
}

export const AGENTS_SHELF_EXPANDED_KEY = "t3code:sidebar:agents-expanded";
