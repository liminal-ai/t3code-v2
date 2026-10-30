import { openThreadWorkflowQuestions } from "@t3tools/client-runtime/state/thread-workflow";
import {
  THREAD_WORKFLOW_LIMITS,
  type ThreadWorkflowInstanceSummary,
  type ThreadWorkflowQuestionId,
  type ThreadWorkflowQuestionSummary,
  type ThreadWorkflowRequest,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MessageCircleQuestionIcon,
  Undo2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { clearThreadWorkflowReveal } from "./threadWorkflowQuestionReveal";
import { actorLabel } from "./ThreadWorkflowStepList";

const REOPEN_REASON = "Reopened from the Workflow tab";

/** The line under a question's title: its summary, else its options. */
export function questionSubline(question: ThreadWorkflowQuestionSummary): string | null {
  if (question.summary) return question.summary;
  const options = question.options ?? [];
  if (options.length === 0) return null;
  return options
    .map((option) => (option.recommended ? `${option.label} (recommended)` : option.label))
    .join(" · ");
}

function AnswerForm({
  question,
  disabled,
  onAnswer,
}: {
  question: ThreadWorkflowQuestionSummary;
  disabled: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [text, setText] = useState("");
  const options = question.options ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      {options.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {options.map((option) => (
            <Button
              key={option.label}
              size="xs"
              variant={option.recommended ? "default" : "outline"}
              disabled={disabled}
              onClick={() => onAnswer(option.label)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const answer = text.trim();
          if (!disabled && answer.length > 0) onAnswer(answer);
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            size="sm"
            aria-label={`Answer to ${question.title}`}
            placeholder={options.length > 0 ? "Or answer in your own words" : "Your answer"}
            value={text}
            maxLength={THREAD_WORKFLOW_LIMITS.answer}
            disabled={disabled}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={disabled || text.trim().length === 0}>
          Answer
        </Button>
      </form>
    </div>
  );
}

function OpenQuestion({
  question,
  blockedStepTitle,
  disabled,
  revealed,
  onAnswer,
}: {
  question: ThreadWorkflowQuestionSummary;
  blockedStepTitle: string | null;
  disabled: boolean;
  revealed: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  if (revealed && !open) setOpen(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus to the answer field once the row renders open; the click that asked for it is in the chat column, before this row may exist.
  useEffect(() => {
    if (!revealed) return;
    rowRef.current?.scrollIntoView({ block: "nearest" });
    rowRef.current?.querySelector("input")?.focus({ preventScroll: true });
    clearThreadWorkflowReveal();
  }, [revealed]);
  const summary = questionSubline(question);
  return (
    <li
      ref={rowRef}
      data-question-id={question.id}
      data-question-state="open"
      className="-mx-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 rounded-lg bg-warning/6 px-2 py-2"
    >
      <MessageCircleQuestionIcon aria-hidden className="mt-1 size-3.5 shrink-0 text-warning" />
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="min-w-0 font-semibold text-sm">{question.title}</span>
          <div className="flex min-w-0 items-start gap-1">
            <span
              className={cn(
                "min-w-0 flex-1 text-muted-foreground text-xs",
                open ? "whitespace-pre-wrap" : "truncate",
              )}
            >
              {summary}
            </span>
            <CollapsibleTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Details for ${question.title}`}
                />
              }
            >
              {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
            </CollapsibleTrigger>
          </div>
          <CollapsiblePanel animate={false}>
            <div className="flex flex-col gap-2 pt-1">
              {question.details ? (
                <p className="whitespace-pre-wrap text-muted-foreground text-xs">
                  {question.details}
                </p>
              ) : null}
              {(question.options ?? []).length > 0 ? (
                <ul className="flex flex-col gap-0.5 text-xs">
                  {(question.options ?? []).map((option) => (
                    <li key={option.label} className="flex items-center gap-1.5">
                      <span>{option.label}</span>
                      {option.recommended ? (
                        <Badge variant="info" size="sm">
                          recommended
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {blockedStepTitle ? (
                <p className="text-muted-foreground text-xs">Waiting on this: {blockedStepTitle}</p>
              ) : null}
              <AnswerForm question={question} disabled={disabled} onAnswer={onAnswer} />
            </div>
          </CollapsiblePanel>
        </div>
      </Collapsible>
    </li>
  );
}

function resolution(question: ThreadWorkflowQuestionSummary): string | null {
  const { state } = question;
  switch (state._tag) {
    case "open":
      return null;
    case "answered":
      return `Answered by ${state.source === "pane" ? "you" : "agent (from chat)"} · ${state.answer}`;
    case "withdrawn":
      return `Withdrawn by ${actorLabel(state.stamp)} · ${state.reason}`;
  }
}

function ResolvedQuestions({
  questions,
  disabled,
  onReopen,
}: {
  questions: ReadonlyArray<ThreadWorkflowQuestionSummary>;
  disabled: boolean;
  onReopen: (question: ThreadWorkflowQuestionSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={<Button size="xs" variant="ghost-muted" aria-label="Answered questions" />}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        Answered ({questions.length})
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        <ol className="flex flex-col gap-1.5 pt-1 ps-6">
          {questions.map((question) => {
            const stamp = question.state._tag === "open" ? null : question.state.stamp;
            return (
              <li
                key={question.id}
                data-question-id={question.id}
                data-question-state={question.state._tag}
                className="flex flex-col gap-0.5"
              >
                <span className="text-muted-foreground text-sm">{question.title}</span>
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 whitespace-pre-wrap">{resolution(question)}</span>
                  {stamp ? (
                    <time className="shrink-0 text-muted-foreground" dateTime={stamp.at}>
                      {formatRelativeTimeLabel(stamp.at)}
                    </time>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={disabled}
                    onClick={() => onReopen(question)}
                  >
                    <Undo2Icon />
                    Reopen
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function ThreadWorkflowQuestions({
  instance,
  disabled,
  revealQuestionId,
  onSubmit,
}: {
  instance: ThreadWorkflowInstanceSummary;
  disabled: boolean;
  revealQuestionId: ThreadWorkflowQuestionId | null;
  onSubmit: (request: ThreadWorkflowRequest) => void;
}) {
  const open = openThreadWorkflowQuestions(instance);
  const resolved = instance.questions.filter((question) => question.state._tag !== "open");
  const stepTitle = (stepId: string | undefined) =>
    stepId === undefined
      ? null
      : (instance.steps.find((step) => step.id === stepId)?.title ?? stepId);
  return (
    <section aria-label="Questions" data-thread-workflow-questions className="flex flex-col gap-1">
      {open.length > 0 ? (
        <ol className="flex flex-col gap-1">
          {open.map((question) => (
            <OpenQuestion
              key={question.id}
              question={question}
              blockedStepTitle={stepTitle(question.blocksStepId)}
              disabled={disabled}
              revealed={question.id === revealQuestionId}
              onAnswer={(answer) =>
                onSubmit({ _tag: "answer", questionId: question.id, answer, source: "pane" })
              }
            />
          ))}
        </ol>
      ) : null}
      {resolved.length > 0 ? (
        <ResolvedQuestions
          questions={resolved}
          disabled={disabled}
          onReopen={(question) =>
            onSubmit({ _tag: "reopen", target: question.id, reason: REOPEN_REASON })
          }
        />
      ) : null}
    </section>
  );
}
