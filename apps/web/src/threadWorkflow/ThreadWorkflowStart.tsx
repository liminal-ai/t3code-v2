import type {
  EnvironmentId,
  ThreadWorkflowTemplateId,
  ThreadWorkflowTemplateSummary,
} from "@t3tools/contracts";
import { ListChecksIcon, PlayIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useEnvironmentQuery } from "~/state/query";
import { threadWorkflowEnvironment } from "~/state/threadWorkflow";

function FreshnessBadge({ freshness }: { freshness: ThreadWorkflowTemplateSummary["freshness"] }) {
  switch (freshness) {
    case "fresh":
      return null;
    case "no-source":
      return (
        <Badge variant="outline" size="sm">
          no playbook
        </Badge>
      );
    case "stale":
      return (
        <Badge variant="warning" size="sm">
          <TriangleAlertIcon />
          playbook changed
        </Badge>
      );
    case "source-missing":
      return (
        <Badge variant="warning" size="sm">
          <TriangleAlertIcon />
          playbook missing
        </Badge>
      );
  }
}

/** Shown while no instance is open: pick a template and start. Flag off means no new instances. */
export function ThreadWorkflowStart({
  environmentId,
  enabled,
  disabled,
  onStart,
}: {
  environmentId: EnvironmentId;
  enabled: boolean;
  disabled: boolean;
  onStart: (templateId: ThreadWorkflowTemplateId) => void;
}) {
  const templates = useEnvironmentQuery(
    enabled ? threadWorkflowEnvironment.templates({ environmentId, input: {} }) : null,
  );
  if (!enabled) {
    return (
      <Alert>
        <ListChecksIcon />
        <AlertTitle>Thread workflows are off on this server</AlertTitle>
        <AlertDescription>
          No new workflow can start here. Turn on threadWorkflowsEnabled in the server's
          settings.json to start one.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-semibold text-sm">Start a workflow</h2>
        <p className="text-muted-foreground text-xs">
          The agent gets the current step at the start of every turn. The thread cannot settle while
          a workflow is open.
        </p>
      </div>
      {templates.error ? (
        <Alert variant="error">
          <TriangleAlertIcon />
          <AlertTitle>Could not load templates</AlertTitle>
          <AlertDescription>{templates.error}</AlertDescription>
        </Alert>
      ) : null}
      {templates.data === null && templates.error === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}
      {(templates.data ?? []).map((template) => (
        <article
          key={template.id}
          className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{template.title}</span>
            <FreshnessBadge freshness={template.freshness} />
            <span className="ms-auto text-muted-foreground text-xs">
              {template.stepCount} steps · v{template.version}
            </span>
          </div>
          <p className="text-muted-foreground text-xs">{template.description}</p>
          <div>
            <Button size="xs" disabled={disabled} onClick={() => onStart(template.id)}>
              <PlayIcon />
              Start
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}
