import type {
  ScopedThreadRef,
  ThreadWorkflowChangeRecord,
  ThreadWorkflowInstance,
  ThreadWorkflowInstanceId,
} from "@t3tools/contracts";
import { HistoryIcon } from "lucide-react";

import { Skeleton } from "~/components/ui/skeleton";
import { useEnvironmentQuery } from "~/state/query";
import { threadWorkflowEnvironment } from "~/state/threadWorkflow";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { actorLabel } from "./ThreadWorkflowStepList";

function describe(record: ThreadWorkflowChangeRecord, instance: ThreadWorkflowInstance): string {
  const { event } = record;
  const stepTitle = (stepId: string) =>
    instance.steps.find((step) => step.id === stepId)?.title ?? stepId;
  const questionTitle = (questionId: string) =>
    `"${instance.questions.find((question) => question.id === questionId)?.title ?? questionId}"`;
  const targetTitle = (target: string) =>
    target.includes(".q")
      ? `the question ${questionTitle(target)}`
      : target.includes(".")
        ? stepTitle(target)
        : "the workflow";
  switch (event._tag) {
    case "started":
      return `started "${event.title}"`;
    case "ticked":
      return `marked ${stepTitle(event.stepId)} done`;
    case "skipped":
      return `skipped ${stepTitle(event.stepId)}: ${event.reason}`;
    case "inserted":
      return `added ${event.step.title}: ${event.reason}`;
    case "removed":
      return `removed ${stepTitle(event.stepId)}: ${event.reason}`;
    case "commented":
      return `commented on ${targetTitle(event.target)}`;
    case "reopened":
      return `reopened ${targetTitle(event.target)}: ${event.reason}`;
    case "closed":
      return `closed as ${event.outcome}: ${event.reason}`;
    case "recovered":
      return `recovered the log: ${event.reason}`;
    case "asked":
      return `asked "${event.question.title}"`;
    case "answered":
      return `answered ${questionTitle(event.questionId)}${event.source === "chat" ? " from chat" : ""}`;
    case "withdrawn":
      return `withdrew ${questionTitle(event.questionId)}: ${event.reason}`;
  }
}

function recordComment(record: ThreadWorkflowChangeRecord): string | null {
  const { event } = record;
  if (event._tag === "ticked" || event._tag === "commented") return event.comment;
  if (event._tag === "started") return event.comment;
  if (event._tag === "answered") return event.answer;
  return null;
}

/** Full history comes from `get`, fetched only while this is shown. Newest first. */
export function ThreadWorkflowActivity({
  threadRef,
  instanceId,
  lastChangeAt,
}: {
  threadRef: ScopedThreadRef;
  instanceId: ThreadWorkflowInstanceId;
  lastChangeAt: string;
}) {
  const query = useEnvironmentQuery(
    threadWorkflowEnvironment.instance({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, instanceId },
    }),
  );
  const instance = query.data;
  const records =
    instance === null
      ? []
      : [
          ...instance.history,
          ...instance.steps.flatMap((step) => step.history),
          ...instance.questions.flatMap((question) => question.history),
        ]
          .filter(
            (record, index, all) => all.findIndex((other) => other.seq === record.seq) === index,
          )
          .sort((left, right) => right.seq - left.seq);
  return (
    <section className="flex flex-col gap-2" aria-label="Activity">
      <header className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <HistoryIcon className="size-3" />
        Activity
        <span>
          · last change <time dateTime={lastChangeAt}>{formatRelativeTimeLabel(lastChangeAt)}</time>
        </span>
      </header>
      <ol className="flex flex-col gap-1 border-border border-s ps-3 text-xs">
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
                    <span className="whitespace-pre-wrap text-muted-foreground">"{comment}"</span>
                  ) : null}
                </li>
              );
            })}
      </ol>
    </section>
  );
}
