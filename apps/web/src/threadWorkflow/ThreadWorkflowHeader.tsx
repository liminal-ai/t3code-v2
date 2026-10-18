import { threadWorkflowProgress } from "@t3tools/client-runtime/state/thread-workflow";
import type {
  ThreadWorkflowInstanceId,
  ThreadWorkflowInstanceSummary,
  ThreadWorkflowSubscriptionView,
} from "@t3tools/contracts";
import {
  BanIcon,
  ChevronsUpDownIcon,
  ListChecksIcon,
  LockIcon,
  PlusIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { StampLabel } from "./ThreadWorkflowStepParts";
import type { ThreadWorkflowFormIntent } from "./threadWorkflowForms";
import { THREAD_WORKFLOW_LAYOUTS, useThreadWorkflowLayoutStore } from "./threadWorkflowLayoutStore";

// Delete this toggle with the losing layout: it exists only while both layouts ship.
export function ThreadWorkflowLayoutToggle() {
  const layout = useThreadWorkflowLayoutStore((state) => state.layout);
  const setLayout = useThreadWorkflowLayoutStore((state) => state.setLayout);
  return (
    <ToggleGroup
      aria-label="Workflow pane layout"
      value={[layout]}
      onValueChange={(next) => {
        const chosen = THREAD_WORKFLOW_LAYOUTS.find((candidate) => candidate.id === next[0]);
        if (chosen) setLayout(chosen.id);
      }}
    >
      {THREAD_WORKFLOW_LAYOUTS.map((candidate) => (
        <Toggle key={candidate.id} value={candidate.id}>
          {candidate.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function InstanceStatusBadge({ instance }: { instance: ThreadWorkflowInstanceSummary }) {
  if (instance.status._tag === "open") {
    return (
      <Badge variant="info" size="sm">
        active
      </Badge>
    );
  }
  return (
    <Badge variant={instance.status.outcome === "finished" ? "success" : "outline"} size="sm">
      {instance.status.outcome}
    </Badge>
  );
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/** Template provenance and the stale flag recorded at start; a stale template still ran. */
function TemplateLine({ instance }: { instance: ThreadWorkflowInstanceSummary }) {
  const progress = threadWorkflowProgress(instance.steps);
  const source = instance.template.source;
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs">
      <span>from</span>
      <code className="rounded-sm bg-muted px-1 py-px text-foreground/80">
        {source ? source.playbook : instance.template.id}
      </code>
      {source ? (
        <>
          <span>@</span>
          <code className="rounded-sm bg-muted px-1 py-px text-foreground/80">
            {shortCommit(source.commit)}
          </code>
        </>
      ) : null}
      {instance.template.staleAtStart ? (
        <span className="flex items-center gap-1 text-warning-foreground">
          <TriangleAlertIcon className="size-3" />
          template stale at start
        </span>
      ) : null}
      <span>·</span>
      <span>
        opened by <StampLabel stamp={instance.started} />
      </span>
      <span>·</span>
      <span>
        {progress.resolved} of {progress.live} steps
      </span>
    </div>
  );
}

/** Visible while the instance is open: the thread cannot settle, archive or be deleted. */
function SettleBlockedBar({
  instance,
  disabled,
  onOpenForm,
}: {
  instance: ThreadWorkflowInstanceSummary;
  disabled: boolean;
  onOpenForm: (intent: ThreadWorkflowFormIntent) => void;
}) {
  if (instance.status._tag !== "open") return null;
  const unresolved = instance.steps.some((step) => step.state._tag === "open");
  return (
    <div className="flex items-center gap-2 rounded-lg border border-warning/32 bg-warning-surface px-3 py-1.5 text-warning-foreground text-xs">
      <LockIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        <span className="font-medium">Settle blocked</span> while this workflow is open
      </span>
      <div className="ms-auto flex shrink-0 items-center gap-1">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || unresolved}
          onClick={() =>
            onOpenForm({ kind: "close", instanceId: instance.id, outcome: "finished" })
          }
        >
          Close…
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            onOpenForm({ kind: "close", instanceId: instance.id, outcome: "abandoned" })
          }
        >
          <BanIcon />
          Abandon…
        </Button>
      </div>
    </div>
  );
}

/** A closed instance reopens only while no other instance is open. */
function canReopen(
  view: ThreadWorkflowSubscriptionView,
  instance: ThreadWorkflowInstanceSummary,
): boolean {
  return instance.status._tag === "closed" && view.activeInstanceId === null;
}

function ReopenButton({
  instance,
  disabled,
  onOpenForm,
}: {
  instance: ThreadWorkflowInstanceSummary;
  disabled: boolean;
  onOpenForm: (intent: ThreadWorkflowFormIntent) => void;
}) {
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={disabled}
      onClick={() => onOpenForm({ kind: "reopen", target: instance.id })}
    >
      <Undo2Icon />
      Reopen…
    </Button>
  );
}

/** Visible while the viewed instance is closed and could be reopened: the way back to it. */
function ClosedBar({
  view,
  instance,
  disabled,
  onOpenForm,
}: {
  view: ThreadWorkflowSubscriptionView;
  instance: ThreadWorkflowInstanceSummary;
  disabled: boolean;
  onOpenForm: (intent: ThreadWorkflowFormIntent) => void;
}) {
  if (instance.status._tag !== "closed" || !canReopen(view, instance)) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-muted-foreground text-xs">
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">Closed as {instance.status.outcome}</span>
        {" · "}
        <span className="italic">{instance.status.reason}</span>
      </span>
      <div className="ms-auto shrink-0">
        <ReopenButton instance={instance} disabled={disabled} onOpenForm={onOpenForm} />
      </div>
    </div>
  );
}

/** Every instance on the thread. */
export function ThreadWorkflowInstanceList({
  view,
  viewedInstanceId,
  disabled,
  onView,
  onOpenForm,
  onStartNew,
}: {
  view: ThreadWorkflowSubscriptionView;
  viewedInstanceId: ThreadWorkflowInstanceId | null;
  disabled: boolean;
  onView: (instanceId: ThreadWorkflowInstanceId) => void;
  onOpenForm: (intent: ThreadWorkflowFormIntent) => void;
  onStartNew: () => void;
}) {
  const ordered = view.instances.toReversed();
  return (
    <div className="flex flex-col gap-2">
      {ordered.map((instance) => {
        const progress = threadWorkflowProgress(instance.steps);
        const viewed = instance.id === viewedInstanceId;
        return (
          <div
            key={instance.id}
            className={
              viewed
                ? "flex flex-col gap-1 rounded-lg border border-info/40 bg-card px-3 py-2"
                : "flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2"
            }
          >
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-sm">{instance.title}</span>
              <InstanceStatusBadge instance={instance} />
              <span className="ms-auto text-muted-foreground text-xs">{instance.id}</span>
            </div>
            <div className="text-muted-foreground text-xs">
              {instance.template.id} · {progress.resolved} of {progress.live} steps · opened{" "}
              <time dateTime={instance.started.at}>
                {formatRelativeTimeLabel(instance.started.at)}
              </time>
              {instance.status._tag === "closed" ? (
                <>
                  {" "}
                  · {instance.status.outcome}{" "}
                  <time dateTime={instance.status.stamp.at}>
                    {formatRelativeTimeLabel(instance.status.stamp.at)}
                  </time>
                </>
              ) : null}
            </div>
            {instance.status._tag === "closed" ? (
              <p className="text-muted-foreground text-xs">
                Reason: <span className="italic">{instance.status.reason}</span>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {viewed ? null : (
                <Button size="xs" variant="outline" onClick={() => onView(instance.id)}>
                  View steps
                </Button>
              )}
              {canReopen(view, instance) ? (
                <ReopenButton instance={instance} disabled={disabled} onOpenForm={onOpenForm} />
              ) : null}
            </div>
          </div>
        );
      })}
      {view.activeInstanceId === null ? (
        <div>
          <Button size="sm" variant="outline" disabled={disabled} onClick={onStartNew}>
            <PlusIcon />
            New workflow from template…
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The pane header above either layout: title and status, the instance switcher, template
 * provenance, and the instance's lifecycle calls (close and abandon while open, reopen once closed).
 */
export function ThreadWorkflowHeader({
  view,
  instance,
  disabled,
  onView,
  onOpenForm,
  onStartNew,
}: {
  view: ThreadWorkflowSubscriptionView;
  instance: ThreadWorkflowInstanceSummary;
  disabled: boolean;
  onView: (instanceId: ThreadWorkflowInstanceId) => void;
  onOpenForm: (intent: ThreadWorkflowFormIntent) => void;
  onStartNew: () => void;
}) {
  const position = view.instances.findIndex((candidate) => candidate.id === instance.id) + 1;
  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ListChecksIcon className="size-4 shrink-0 text-muted-foreground" />
        <Menu>
          <MenuTrigger
            render={
              <Button size="sm" variant="ghost" aria-label="Switch workflow">
                <span className="truncate font-semibold">{instance.title}</span>
                <InstanceStatusBadge instance={instance} />
                {view.instances.length > 1 ? (
                  <span className="text-muted-foreground text-xs">
                    · {position} of {view.instances.length}
                  </span>
                ) : null}
                <ChevronsUpDownIcon />
              </Button>
            }
          />
          <MenuPopup align="start" side="bottom">
            {view.instances.toReversed().map((candidate) => (
              <MenuItem key={candidate.id} onClick={() => onView(candidate.id)}>
                <span className="min-w-0 truncate">{candidate.title}</span>
                <InstanceStatusBadge instance={candidate} />
              </MenuItem>
            ))}
            {view.activeInstanceId === null ? (
              <MenuItem onClick={onStartNew}>
                <PlusIcon className="size-3.5" />
                New workflow from template…
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
        <div className="ms-auto">
          <ThreadWorkflowLayoutToggle />
        </div>
      </div>
      <TemplateLine instance={instance} />
      <SettleBlockedBar instance={instance} disabled={disabled} onOpenForm={onOpenForm} />
      <ClosedBar view={view} instance={instance} disabled={disabled} onOpenForm={onOpenForm} />
    </header>
  );
}
