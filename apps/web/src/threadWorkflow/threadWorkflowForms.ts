import {
  THREAD_WORKFLOW_LIMITS,
  type ThreadWorkflowInstanceId,
  type ThreadWorkflowOutcome,
  type ThreadWorkflowProofLevel,
  type ThreadWorkflowRequest,
  type ThreadWorkflowStepId,
  type ThreadWorkflowTarget,
} from "@t3tools/contracts";

/**
 * What the open form is for. One intent builds one request; the table below says which fields it
 * asks. Done is not here: it is one click on the current step with an optional note, no form.
 */
export type ThreadWorkflowFormIntent =
  | { readonly kind: "skip"; readonly stepId: ThreadWorkflowStepId }
  | { readonly kind: "remove"; readonly stepId: ThreadWorkflowStepId }
  | { readonly kind: "reopen"; readonly target: ThreadWorkflowTarget }
  | { readonly kind: "comment"; readonly target: ThreadWorkflowTarget }
  | { readonly kind: "insert"; readonly after: ThreadWorkflowStepId | "top" | "end" }
  | {
      readonly kind: "close";
      readonly instanceId: ThreadWorkflowInstanceId;
      readonly outcome: ThreadWorkflowOutcome;
    }
  | { readonly kind: "recover" };

export type ThreadWorkflowFormField =
  | "comment"
  | "reason"
  | "proof"
  | "title"
  | "instructions"
  | "proofHint"
  | "proofLevel"
  | "waitsForUser";

export interface ThreadWorkflowFormValues {
  readonly comment: string;
  readonly reason: string;
  readonly proof: string;
  readonly title: string;
  readonly instructions: string;
  readonly proofHint: string;
  readonly proofLevel: ThreadWorkflowProofLevel;
  readonly waitsForUser: boolean;
}

export const EMPTY_THREAD_WORKFLOW_FORM_VALUES: ThreadWorkflowFormValues = {
  comment: "",
  reason: "",
  proof: "",
  title: "",
  instructions: "",
  proofHint: "",
  proofLevel: "recommended",
  waitsForUser: false,
};

export interface ThreadWorkflowFormSpec {
  readonly fields: ReadonlyArray<ThreadWorkflowFormField>;
  readonly required: ReadonlyArray<ThreadWorkflowFormField>;
  readonly submit: string;
  readonly tone: "default" | "warning" | "destructive";
}

export const THREAD_WORKFLOW_FORM_SPECS: Record<
  ThreadWorkflowFormIntent["kind"],
  ThreadWorkflowFormSpec
> = {
  skip: { fields: ["reason"], required: ["reason"], submit: "Skip step", tone: "warning" },
  remove: { fields: ["reason"], required: ["reason"], submit: "Remove step", tone: "destructive" },
  reopen: { fields: ["reason"], required: ["reason"], submit: "Reopen", tone: "default" },
  comment: {
    fields: ["comment", "proof"],
    required: ["comment"],
    submit: "Comment",
    tone: "default",
  },
  insert: {
    fields: ["title", "instructions", "proofLevel", "proofHint", "waitsForUser", "reason"],
    required: ["title", "instructions", "reason"],
    submit: "Add step",
    tone: "default",
  },
  close: { fields: ["reason"], required: ["reason"], submit: "Close workflow", tone: "default" },
  recover: { fields: ["reason"], required: ["reason"], submit: "Recover", tone: "destructive" },
};

export const THREAD_WORKFLOW_FIELD_LIMITS: Record<
  Exclude<ThreadWorkflowFormField, "proofLevel" | "waitsForUser">,
  number
> = {
  comment: 4_000,
  reason: 2_000,
  proof: 2_000,
  title: THREAD_WORKFLOW_LIMITS.stepTitle,
  instructions: THREAD_WORKFLOW_LIMITS.instructions,
  proofHint: THREAD_WORKFLOW_LIMITS.proofHint,
};

const text = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

/** Null while a required field is empty, so the submit button can follow it. */
export function buildThreadWorkflowRequest(
  intent: ThreadWorkflowFormIntent,
  values: ThreadWorkflowFormValues,
): ThreadWorkflowRequest | null {
  const spec = THREAD_WORKFLOW_FORM_SPECS[intent.kind];
  for (const field of spec.required) {
    if (field === "proofLevel" || field === "waitsForUser") continue;
    if (text(values[field]) === undefined) return null;
  }
  const comment = text(values.comment);
  const proof = text(values.proof);
  const reason = text(values.reason) ?? "";
  switch (intent.kind) {
    case "skip":
      return { _tag: "skip", stepId: intent.stepId, reason };
    case "remove":
      return { _tag: "remove", stepId: intent.stepId, reason };
    case "reopen":
      return { _tag: "reopen", target: intent.target, reason };
    case "comment":
      return {
        _tag: "comment",
        target: intent.target,
        comment: comment ?? "",
        ...(proof === undefined ? {} : { proof }),
      };
    case "insert": {
      const proofHint = text(values.proofHint);
      return {
        _tag: "insert",
        ...(intent.after === "end"
          ? {}
          : { afterStepId: intent.after === "top" ? null : intent.after }),
        step: {
          title: text(values.title) ?? "",
          instructions: text(values.instructions) ?? "",
          proofLevel: values.proofLevel,
          ...(proofHint === undefined ? {} : { proofHint }),
          waitsForUser: values.waitsForUser,
        },
        reason,
      };
    }
    case "close":
      return { _tag: "close", instanceId: intent.instanceId, outcome: intent.outcome, reason };
    case "recover":
      return { _tag: "recover", reason };
  }
}

/** The step a form belongs to, so a layout can place it under that step. */
export function threadWorkflowFormStepId(
  intent: ThreadWorkflowFormIntent | null,
): ThreadWorkflowStepId | null {
  if (intent === null) return null;
  switch (intent.kind) {
    case "skip":
    case "remove":
      return intent.stepId;
    case "reopen":
    case "comment":
      return intent.target.includes(".") ? (intent.target as ThreadWorkflowStepId) : null;
    case "insert":
      return intent.after === "top" || intent.after === "end" ? null : intent.after;
    case "close":
    case "recover":
      return null;
  }
}
