import { threadWorkflowProgress } from "@t3tools/client-runtime/state/thread-workflow";
import type { ThreadWorkflowStepId } from "@t3tools/contracts";
import { Undo2Icon } from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { threadWorkflowFormStepId, type ThreadWorkflowFormIntent } from "./threadWorkflowForms";
import type { ThreadWorkflowLayoutProps } from "./ThreadWorkflowPanel";
import {
  ProofWanted,
  StepActions,
  StepResolution,
  StepStateIcon,
  StepStateMeta,
} from "./ThreadWorkflowStepParts";

type Subtab = "now" | "workflows" | "activity";

const STATE_BAR_CLASS = {
  done: "bg-success",
  skipped: "bg-warning",
  open: "bg-border",
  current: "bg-info",
} as const;

/**
 * Layout B: a focus card for one step above a compact rail of every step. The card shows the
 * current step until a rail row is picked. Arranges shared pieces only.
 */
export function ThreadWorkflowFocusLayout(props: ThreadWorkflowLayoutProps) {
  const { instance, view, stepNumbers, formStepId, disabled, renderForm } = props;
  const [subtab, setSubtab] = useState<Subtab>("now");
  const [selectedStepId, setSelectedStepId] = useState<ThreadWorkflowStepId | null>(null);
  const progress = threadWorkflowProgress(instance.steps);
  const current = instance.steps.find((step) => step.id === instance.currentStepId) ?? null;
  const selected =
    instance.steps.find((step) => step.id === selectedStepId) ?? current ?? instance.steps.at(-1);
  const showingCurrent = selected !== undefined && selected.id === current?.id;
  const onOpenForm = (intent: ThreadWorkflowFormIntent) => {
    const stepId = threadWorkflowFormStepId(intent);
    if (stepId !== null) setSelectedStepId(stepId);
    setSubtab("now");
    props.onOpenForm(intent);
  };
  const tabs = (
    <div role="tablist" className="flex items-center gap-1 border-border border-b">
      {(
        [
          ["now", "Now", null],
          ["workflows", "Workflows", view.instances.length],
          ["activity", "Activity", null],
        ] as const
      ).map(([id, label, count]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={subtab === id}
          onClick={() => setSubtab(id)}
          className={cn(
            "-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 px-2 py-1.5 text-sm",
            subtab === id
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
          {count === null ? null : (
            <Badge variant="secondary" size="sm">
              {count}
            </Badge>
          )}
        </button>
      ))}
    </div>
  );
  if (subtab === "workflows") {
    return (
      <div className="flex flex-col gap-3">
        {tabs}
        {props.instanceList}
      </div>
    );
  }
  if (subtab === "activity") {
    return (
      <div className="flex flex-col gap-3">
        {tabs}
        {props.renderActivity(true, () => setSubtab("now"))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {tabs}
      {selected === undefined ? null : (
        <section
          className={cn(
            "flex flex-col gap-2 rounded-xl border p-3",
            showingCurrent ? "border-info/50 bg-info/4" : "border-border bg-card",
          )}
          data-step-id={selected.id}
        >
          <div className="flex items-center gap-2 text-xs">
            {showingCurrent ? (
              <>
                <span className="size-1.5 rounded-full bg-info" aria-hidden />
                <span className="font-semibold text-info uppercase tracking-wide">
                  Now · step {stepNumbers.get(selected.id)} of {progress.live}
                </span>
              </>
            ) : (
              <>
                <StepStateIcon step={selected} current={false} />
                <span className="font-semibold text-muted-foreground uppercase tracking-wide">
                  {selected.state._tag === "removed"
                    ? "Removed step"
                    : `Step ${stepNumbers.get(selected.id)}`}{" "}
                  · {selected.state._tag}
                </span>
              </>
            )}
            <span className="ms-auto">
              {showingCurrent ? (
                <StepStateMeta step={selected} current={false} />
              ) : current === null ? null : (
                <Button size="xs" variant="ghost" onClick={() => setSelectedStepId(null)}>
                  <Undo2Icon />
                  Back to now
                </Button>
              )}
            </span>
          </div>
          <h2
            className={cn(
              "font-semibold text-base",
              selected.state._tag === "removed" && "text-muted-foreground line-through",
            )}
          >
            {selected.title}
          </h2>
          <p
            className={cn(
              "whitespace-pre-wrap text-sm",
              selected.state._tag !== "open" && "text-muted-foreground",
            )}
          >
            {selected.instructions}
          </p>
          <ProofWanted step={selected} />
          <StepResolution step={selected} />
          <StepActions
            step={selected}
            instanceStatus={instance.status}
            disabled={disabled}
            size="sm"
            onOpenForm={onOpenForm}
          />
          {formStepId === selected.id ? renderForm() : null}
        </section>
      )}
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-muted-foreground uppercase tracking-wide">
          Steps · {progress.resolved} of {progress.live}
        </span>
        <span className="ms-auto text-muted-foreground">
          {progress.skipped} skipped · {progress.inserted} inserted · {progress.removed} removed
        </span>
      </div>
      <div className="flex gap-0.5" aria-hidden>
        {instance.steps
          .filter((step) => step.state._tag !== "removed")
          .map((step) => (
            <span
              key={step.id}
              className={cn(
                "h-1 flex-1 rounded-full",
                STATE_BAR_CLASS[
                  step.state._tag === "open"
                    ? step.id === current?.id
                      ? "current"
                      : "open"
                    : step.state._tag === "done"
                      ? "done"
                      : "skipped"
                ],
              )}
            />
          ))}
      </div>
      <ol className="flex flex-col">
        {instance.steps.map((step) => {
          const isCurrent = step.id === current?.id;
          const picked = step.id === selected?.id && !showingCurrent;
          return (
            <li key={step.id}>
              <button
                type="button"
                data-step-id={step.id}
                onClick={() => setSelectedStepId(isCurrent ? null : step.id)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-start text-sm hover:bg-accent/60",
                  (picked || (isCurrent && showingCurrent)) && "bg-accent",
                )}
              >
                <StepStateIcon step={step} current={isCurrent} />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    step.state._tag === "removed" && "text-muted-foreground line-through",
                    step.state._tag === "done" && "text-muted-foreground",
                  )}
                >
                  {step.title}
                  {step.state._tag === "skipped" || step.state._tag === "removed" ? (
                    <span className="text-muted-foreground"> · {step.state.reason}</span>
                  ) : null}
                </span>
                <span className="shrink-0">
                  <StepStateMeta step={step} current={isCurrent} />
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
