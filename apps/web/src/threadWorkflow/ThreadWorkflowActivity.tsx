import type {
  ScopedThreadRef,
  ThreadWorkflowChangeRecord,
  ThreadWorkflowInstance,
  ThreadWorkflowInstanceId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, HistoryIcon } from "lucide-react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Skeleton } from "~/components/ui/skeleton";
import { useEnvironmentQuery } from "~/state/query";
import { threadWorkflowEnvironment } from "~/state/threadWorkflow";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { actorLabel } from "./ThreadWorkflowStepParts";

function describe(record: ThreadWorkflowChangeRecord, instance: ThreadWorkflowInstance): string {
  const { event } = record;
  const stepTitle = (stepId: string) =>
    instance.steps.find((step) => step.id === stepId)?.title ?? stepId;
  switch (event._tag) {
    case "started":
      return `started "${event.title}"`;
    case "ticked":
      return `ticked ${stepTitle(event.stepId)}`;
    case "skipped":
      return `skipped ${stepTitle(event.stepId)}: ${event.reason}`;
    case "inserted":
      return `inserted ${event.step.title}: ${event.reason}`;
    case "removed":
      return `removed ${stepTitle(event.stepId)}: ${event.reason}`;
    case "commented":
      return `commented on ${event.target.includes(".") ? stepTitle(event.target) : "the workflow"}`;
    case "reopened":
      return `reopened ${event.target.includes(".") ? stepTitle(event.target) : "the workflow"}: ${event.reason}`;
    case "closed":
      return `closed as ${event.outcome}: ${event.reason}`;
    case "recovered":
      return `recovered the log: ${event.reason}`;
  }
}

function recordComment(record: ThreadWorkflowChangeRecord): string | null {
  const { event } = record;
  if (event._tag === "ticked" || event._tag === "commented") return event.comment;
  if (event._tag === "started") return event.comment;
  return null;
}

/** Full history comes from `get`, fetched only while this is expanded. Newest first. */
export function ThreadWorkflowActivity({
  threadRef,
  instanceId,
  lastChangeAt,
  open,
  onOpenChange,
}: {
  threadRef: ScopedThreadRef;
  instanceId: ThreadWorkflowInstanceId;
  lastChangeAt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useEnvironmentQuery(
    open
      ? threadWorkflowEnvironment.instance({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, instanceId },
        })
      : null,
  );
  const instance = query.data;
  const records =
    instance === null
      ? []
      : [...instance.history, ...instance.steps.flatMap((step) => step.history)]
          .filter(
            (record, index, all) => all.findIndex((other) => other.seq === record.seq) === index,
          )
          .sort((left, right) => right.seq - left.seq);
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground">
        {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        <HistoryIcon className="size-3" />
        Activity
        <span>
          · last change <time dateTime={lastChangeAt}>{formatRelativeTimeLabel(lastChangeAt)}</time>
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ol className="mt-2 flex flex-col gap-1 border-border border-s ps-3 text-xs">
          {instance === null && query.error === null ? <Skeleton className="h-12 w-full" /> : null}
          {query.error ? <li className="text-destructive">{query.error}</li> : null}
          {instance === null
            ? null
            : records.map((record) => {
                const comment = recordComment(record);
                return (
                  <li key={record.seq} className="flex flex-col">
                    <span>
                      <time className="text-muted-foreground" dateTime={record.at}>
                        {formatRelativeTimeLabel(record.at)}
                      </time>{" "}
                      · <span className="font-medium">{actorLabel(record)}</span>{" "}
                      {describe(record, instance)}
                    </span>
                    {comment ? (
                      <span className="whitespace-pre-wrap text-muted-foreground">“{comment}”</span>
                    ) : null}
                  </li>
                );
              })}
        </ol>
      </CollapsiblePanel>
    </Collapsible>
  );
}
