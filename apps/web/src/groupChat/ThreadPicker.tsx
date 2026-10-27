import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { Badge } from "../components/ui/badge";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import { useProjects, useThreadShells } from "../state/entities";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { isSubagentThread, pickerRows } from "./picker";

const STATUS_BADGE: Record<
  ReturnType<typeof resolveSidebarThreadStatus>,
  { readonly label: string; readonly variant: "info" | "warning" | "error" | "outline" }
> = {
  approval: { label: "needs approval", variant: "warning" },
  input: { label: "needs answer", variant: "warning" },
  request: { label: "guest request", variant: "warning" },
  working: { label: "working", variant: "info" },
  waiting: { label: "idle", variant: "outline" },
  failed: { label: "failed", variant: "error" },
  limited: { label: "limited", variant: "warning" },
  ready: { label: "ready", variant: "outline" },
};

function ThreadStatusBadge({ thread }: { thread: EnvironmentThreadShell }) {
  const status = STATUS_BADGE[resolveSidebarThreadStatus(thread)];
  return (
    <Badge variant={status.variant} size="sm" data-testid="thread-status">
      {status.label}
    </Badge>
  );
}

export function ThreadPicker({
  selected,
  onToggle,
  exclude,
}: {
  selected: ReadonlySet<ThreadId>;
  onToggle: (thread: EnvironmentThreadShell) => void;
  exclude: ReadonlySet<ThreadId>;
}) {
  // Group chat talks to the server that serves the page, and a member is an unscoped thread id
  // there, so only that environment's threads can join.
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const threads = useThreadShells().filter((t) => t.environmentId === primaryEnvironmentId);
  const projects = useProjects();
  const [query, setQuery] = useState("");
  const [showSubagents, setShowSubagents] = useState(false);
  const rows = pickerRows(threads, { query, showSubagents, exclude });
  const subagentCount = threads.filter(isSubagentThread).length;
  const projectTitle = (thread: EnvironmentThreadShell) =>
    projects.find((p) => p.environmentId === thread.environmentId && p.id === thread.projectId)
      ?.title ?? "";
  return (
    <div className="flex flex-col gap-2" data-testid="thread-picker">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          autoFocus
          size="sm"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by title or thread id (6+ characters)"
          aria-label="Search threads"
          className="min-w-48 flex-1"
        />
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground select-none">
          <Switch size="sm" checked={showSubagents} onCheckedChange={setShowSubagents} />
          Show subagents{subagentCount > 0 ? ` (${subagentCount})` : ""}
        </label>
      </div>
      <ul
        className="flex max-h-[46vh] flex-col overflow-y-auto rounded-lg border"
        data-testid="thread-rows"
      >
        {rows.length === 0 ? (
          <li className="p-4 text-sm text-muted-foreground">No matching threads.</li>
        ) : null}
        {rows.map((thread) => {
          const on = selected.has(thread.id);
          return (
            <li key={`${thread.environmentId}:${thread.id}`} className="border-b last:border-b-0">
              <label
                data-thread-id={thread.id}
                className={cn(
                  "flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/50",
                  on && "bg-primary/8",
                )}
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={() => onToggle(thread)}
                  aria-label={`Select ${thread.title}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm">
                    <span className="truncate">{thread.title}</span>
                    {isSubagentThread(thread) ? (
                      <Badge variant="outline" size="sm">
                        subagent
                      </Badge>
                    ) : null}
                  </span>
                  <span
                    className="flex items-center gap-1.5 truncate text-2xs text-muted-foreground"
                    data-testid="thread-detail"
                  >
                    <span className="shrink-0">{projectTitle(thread)}</span>
                    <span className="truncate font-mono">{thread.id}</span>
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="flex items-center gap-1">
                    <ThreadStatusBadge thread={thread} />
                    <Badge variant="outline" size="sm">
                      {thread.settledAt === null ? "active" : "settled"}
                    </Badge>
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    Updated {formatRelativeTimeLabel(thread.updatedAt)}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
