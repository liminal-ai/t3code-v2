import type {
  ThreadWorkflowInstanceStatus,
  ThreadWorkflowStamp,
  ThreadWorkflowStepSummary,
} from "@t3tools/contracts";
import {
  CheckIcon,
  CornerDownRightIcon,
  HandIcon,
  MessageSquareIcon,
  MinusIcon,
  SkipForwardIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { ThreadWorkflowFormIntent } from "./threadWorkflowForms";

export function actorLabel(stamp: Pick<ThreadWorkflowStamp, "by">): string {
  return stamp.by._tag === "user" ? "you" : "agent";
}

export function StampLabel({ stamp }: { stamp: ThreadWorkflowStamp }) {
  return (
    <span className="whitespace-nowrap text-muted-foreground text-xs">
      {actorLabel(stamp)} · <time dateTime={stamp.at}>{formatRelativeTimeLabel(stamp.at)}</time>
    </span>
  );
}

export function StepStateIcon({
  step,
  current,
}: {
  step: Pick<ThreadWorkflowStepSummary, "state" | "waitsForUser">;
  current: boolean;
}) {
  const tag = step.state._tag;
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4.5 shrink-0 items-center justify-center rounded-full border",
        tag === "done" && "border-success bg-success text-white",
        tag === "skipped" && "border-warning text-warning",
        tag === "removed" && "border-border text-muted-foreground",
        tag === "open" && current && "border-info bg-info/16 text-info",
        tag === "open" && !current && step.waitsForUser && "border-info/60 text-info",
        tag === "open" && !current && !step.waitsForUser && "border-border",
      )}
    >
      {tag === "done" ? <CheckIcon className="size-3" /> : null}
      {tag === "skipped" ? <SkipForwardIcon className="size-2.5" /> : null}
      {tag === "removed" ? <MinusIcon className="size-2.5" /> : null}
      {tag === "open" && step.waitsForUser ? <HandIcon className="size-2.5" /> : null}
      {tag === "open" && !step.waitsForUser && current ? (
        <span className="size-1.5 rounded-full bg-current" />
      ) : null}
    </span>
  );
}

export function StepStateMeta({
  step,
  current,
}: {
  step: ThreadWorkflowStepSummary;
  current: boolean;
}) {
  const { state } = step;
  switch (state._tag) {
    case "done":
      return <StampLabel stamp={state.stamp} />;
    case "skipped":
      return (
        <span className="flex items-center gap-1.5">
          <Badge variant="warning" size="sm">
            skipped
          </Badge>
          <StampLabel stamp={state.stamp} />
        </span>
      );
    case "removed":
      return (
        <span className="flex items-center gap-1.5">
          <Badge variant="outline" size="sm">
            removed
          </Badge>
          <StampLabel stamp={state.stamp} />
        </span>
      );
    case "open":
      return (
        <span className="flex items-center gap-1.5">
          {step.waitsForUser ? (
            <Badge variant="info" size="sm">
              waits for you
            </Badge>
          ) : null}
          {step.origin._tag === "inserted" ? (
            <Badge variant="outline" size="sm">
              inserted
            </Badge>
          ) : null}
          {current ? (
            <Badge variant="info" size="sm">
              current
            </Badge>
          ) : step.waitsForUser || step.origin._tag === "inserted" ? null : (
            <span className="text-muted-foreground text-xs">pending</span>
          )}
        </span>
      );
  }
}

const PROOF_LABEL: Record<ThreadWorkflowStepSummary["proofLevel"], string> = {
  none: "",
  recommended: "recommended",
  preferred: "preferred",
  required: "required",
};

/** Advisory: the level shapes the note and this badge, never whether a tick is accepted. */
export function ProofWanted({ step }: { step: ThreadWorkflowStepSummary }) {
  if (step.proofLevel === "none") return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Proof</span>
      <Badge
        variant={
          step.proofLevel === "required"
            ? "error"
            : step.proofLevel === "preferred"
              ? "warning"
              : "secondary"
        }
        size="sm"
      >
        {PROOF_LABEL[step.proofLevel]}
      </Badge>
      {step.proofHint ? <span className="text-foreground/80">{step.proofHint}</span> : null}
    </div>
  );
}

export function StepResolution({ step }: { step: ThreadWorkflowStepSummary }) {
  const { state } = step;
  if (state._tag === "open") return null;
  if (state._tag === "done") {
    if (state.comment === null && state.proof === null) return null;
    return (
      <div className="flex flex-col gap-1 border-border border-s-2 ps-2 text-sm">
        {state.comment ? <p className="whitespace-pre-wrap">{state.comment}</p> : null}
        {state.proof ? (
          <code className="wrap-anywhere text-muted-foreground text-xs">{state.proof}</code>
        ) : null}
      </div>
    );
  }
  return (
    <p className="text-muted-foreground text-sm">
      Reason: <span className="italic">{state.reason}</span>
    </p>
  );
}

/**
 * The transitions the server allows for this step, as buttons. Tick from open or skipped, skip
 * from open, remove from open or skipped, reopen from any resolved state, comment always, insert
 * after any step while the instance is open.
 */
export function StepActions({
  step,
  instanceStatus,
  disabled,
  size = "xs",
  onOpenForm,
}: {
  step: ThreadWorkflowStepSummary;
  instanceStatus: ThreadWorkflowInstanceStatus;
  disabled: boolean;
  size?: "xs" | "sm";
  onOpenForm: (intent: ThreadWorkflowFormIntent) => void;
}) {
  const open = instanceStatus._tag === "open";
  const tag = step.state._tag;
  const button = (
    intent: ThreadWorkflowFormIntent,
    label: string,
    icon: React.ReactNode,
    variant: "default" | "outline" | "ghost-destructive" = "outline",
  ) => (
    <Button
      key={intent.kind}
      size={size}
      variant={variant}
      disabled={disabled}
      aria-label={label}
      onClick={() => onOpenForm(intent)}
    >
      {icon}
      {variant === "ghost-destructive" ? null : label}
    </Button>
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {open && (tag === "open" || tag === "skipped")
        ? button(
            { kind: "tick", stepId: step.id },
            step.waitsForUser ? "Tick gate" : "Tick with comment",
            <CheckIcon />,
            "default",
          )
        : null}
      {open && tag === "open"
        ? button({ kind: "skip", stepId: step.id }, "Skip…", <SkipForwardIcon />)
        : null}
      {button({ kind: "comment", target: step.id }, "Comment", <MessageSquareIcon />)}
      {open
        ? button({ kind: "insert", after: step.id }, "Insert after", <CornerDownRightIcon />)
        : null}
      {open && tag !== "open"
        ? button(
            { kind: "reopen", target: step.id },
            tag === "skipped" ? "Unskip" : "Reopen",
            <Undo2Icon />,
          )
        : null}
      {open && (tag === "open" || tag === "skipped")
        ? button(
            { kind: "remove", stepId: step.id },
            "Remove step…",
            <Trash2Icon />,
            "ghost-destructive",
          )
        : null}
    </div>
  );
}
