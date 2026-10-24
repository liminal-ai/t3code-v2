import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";
import { HandIcon, MessageSquareIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { formatRelativeTimeLabel } from "~/timestampFormat";

/**
 * "Waiting on you": the pending question-tool requests, pinned above the list so a new update
 * never pushes a question out of sight. Capped in height so a long question cannot squeeze the
 * list out. Empty means hidden. No animation: a question appearing is the signal.
 */
export function ThreadWorkflowStrip({
  asks,
  onAnswerInComposer,
}: {
  asks: ReadonlyArray<ThreadPendingUserInput>;
  onAnswerInComposer: () => void;
}) {
  if (asks.length === 0) return null;
  return (
    <section
      aria-label="Waiting on you"
      data-thread-workflow-asks
      className="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-y-auto border-warning/40 border-b border-s-2 bg-warning/6 px-3 py-2"
    >
      <header className="flex items-center gap-2 text-xs">
        <HandIcon className="size-3.5 text-warning" />
        <span className="font-semibold text-warning-foreground">Waiting on you</span>
        {asks.length > 1 ? (
          <Badge variant="warning" size="sm">
            {asks.length}
          </Badge>
        ) : null}
      </header>
      {asks.map((ask) => (
        <article
          key={ask.requestId}
          className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2"
        >
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <MessageSquareIcon className="size-3.5" />
            <span>The agent asked</span>
            <time className="ms-auto" dateTime={ask.createdAt}>
              {formatRelativeTimeLabel(ask.createdAt)}
            </time>
          </div>
          {ask.questions.map((question) => (
            <p key={question.id} className="text-sm">
              <span className="font-medium">{question.header}</span>
              {question.header === question.question ? null : ` ${question.question}`}
            </p>
          ))}
          <div>
            <Button size="xs" variant="outline" onClick={onAnswerInComposer}>
              <MessageSquareIcon />
              Answer in composer
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}
