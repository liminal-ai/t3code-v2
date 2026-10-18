import type { ThreadWorkflowAsk } from "@t3tools/client-runtime/state/thread-workflow";
import { CheckIcon, HandIcon, MessageSquareIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { StepStateIcon } from "./ThreadWorkflowStepParts";
import type { ThreadWorkflowFormIntent } from "./threadWorkflowForms";

/**
 * "Waiting on you": every pending question-tool request and every open waits-for-user step,
 * pinned above everything that scrolls so a new update never pushes an ask out of sight.
 * Empty means hidden. No animation: an ask appearing is the signal.
 */
export function ThreadWorkflowStrip({
  asks,
  disabled,
  formStepId,
  renderForm,
  onOpenForm,
  onAnswerInComposer,
}: {
  asks: ReadonlyArray<ThreadWorkflowAsk>;
  disabled: boolean;
  formStepId: string | null;
  renderForm: () => React.ReactNode;
  onOpenForm: (intent: ThreadWorkflowFormIntent) => void;
  onAnswerInComposer: () => void;
}) {
  if (asks.length === 0) return null;
  return (
    <section
      aria-label="Waiting on you"
      data-thread-workflow-asks
      className="flex shrink-0 flex-col gap-2 border-warning/40 border-b border-s-2 bg-warning/6 px-3 py-2"
    >
      <header className="flex items-center gap-2 text-xs">
        <HandIcon className="size-3.5 text-warning" />
        <span className="font-semibold text-warning-foreground uppercase tracking-wide">
          Waiting on you
        </span>
        <Badge variant="warning" size="sm">
          {asks.length}
        </Badge>
        <span className="ms-auto text-muted-foreground">pinned until answered</span>
      </header>
      {asks.map((ask) =>
        ask.kind === "question" ? (
          <article
            key={ask.request.requestId}
            className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2"
          >
            <div className="flex items-center gap-2 text-xs">
              <MessageSquareIcon className="size-3.5 text-muted-foreground" />
              <span>
                The agent asked{" "}
                <Badge variant="outline" size="sm">
                  question
                </Badge>
              </span>
              <time className="ms-auto text-muted-foreground" dateTime={ask.request.createdAt}>
                {formatRelativeTimeLabel(ask.request.createdAt)}
              </time>
            </div>
            {ask.request.questions.map((question) => (
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
        ) : (
          <article
            key={ask.step.id}
            className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2"
          >
            <div className="flex items-center gap-2 text-xs">
              <StepStateIcon step={ask.step} current={ask.instance.currentStepId === ask.step.id} />
              <span>
                Step {ask.stepNumber}{" "}
                <Badge variant="info" size="sm">
                  waits for you
                </Badge>
              </span>
              <span className="ms-auto truncate text-muted-foreground">{ask.instance.title}</span>
            </div>
            <p className="font-medium text-sm">{ask.step.title}</p>
            {formStepId === ask.step.id ? (
              renderForm()
            ) : (
              <div>
                <Button
                  size="xs"
                  disabled={disabled}
                  onClick={() => onOpenForm({ kind: "tick", stepId: ask.step.id })}
                >
                  <CheckIcon />
                  Tick gate
                </Button>
              </div>
            )}
          </article>
        ),
      )}
    </section>
  );
}
