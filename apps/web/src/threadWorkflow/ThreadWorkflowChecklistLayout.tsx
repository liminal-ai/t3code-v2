import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";
import type { ThreadWorkflowLayoutProps } from "./ThreadWorkflowPanel";
import {
  ProofWanted,
  StepActions,
  StepResolution,
  StepStateIcon,
  StepStateMeta,
} from "./ThreadWorkflowStepParts";

/**
 * Layout A: one checklist. Every step is a row; the current step is expanded with its
 * instructions and actions, the others fold their details. Arranges shared pieces only.
 */
export function ThreadWorkflowChecklistLayout(props: ThreadWorkflowLayoutProps) {
  const { instance, stepNumbers, formStepId, disabled, onOpenForm, renderForm } = props;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [activityOpen, setActivityOpen] = useState(false);
  const currentRow = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    currentRow.current?.scrollIntoView({ block: "center" });
  }, []);
  const toggle = (stepId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  return (
    <div className="flex flex-col gap-3">
      {props.header}
      {props.instanceForm}
      <ol className="flex flex-col">
        {instance.steps.map((step) => {
          const current = step.id === instance.currentStepId;
          const number = stepNumbers.get(step.id);
          const removed = step.state._tag === "removed";
          const open = current || expanded.has(step.id);
          const actions = (
            <StepActions
              step={step}
              instanceStatus={instance.status}
              disabled={disabled}
              size={current ? "sm" : "xs"}
              onOpenForm={onOpenForm}
            />
          );
          return (
            <li
              key={step.id}
              ref={current ? currentRow : undefined}
              data-step-id={step.id}
              className={cn(
                "grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 py-2",
                current && "-mx-2 rounded-lg border border-info/40 bg-info/4 px-2",
              )}
            >
              <div className="flex flex-col items-center pt-0.5">
                <StepStateIcon step={step} current={current} />
                <span className="mt-1 w-px flex-1 bg-border" aria-hidden />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-start gap-2">
                  <span className="w-4 shrink-0 text-end text-muted-foreground text-xs tabular-nums">
                    {number ?? ""}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-sm",
                      current && "font-semibold",
                      removed && "text-muted-foreground line-through",
                    )}
                  >
                    {step.title}
                  </span>
                  <span className="shrink-0">
                    <StepStateMeta step={step} current={current} />
                  </span>
                </div>
                <div className="ps-6">
                  <StepResolution step={step} />
                </div>
                {current ? (
                  <div className="flex flex-col gap-2 ps-6">
                    <p className="whitespace-pre-wrap text-sm">{step.instructions}</p>
                    <ProofWanted step={step} />
                    {actions}
                  </div>
                ) : (
                  <Collapsible open={open} onOpenChange={() => toggle(step.id)}>
                    <div className="ps-6">
                      <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
                        {open ? (
                          <ChevronDownIcon className="size-3" />
                        ) : (
                          <ChevronRightIcon className="size-3" />
                        )}
                        details
                      </CollapsibleTrigger>
                    </div>
                    <CollapsiblePanel>
                      <div className="flex flex-col gap-2 ps-6 pt-1.5">
                        <p className="whitespace-pre-wrap text-muted-foreground text-sm">
                          {step.instructions}
                        </p>
                        <ProofWanted step={step} />
                        {actions}
                      </div>
                    </CollapsiblePanel>
                  </Collapsible>
                )}
                {formStepId === step.id ? <div className="ps-6">{renderForm()}</div> : null}
              </div>
            </li>
          );
        })}
      </ol>
      {props.renderActivity(activityOpen, setActivityOpen)}
    </div>
  );
}
