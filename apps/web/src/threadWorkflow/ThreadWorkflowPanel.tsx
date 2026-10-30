import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";
import {
  activeThreadWorkflowInstance,
  deriveThreadWorkflowAsks,
} from "@t3tools/client-runtime/state/thread-workflow";
import type {
  ScopedThreadRef,
  ThreadWorkflowInstanceId,
  ThreadWorkflowInstanceSummary,
  ThreadWorkflowRequest,
  ThreadWorkflowStepId,
} from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Skeleton } from "~/components/ui/skeleton";
import { useEnvironmentQuery } from "~/state/query";
import { threadWorkflowStateAtom } from "~/state/threadWorkflow";
import { ThreadWorkflowActivity } from "./ThreadWorkflowActivity";
import { ThreadWorkflowForm } from "./ThreadWorkflowForm";
import { threadWorkflowFormStepId, type ThreadWorkflowFormIntent } from "./threadWorkflowForms";
import { ThreadWorkflowHeader, ThreadWorkflowInstanceList } from "./ThreadWorkflowHeader";
import { ThreadWorkflowQuestions } from "./ThreadWorkflowQuestions";
import { usePendingThreadWorkflowReveal } from "./threadWorkflowQuestionReveal";
import { ThreadWorkflowStart } from "./ThreadWorkflowStart";
import { ThreadWorkflowStepList } from "./ThreadWorkflowStepList";
import { ThreadWorkflowStrip } from "./ThreadWorkflowStrip";
import { useThreadWorkflowActions } from "./useThreadWorkflowActions";

const UNDO_REASON = "Undone from the Workflow tab";

function formTitle(
  intent: ThreadWorkflowFormIntent,
  instance: ThreadWorkflowInstanceSummary | null,
): { title: ReactNode; hint: ReactNode } {
  const stepTitle = (stepId: string) =>
    instance?.steps.find((step) => step.id === stepId)?.title ?? stepId;
  const targetTitle = (target: string) =>
    target.includes(".") ? stepTitle(target) : (instance?.title ?? target);
  const nextAfter = (stepId: string) => {
    if (!instance) return null;
    const index = instance.steps.findIndex((step) => step.id === stepId);
    return instance.steps.slice(index + 1).find((step) => step.state._tag === "open") ?? null;
  };
  switch (intent.kind) {
    case "skip": {
      const next = nextAfter(intent.stepId);
      return {
        title: (
          <>
            Skip <b>{stepTitle(intent.stepId)}</b>
          </>
        ),
        hint: next
          ? `The current stage moves to ${next.title}.`
          : "No open stage remains after it.",
      };
    }
    case "remove":
      return {
        title: (
          <>
            Remove <b>{stepTitle(intent.stepId)}</b>
          </>
        ),
        hint: "Stays in the list, struck through.",
      };
    case "reopen":
      return {
        title: (
          <>
            Reopen <b>{targetTitle(intent.target)}</b>
          </>
        ),
        hint: intent.target.includes(".")
          ? "The stage goes back to open."
          : "The workflow becomes the thread's open one again.",
      };
    case "comment":
      return {
        title: (
          <>
            Comment on <b>{targetTitle(intent.target)}</b>
          </>
        ),
        hint: null,
      };
    case "insert":
      return {
        title:
          intent.after === "end" ? (
            "Add a stage at the end"
          ) : intent.after === "top" ? (
            "Add a stage at the top"
          ) : (
            <>
              Add a stage after <b>{stepTitle(intent.after)}</b>
            </>
          ),
        hint: null,
      };
    case "close": {
      const unresolved = instance?.steps.filter((step) => step.state._tag === "open").length ?? 0;
      return intent.outcome === "finished"
        ? {
            title: (
              <>
                Close <b>{instance?.title}</b>
              </>
            ),
            hint: "The thread can settle once no workflow is open.",
          }
        : {
            title: (
              <>
                Abandon <b>{instance?.title}</b>
              </>
            ),
            hint:
              unresolved > 0
                ? `${unresolved} ${unresolved === 1 ? "stage is" : "stages are"} still open. Abandoning records your reason and frees the thread.`
                : "The thread can settle once no workflow is open.",
          };
    }
    case "recover":
      return {
        title: "Recover the workflow log",
        hint: "Sets the unreadable log aside and abandons what it held. Your reason is recorded.",
      };
  }
}

