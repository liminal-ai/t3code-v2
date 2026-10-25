import { threadWorkflowProgress } from "@t3tools/client-runtime/state/thread-workflow";
import type {
  ThreadWorkflowInstanceId,
  ThreadWorkflowInstanceSummary,
  ThreadWorkflowSubscriptionView,
} from "@t3tools/contracts";
import {
  BanIcon,
  CheckIcon,
  HistoryIcon,
  ListChecksIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Undo2Icon,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { ThreadWorkflowFormIntent } from "./threadWorkflowForms";

/** A closed instance reopens only while no other instance is open. */
function canReopen(
  view: ThreadWorkflowSubscriptionView,
  instance: ThreadWorkflowInstanceSummary,
): boolean {
  return instance.status._tag === "closed" && view.activeInstanceId === null;
}

function outcomeLabel(instance: ThreadWorkflowInstanceSummary): string {
  return instance.status._tag === "open"
    ? "open"
    : instance.status.outcome === "finished"
      ? "finished"
      : "abandoned";
}

/** "Stage 3 of 5", or where a finished or closed workflow ended up. */
function stageLine(instance: ThreadWorkflowInstanceSummary): string {
  const progress = threadWorkflowProgress(instance.steps);
  if (instance.status._tag === "closed") {
    return instance.status.outcome === "finished"
      ? `Finished · ${progress.live} ${progress.live === 1 ? "stage" : "stages"}`
      : `Abandoned · ${instance.status.reason}`;
  }
  if (instance.currentStepId === null) {
    return progress.live === 0 ? "No stages yet" : `All ${progress.live} stages done`;
  }
  const position = instance.steps
    .filter((step) => step.state._tag !== "removed")
    .findIndex((step) => step.id === instance.currentStepId);
  return `Stage ${position + 1} of ${progress.live}`;
}

/**
 * Every workflow on the thread, shown while none is open so a closed one can be viewed or
 * reopened, and a new one started.
 */
export function ThreadWorkflowInstanceList({
  view,
  disabled,
  onView,
  onOpenForm,
  onStartNew,
}: {
  view: ThreadWorkflowSubscriptionView;
  disabled: boolean;
  onView: (instanceId: ThreadWorkflowInstanceId) => void;
  onOpenForm: (intent: ThreadWorkflowFormIntent) => void;
  onStartNew: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {view.instances.toReversed().map((instance) => {
        const progress = threadWorkflowProgress(instance.steps);
        return (
          <div
            key={instance.id}
            className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium text-sm">{instance.title}</span>
              <span className="shrink-0 text-muted-foreground text-xs">
                {outcomeLabel(instance)}
              </span>
            </div>
            <div className="text-muted-foreground text-xs">
              {progress.resolved} of {progress.live} stages · started{" "}
              <time dateTime={instance.started.at}>
                {formatRelativeTimeLabel(instance.started.at)}
              </time>
            </div>
            {instance.status._tag === "closed" ? (
              <p className="truncate text-muted-foreground text-xs">{instance.status.reason}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <Button size="xs" variant="outline" onClick={() => onView(instance.id)}>
                View
              </Button>
              {canReopen(view, instance) ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onOpenForm({ kind: "reopen", target: instance.id })}
                >
                  <Undo2Icon />
                  Reopen…
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
      {view.activeInstanceId === null ? (
        <div>
          <Button size="sm" variant="outline" disabled={disabled} onClick={onStartNew}>
            <PlusIcon />
            New workflow…
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Title, "Stage N of M", and one menu for everything else: other workflows, a new one, the
 * activity log, and the instance's close, abandon and reopen. The title row and its text carry
 * `min-w-0` so a long title truncates instead of pushing the menu off the pane.
 */
export function ThreadWorkflowHeader({
  view,
  instance,
  disabled,
  activityOpen,
  onView,
  onOpenForm,
  onStartNew,
  onToggleActivity,
}: {
  view: ThreadWorkflowSubscriptionView;
  instance: ThreadWorkflowInstanceSummary;
  disabled: boolean;
  activityOpen: boolean;
  onView: (instanceId: ThreadWorkflowInstanceId) => void;
  onOpenForm: (intent: ThreadWorkflowFormIntent) => void;
  onStartNew: () => void;
  onToggleActivity: () => void;
}) {
  const open = instance.status._tag === "open";
  const unresolved = instance.steps.some((step) => step.state._tag === "open");
  const others = view.instances.filter((candidate) => candidate.id !== instance.id).toReversed();
  return (
    <header className="flex flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <ListChecksIcon className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate font-semibold text-sm">{instance.title}</h2>
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost-muted" aria-label="Workflow menu" />}
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            {others.length > 0 ? (
              <>
                <MenuGroup>
                  <MenuGroupLabel>Other workflows</MenuGroupLabel>
                  {others.map((candidate) => (
                    <MenuItem key={candidate.id} onClick={() => onView(candidate.id)}>
                      <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                      <span className="text-muted-foreground text-xs">
                        {outcomeLabel(candidate)}
                      </span>
                    </MenuItem>
                  ))}
                </MenuGroup>
                <MenuSeparator />
              </>
            ) : null}
            {view.activeInstanceId === null ? (
              <MenuItem disabled={disabled} onClick={onStartNew}>
                <PlusIcon />
                New workflow…
              </MenuItem>
            ) : null}
            {open ? (
              <MenuItem
                disabled={disabled}
                onClick={() => onOpenForm({ kind: "insert", after: "end" })}
              >
                <PlusIcon />
                Add a step…
              </MenuItem>
            ) : null}
            <MenuItem onClick={onToggleActivity}>
              <HistoryIcon />
              {activityOpen ? "Hide activity" : "Show activity"}
            </MenuItem>
            <MenuSeparator />
            {open ? (
              <>
                <MenuItem
                  disabled={disabled || unresolved}
                  onClick={() =>
                    onOpenForm({ kind: "close", instanceId: instance.id, outcome: "finished" })
                  }
                >
                  <CheckIcon />
                  Close as finished…
                </MenuItem>
                <MenuItem
                  variant="destructive"
                  disabled={disabled}
                  onClick={() =>
                    onOpenForm({ kind: "close", instanceId: instance.id, outcome: "abandoned" })
                  }
                >
                  <BanIcon />
                  Abandon…
                </MenuItem>
              </>
            ) : null}
            {canReopen(view, instance) ? (
              <MenuItem
                disabled={disabled}
                onClick={() => onOpenForm({ kind: "reopen", target: instance.id })}
              >
                <Undo2Icon />
                Reopen…
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
      <p className="ps-6 text-muted-foreground text-xs">{stageLine(instance)}</p>
    </header>
  );
}
