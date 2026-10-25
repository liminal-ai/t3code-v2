import {
  threadWorkflowStepPhase,
  threadWorkflowStepResult,
  type ThreadWorkflowStepPhase,
} from "@t3tools/client-runtime/state/thread-workflow";
import type {
  ThreadWorkflowInstanceSummary,
  ThreadWorkflowStamp,
  ThreadWorkflowStepId,
  ThreadWorkflowStepSummary,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  SkipForwardIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { THREAD_WORKFLOW_FIELD_LIMITS, type ThreadWorkflowFormIntent } from "./threadWorkflowForms";

export function actorLabel(stamp: Pick<ThreadWorkflowStamp, "by">): string {
  return stamp.by._tag === "user" ? "you" : "agent";
}

function Stamp({ verb, stamp }: { verb: string; stamp: ThreadWorkflowStamp }) {
  return (
    <span>
      {verb} by {actorLabel(stamp)} ·{" "}
      <time dateTime={stamp.at}>{formatRelativeTimeLabel(stamp.at)}</time>
    </span>
  );
}

const DOT_CLASS: Record<ThreadWorkflowStepPhase, string> = {
  done: "border-success bg-success text-white",
  current: "border-info ring-[3px] ring-info/20",
  upcoming: "border-border",
  skipped: "border-border bg-muted",
  removed: "border-border/60",
};

function StepDot({ phase }: { phase: ThreadWorkflowStepPhase }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-full border-2",
        DOT_CLASS[phase],
      )}
    >
      {phase === "done" ? <CheckIcon className="size-2.5" strokeWidth={3} /> : null}
    </span>
  );
}

const PROOF_WORDS: Record<ThreadWorkflowStepSummary["proofLevel"], string | null> = {
  none: null,
  recommended: "Proof recommended",
  preferred: "Proof preferred",
  required: "Proof required",
};

/** Agent-facing detail and the record of who did what, folded away so the arc reads at a glance. */
function StepDetails({
  step,
  phase,
}: {
  step: ThreadWorkflowStepSummary;
  phase: ThreadWorkflowStepPhase;
}) {
  const { state } = step;
  const proof = PROOF_WORDS[step.proofLevel];
  return (
    <div className="flex flex-col gap-1.5 text-muted-foreground text-xs">
      <p className="whitespace-pre-wrap">{step.instructions}</p>
      {proof ? (
        <p>
          {proof}
          {step.proofHint ? `: ${step.proofHint}` : ""}
        </p>
      ) : null}
      {state._tag === "done" ? (
        <>
          {state.comment ? (
            <p className="whitespace-pre-wrap text-foreground/80">{state.comment}</p>
          ) : null}
          {state.proof ? <code className="wrap-anywhere">{state.proof}</code> : null}
          <Stamp verb="Done" stamp={state.stamp} />
        </>
      ) : null}
      {state._tag === "skipped" ? <Stamp verb="Skipped" stamp={state.stamp} /> : null}
      {state._tag === "removed" ? <Stamp verb="Removed" stamp={state.stamp} /> : null}
      {step.origin._tag === "inserted" ? (
        <p>
          <Stamp verb="Added" stamp={step.origin.stamp} /> · {step.origin.reason}
        </p>
      ) : null}
      {phase === "current" && step.waitsForUser ? (
        <p>This step ends with your call. The agent asks when it is ready.</p>
      ) : null}
    </div>
  );
}

/**
 * The step changes that need a reason or more fields, by phase. Done and Undo are not here: they
 * are one click on the row. Only comments stay available once the workflow is closed.
 */
function StepMenu({
  step,
  phase,
  instanceOpen,
  disabled,
  onOpenForm,
}: {
  step: ThreadWorkflowStepSummary;
  phase: ThreadWorkflowStepPhase;
  instanceOpen: boolean;
  disabled: boolean;
  onOpenForm: (intent: ThreadWorkflowFormIntent) => void;
}) {
  const item = (intent: ThreadWorkflowFormIntent, label: string, icon: ReactNode) => (
    <MenuItem key={intent.kind} onClick={() => onOpenForm(intent)}>
      {icon}
      {label}
    </MenuItem>
  );
  const comment = item({ kind: "comment", target: step.id }, "Comment…", <MessageSquareIcon />);
  const insertAfter = item(
    { kind: "insert", after: step.id },
    "Add a step after…",
    <CornerDownRightIcon />,
  );
  const remove = (
    <MenuItem variant="destructive" onClick={() => onOpenForm({ kind: "remove", stepId: step.id })}>
      <Trash2Icon />
      Remove…
    </MenuItem>
  );
  let items: ReactNode;
  if (!instanceOpen) {
    items = comment;
  } else {
    switch (phase) {
      case "current":
      case "upcoming":
        items = (
          <>
            {item({ kind: "skip", stepId: step.id }, "Skip…", <SkipForwardIcon />)}
            {comment}
            {insertAfter}
            {remove}
          </>
        );
        break;
      case "done":
        items = (
          <>
            {item({ kind: "reopen", target: step.id }, "Reopen…", <Undo2Icon />)}
            {comment}
            {insertAfter}
          </>
        );
        break;
      case "skipped":
        items = (
          <>
            {item({ kind: "reopen", target: step.id }, "Unskip…", <Undo2Icon />)}
            {comment}
            {insertAfter}
            {remove}
          </>
        );
        break;
      case "removed":
        items = (
          <>
            {item({ kind: "reopen", target: step.id }, "Restore…", <Undo2Icon />)}
            {comment}
          </>
        );
        break;
    }
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={disabled}
            aria-label={`More for ${step.title}`}
          />
        }
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end">{items}</MenuPopup>
    </Menu>
  );
}

