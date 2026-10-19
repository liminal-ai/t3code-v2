import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ThreadId } from "@t3tools/contracts";

const ID_PREFIX_MIN_CHARS = 6;

export function matchesThread(
  thread: { readonly id: string; readonly title: string },
  rawQuery: string,
): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === "") return true;
  const id = thread.id.toLowerCase();
  if (id === query) return true;
  if (
    query.length >= ID_PREFIX_MIN_CHARS &&
    (id.startsWith(query) || id.split(":").some((segment) => segment.startsWith(query)))
  ) {
    return true;
  }
  return thread.title.toLowerCase().includes(query);
}

export const isSubagentThread = (thread: EnvironmentThreadShell) =>
  thread.lineage.relationshipToParent === "subagent";

const isPickable = (thread: EnvironmentThreadShell) =>
  thread.archivedAt === null && thread.deletedAt === null;

export interface PickerFilter {
  readonly query: string;
  readonly showSubagents: boolean;
  readonly exclude: ReadonlySet<ThreadId>;
}

export function pickerRows(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  filter: PickerFilter,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads
    .filter(isPickable)
    .filter((thread) => filter.showSubagents || !isSubagentThread(thread))
    .filter((thread) => !filter.exclude.has(thread.id))
    .filter((thread) => matchesThread(thread, filter.query))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
