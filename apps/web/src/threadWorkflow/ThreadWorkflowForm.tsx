import type { ThreadWorkflowProofLevel, ThreadWorkflowRequest } from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import {
  buildThreadWorkflowRequest,
  EMPTY_THREAD_WORKFLOW_FORM_VALUES,
  THREAD_WORKFLOW_FIELD_LIMITS,
  THREAD_WORKFLOW_FORM_SPECS,
  type ThreadWorkflowFormField,
  type ThreadWorkflowFormIntent,
  type ThreadWorkflowFormValues,
} from "./threadWorkflowForms";

const FIELD_LABELS: Record<ThreadWorkflowFormField, string> = {
  comment: "Comment",
  reason: "Reason",
  proof: "Proof",
  title: "Title",
  instructions: "Instructions for the agent",
  proofHint: "What counts as proof",
  proofLevel: "Proof wanted",
  waitsForUser: "This step waits for you",
};

const PROOF_LEVELS: ReadonlyArray<ThreadWorkflowProofLevel> = [
  "none",
  "recommended",
  "preferred",
  "required",
];

/**
 * One form for every workflow write. The intent picks the fields and the submit label; the
 * pane places the form under the step or instance it is about. Nothing here resolves a step
 * optimistically: the subscription repaints after the server records the change.
 */
export function ThreadWorkflowForm({
  intent,
  title,
  hint,
  busy,
  onSubmit,
  onCancel,
}: {
  intent: ThreadWorkflowFormIntent;
  title: React.ReactNode;
  hint?: React.ReactNode;
  busy: boolean;
  onSubmit: (request: ThreadWorkflowRequest) => void;
  onCancel: () => void;
}) {
  const spec = THREAD_WORKFLOW_FORM_SPECS[intent.kind];
  const [values, setValues] = useState<ThreadWorkflowFormValues>(EMPTY_THREAD_WORKFLOW_FORM_VALUES);
  const request = buildThreadWorkflowRequest(intent, values);
  const set = <K extends keyof ThreadWorkflowFormValues>(
    field: K,
    value: ThreadWorkflowFormValues[K],
  ) => setValues((current) => ({ ...current, [field]: value }));
  const requirement = (field: ThreadWorkflowFormField) => (
    <Badge variant={spec.required.includes(field) ? "error" : "secondary"} size="sm">
      {spec.required.includes(field) ? "required" : "optional"}
    </Badge>
  );
  const textField = (field: Exclude<ThreadWorkflowFormField, "proofLevel" | "waitsForUser">) => (
    <div key={field} className="flex flex-col gap-1">
      <Label htmlFor={`thread-workflow-${field}`}>
        {FIELD_LABELS[field]}
        {requirement(field)}
      </Label>
      {field === "title" || field === "proofHint" || field === "proof" ? (
        <Input
          id={`thread-workflow-${field}`}
          size="sm"
          value={values[field]}
          maxLength={THREAD_WORKFLOW_FIELD_LIMITS[field]}
          autoFocus={spec.fields[0] === field}
          onChange={(event) => set(field, event.currentTarget.value)}
        />
      ) : (
        <Textarea
          id={`thread-workflow-${field}`}
          size="sm"
          value={values[field]}
          maxLength={THREAD_WORKFLOW_FIELD_LIMITS[field]}
          autoFocus={spec.fields[0] === field}
          onChange={(event) => set(field, event.currentTarget.value)}
        />
      )}
    </div>
  );
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
      data-thread-workflow-form={intent.kind}
      onSubmit={(event) => {
        event.preventDefault();
        if (request !== null && !busy) onSubmit(request);
      }}
    >
      <div className="font-medium text-sm">{title}</div>
      {spec.fields.map((field) => {
        if (field === "proofLevel") {
          return (
            <div key={field} className="flex flex-col gap-1">
              <Label>{FIELD_LABELS[field]}</Label>
              <ToggleGroup
                value={[values.proofLevel]}
                onValueChange={(next) => {
                  const level = next[0];
                  if (PROOF_LEVELS.includes(level as ThreadWorkflowProofLevel)) {
                    set("proofLevel", level as ThreadWorkflowProofLevel);
                  }
                }}
              >
                {PROOF_LEVELS.map((level) => (
                  <Toggle key={level} value={level}>
                    {level}
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>
          );
        }
        if (field === "waitsForUser") {
          return (
            <Label key={field}>
              <Checkbox
                checked={values.waitsForUser}
                onCheckedChange={(checked) => set("waitsForUser", checked === true)}
              />
              {FIELD_LABELS[field]}
            </Label>
          );
        }
        return textField(field);
      })}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {hint ? <span className="me-auto text-muted-foreground text-xs">{hint}</span> : null}
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          variant={
            spec.tone === "destructive"
              ? "destructive"
              : spec.tone === "warning"
                ? "warning-outline"
                : "default"
          }
          disabled={request === null || busy}
        >
          {spec.submit}
        </Button>
      </div>
    </form>
  );
}