/** One click marks the current step done. The note is optional; Enter in it submits too. */
function DoneControls({
  step,
  disabled,
  onDone,
}: {
  step: ThreadWorkflowStepSummary;
  disabled: boolean;
  onDone: (stepId: ThreadWorkflowStepId, note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onDone(step.id, note);
      }}
    >
      <Button type="submit" size="sm" disabled={disabled}>
        <CheckIcon />
        Done
      </Button>
      <div className="min-w-0 flex-1">
        <Input
          size="sm"
          aria-label="Note"
          placeholder="Note (optional)"
          value={note}
          maxLength={THREAD_WORKFLOW_FIELD_LIMITS.comment}
          disabled={disabled}
          onChange={(event) => setNote(event.currentTarget.value)}
        />
      </div>
    </form>
  );
}

function YourCall() {
  return (
    <span className="ms-2 whitespace-nowrap text-warning-foreground/80 text-xs">your call</span>
  );
}

const TITLE_CLASS: Record<ThreadWorkflowStepPhase, string> = {
  done: "text-muted-foreground",
  current: "font-semibold",
  upcoming: "",
  skipped: "text-muted-foreground",
  removed: "text-muted-foreground line-through",
};

function StepRow({
  step,
  phase,
  instanceOpen,
  disabled,
  undoable,
  form,
  onOpenForm,
  onDone,
  onUndo,
}: {
  step: ThreadWorkflowStepSummary;
  phase: ThreadWorkflowStepPhase;
  instanceOpen: boolean;
  disabled: boolean;
  undoable: boolean;
  form: ReactNode;
  onOpenForm: (intent: ThreadWorkflowFormIntent) => void;
  onDone: (stepId: ThreadWorkflowStepId, note: string) => void;
  onUndo: (stepId: ThreadWorkflowStepId) => void;
}) {
  const [open, setOpen] = useState(false);
  const result = threadWorkflowStepResult(step);
  return (
    <li
      data-step-id={step.id}
      data-step-phase={phase}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 py-1.5",
        phase === "current" && "-mx-2 rounded-lg bg-info/4 px-2 py-2",
      )}
    >
      <StepDot phase={phase} />
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-start gap-1">
            <span className={cn("min-w-0 flex-1 text-sm", TITLE_CLASS[phase])}>
              {step.title}
              {step.waitsForUser && (phase === "current" || phase === "upcoming") ? (
                <YourCall />
              ) : null}
            </span>
            <CollapsibleTrigger
              render={<Button size="icon-xs" variant="ghost-muted" aria-label="Details" />}
            >
              {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
            </CollapsibleTrigger>
            <StepMenu
              step={step}
              phase={phase}
              instanceOpen={instanceOpen}
              disabled={disabled}
              onOpenForm={onOpenForm}
            />
          </div>
          {result ? (
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
              <span className="min-w-0 truncate">
                {phase === "skipped" ? "Skipped · " : phase === "removed" ? "Removed · " : ""}
                {result}
              </span>
              {undoable ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled}
                  onClick={() => onUndo(step.id)}
                >
                  <Undo2Icon />
                  Undo
                </Button>
              ) : null}
            </div>
          ) : undoable ? (
            <div>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={disabled}
                onClick={() => onUndo(step.id)}
              >
                <Undo2Icon />
                Undo
              </Button>
            </div>
          ) : null}
          {phase === "current" && instanceOpen ? (
            <DoneControls step={step} disabled={disabled} onDone={onDone} />
          ) : null}
          <CollapsiblePanel>
            <div className="pt-1">
              <StepDetails step={step} phase={phase} />
            </div>
          </CollapsiblePanel>
          {form}
        </div>
      </Collapsible>
    </li>
  );
}

/**
 * The whole arc in one list: done steps with their result, the current step with Done, upcoming
 * steps as titles. Skipped and removed steps stay in order, muted.
 */
export function ThreadWorkflowStepList({
  instance,
  disabled,
  undoStepId,
  formStepId,
  renderForm,
  onOpenForm,
  onDone,
  onUndo,
}: {
  instance: ThreadWorkflowInstanceSummary;
  disabled: boolean;
  /** The step the user just marked done here, which shows Undo until the next change. */
  undoStepId: ThreadWorkflowStepId | null;
  formStepId: ThreadWorkflowStepId | null;
  renderForm: () => ReactNode;
  onOpenForm: (intent: ThreadWorkflowFormIntent) => void;
  onDone: (stepId: ThreadWorkflowStepId, note: string) => void;
  onUndo: (stepId: ThreadWorkflowStepId) => void;
}) {
  const instanceOpen = instance.status._tag === "open";
  return (
    <ol className="flex flex-col">
      {instance.steps.map((step) => {
        const phase = threadWorkflowStepPhase(step, instance);
        return (
          <StepRow
            key={step.id}
            step={step}
            phase={phase}
            instanceOpen={instanceOpen}
            disabled={disabled}
            undoable={instanceOpen && phase === "done" && step.id === undoStepId}
            form={formStepId === step.id ? <div className="pt-1">{renderForm()}</div> : null}
            onOpenForm={onOpenForm}
            onDone={onDone}
            onUndo={onUndo}
          />
        );
      })}
    </ol>
  );
}