export function ThreadWorkflowPanel({
  threadRef,
  pendingUserInputs,
  onAnswerInComposer,
}: {
  threadRef: ScopedThreadRef;
  pendingUserInputs: ReadonlyArray<ThreadPendingUserInput>;
  onAnswerInComposer: () => void;
}) {
  const query = useEnvironmentQuery(threadWorkflowStateAtom(threadRef));
  const state = query.data;
  const actions = useThreadWorkflowActions(threadRef, state?.view.revision ?? 0);
  const revealQuestionId = usePendingThreadWorkflowReveal(threadRef);
  const [viewedInstanceId, setViewedInstanceId] = useState<ThreadWorkflowInstanceId | null>(null);
  const [form, setForm] = useState<ThreadWorkflowFormIntent | null>(null);
  const [starting, setStarting] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  // The step the user just marked done here. Undo shows on it until the next write.
  const [undoStepId, setUndoStepId] = useState<ThreadWorkflowStepId | null>(null);

  const view = state?.view ?? null;
  const active = view === null ? null : activeThreadWorkflowInstance(view);
  const instance =
    view === null
      ? null
      : (view.instances.find((candidate) => candidate.id === viewedInstanceId) ??
        active ??
        view.instances.at(-1) ??
        null);
  // A reveal from the chat column shows the workflow that holds its question, even over history.
  const revealInstanceId =
    revealQuestionId === null
      ? null
      : (view?.instances.find((candidate) =>
          candidate.questions.some((question) => question.id === revealQuestionId),
        )?.id ?? null);
  if (revealInstanceId !== null && instance?.id !== revealInstanceId) {
    setForm(null);
    setViewedInstanceId(revealInstanceId);
  }
  const corrupt = view !== null && view.corruption !== null;
  const disabled = !actions.canOperate || actions.busy || corrupt;
  const asks = deriveThreadWorkflowAsks(pendingUserInputs);
  const formStepId = threadWorkflowFormStepId(form);

  const submit = async (request: ThreadWorkflowRequest) => {
    const accepted = await actions.submit(request);
    if (!accepted) return false;
    setForm(null);
    setUndoStepId(request._tag === "tick" ? request.stepId : null);
    if (request._tag === "start") setStarting(false);
    if (request._tag === "reopen" && !request.target.includes(".")) setViewedInstanceId(null);
    return true;
  };
  const markDone = (stepId: ThreadWorkflowStepId, note: string) => {
    const comment = note.trim();
    void submit({ _tag: "tick", stepId, ...(comment.length === 0 ? {} : { comment }) });
  };
  const undo = (stepId: ThreadWorkflowStepId) => {
    void submit({ _tag: "reopen", target: stepId, reason: UNDO_REASON });
  };
  const openForm = (intent: ThreadWorkflowFormIntent) => {
    actions.dismissFailure();
    setForm(intent);
  };
  // A pending form targets the instance it was opened on, so it must not outlive the switch.
  const viewInstance = (instanceId: ThreadWorkflowInstanceId) => {
    setForm(null);
    setViewedInstanceId(instanceId);
  };
  const renderForm = () => {
    if (form === null) return null;
    const { title, hint } = formTitle(form, instance);
    return (
      <ThreadWorkflowForm
        key={JSON.stringify(form)}
        intent={form}
        title={title}
        hint={hint}
        busy={actions.busy}
        onSubmit={(request) => void submit(request)}
        onCancel={() => setForm(null)}
      />
    );
  };

  const failure = actions.failure ? (
    <Alert variant="error">
      <TriangleAlertIcon />
      <AlertTitle>{actions.failure.message}</AlertTitle>
      <AlertAction>
        {actions.failure.retry ? (
          <Button size="xs" variant="outline" onClick={actions.failure.retry}>
            Retry
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={actions.dismissFailure}>
          Dismiss
        </Button>
      </AlertAction>
    </Alert>
  ) : null;

  let body: ReactNode;
  if (state === null) {
    body = query.error ? (
      <Alert variant="error">
        <TriangleAlertIcon />
        <AlertTitle>Could not load the workflow</AlertTitle>
        <AlertDescription>{query.error}</AlertDescription>
      </Alert>
    ) : (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  } else if (state.unavailable !== null) {
    body = (
      <Alert>
        <TriangleAlertIcon />
        <AlertTitle>Thread workflows are unavailable on this server</AlertTitle>
        <AlertDescription>{state.unavailable}</AlertDescription>
      </Alert>
    );
  } else {
    const currentView = state.view;
    const corruption = corrupt ? (
      <Alert variant="warning" controlAlignment="first-line">
        <TriangleAlertIcon />
        <AlertTitle>The workflow log is unreadable</AlertTitle>
        <AlertDescription>
          {currentView.corruption} The workflow is read-only, and it does not block the thread.
          Recover sets this log aside and starts a fresh one.
        </AlertDescription>
        {form?.kind === "recover" ? null : (
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              disabled={!actions.canOperate || actions.busy}
              onClick={() => openForm({ kind: "recover" })}
            >
              Recover…
            </Button>
          </AlertAction>
        )}
      </Alert>
    ) : null;
    const recoverForm = form?.kind === "recover" ? renderForm() : null;
    if (instance === null || (active === null && starting)) {
      body = (
        <div className="flex flex-col gap-3">
          {corruption}
          {recoverForm}
          {corrupt ? null : (
            <ThreadWorkflowStart
              environmentId={threadRef.environmentId}
              enabled={state.enabled}
              disabled={disabled}
              onStart={(templateId) => void submit({ _tag: "start", templateId })}
            />
          )}
          {currentView.instances.length > 0 ? (
            <ThreadWorkflowInstanceList
              view={currentView}
              disabled={disabled}
              onView={(instanceId) => {
                viewInstance(instanceId);
                setStarting(false);
              }}
              onOpenForm={openForm}
              onStartNew={() => setStarting(true)}
            />
          ) : null}
        </div>
      );
    } else {
      body = (
        <>
          <ThreadWorkflowHeader
            view={currentView}
            instance={instance}
            disabled={disabled}
            activityOpen={activityOpen}
            onView={viewInstance}
            onOpenForm={openForm}
            onStartNew={() => setStarting(true)}
            onToggleActivity={() => setActivityOpen((open) => !open)}
          />
          {corruption}
          {form !== null && formStepId === null ? renderForm() : null}
          {instance.questions.length > 0 ? (
            <ThreadWorkflowQuestions
              instance={instance}
              disabled={disabled}
              revealQuestionId={revealQuestionId}
              onSubmit={(request) => void submit(request)}
            />
          ) : null}
          <ThreadWorkflowStepList
            instance={instance}
            disabled={disabled}
            undoStepId={undoStepId}
            formStepId={formStepId}
            renderForm={renderForm}
            onOpenForm={openForm}
            onDone={markDone}
            onUndo={undo}
          />
          {activityOpen ? (
            <ThreadWorkflowActivity
              threadRef={threadRef}
              instanceId={instance.id}
              lastChangeAt={instance.lastChangeAt}
            />
          ) : null}
        </>
      );
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-thread-workflow-panel>
      <ThreadWorkflowStrip asks={asks} onAnswerInComposer={onAnswerInComposer} />
      <ScrollArea className="min-h-0 flex-1" radius="none">
        <div className="flex flex-col gap-3 px-3 py-3">
          {failure}
          {body}
        </div>
      </ScrollArea>
    </div>
  );
}
