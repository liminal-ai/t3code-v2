import {
  OrchestratorMcpFailure,
  THREAD_WORKFLOW_LIMITS,
  ThreadWorkflowError,
  ThreadWorkflowInstance,
  ThreadWorkflowInstanceId,
  ThreadWorkflowInstanceSummary,
  ThreadWorkflowOutcome,
  ThreadWorkflowProofLevel,
  ThreadWorkflowRequestId,
  ThreadWorkflowStepId,
  ThreadWorkflowStepSummary,
  ThreadWorkflowTarget,
  ThreadWorkflowTemplateId,
  ThreadWorkflowTemplateSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadWorkflowService from "../../../threadWorkflow/ThreadWorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// These are the user's checklist for the calling thread, not Claude workflow runs
// (`t3_workflow_stop`). The bare `thread_workflow_*` name is the T3 tool.
const ABOUT =
  "This is the user's thread workflow: the checklist for the calling T3 thread, not a Claude workflow run. The bare name is the T3 tool.";
const ACK =
  "Returns a short acknowledgement with the current step and the next call; thread_workflow_get has the whole workflow.";

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, ThreadWorkflowError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadWorkflowService.ThreadWorkflowService,
  ],
};

/** The open instance in full with its current step, the others summarized, templates when none is open. */
export const ThreadWorkflowAgentView = Schema.Struct({
  enabled: Schema.Boolean,
  revision: Schema.Int,
  activeInstanceId: Schema.NullOr(ThreadWorkflowInstanceId),
  corruption: Schema.NullOr(Schema.String),
  instance: Schema.NullOr(ThreadWorkflowInstance),
  instances: Schema.Array(ThreadWorkflowInstanceSummary),
  templates: Schema.Array(ThreadWorkflowTemplateSummary),
  /** The current step and its printed calls, as the turn note prints them. */
  note: Schema.String,
});
export type ThreadWorkflowAgentView = typeof ThreadWorkflowAgentView.Type;

const Progress = Schema.Struct({
  total: Schema.Int,
  open: Schema.Int,
  currentPosition: Schema.NullOr(Schema.Int),
});

export const ThreadWorkflowTickResult = Schema.Struct({
  step: ThreadWorkflowStepSummary,
  currentStep: Schema.NullOr(ThreadWorkflowStepSummary),
  progress: Progress,
  /** The next printed call: tick the next step, or close the workflow. */
  next: Schema.String,
});

/**
 * What start, change and close return: enough to carry on, never the whole workflow. An agent
 * that wrote a 7-stage plan reads a few lines back, not every step's history.
 */
export const ThreadWorkflowMutationAck = Schema.Struct({
  revision: Schema.Int,
  instanceId: ThreadWorkflowInstanceId,
  progress: Progress,
  currentStep: Schema.NullOr(
    Schema.Struct({
      id: ThreadWorkflowStepId,
      title: Schema.String,
      instructions: Schema.String,
    }),
  ),
  /** The next printed call: tick the current step, close the workflow, or read it once closed. */
  next: Schema.String,
});
export type ThreadWorkflowMutationAck = typeof ThreadWorkflowMutationAck.Type;

const requestId = Schema.optionalKey(ThreadWorkflowRequestId);

const GetTool = Tool.make("thread_workflow_get", {
  ...shared,
  description: `Read the calling thread's workflows. ${ABOUT} Returns the open instance in full with its current step, the other instances summarized, and the templates when none is open. Pass instanceId to read a closed one in full.`,
  parameters: Schema.Struct({ instanceId: Schema.optionalKey(ThreadWorkflowInstanceId) }),
  success: ThreadWorkflowAgentView,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

/** One stage of a plan written at start. Loose strings; the handler decodes them with the contract's caps. */
export const ThreadWorkflowStartStep = Schema.Struct({
  title: Schema.String,
  instructions: Schema.String,
  waitsForUser: Schema.optionalKey(Schema.Boolean),
  proofLevel: Schema.optionalKey(ThreadWorkflowProofLevel),
  proofHint: Schema.optionalKey(Schema.String),
});
export type ThreadWorkflowStartStep = typeof ThreadWorkflowStartStep.Type;

const StartTool = Tool.make("thread_workflow_start", {
  ...shared,
  description: `Start a workflow on the calling thread from a template. ${ABOUT} Write the whole plan in this one call with steps: 4 to 7 stages in order, each an outcome at the same level as the others, so the user sees the arc of the work at a glance. A stage title is for the user: short, plain, what is true once it is done. Instructions are for you. Side quests and detail go in a comment on the current step or your own todo list, never in new steps. A workflow holds at most ${THREAD_WORKFLOW_LIMITS.steps} steps that are open or done. The steps go before the template's own steps; open-ended keeps only a final sign-off step, so pass steps with it. A thread holds one open workflow at a time, and while it is open the thread cannot settle, archive or be deleted. Refused when thread workflows are off on this server. ${ACK}`,
  parameters: Schema.Struct({
    templateId: ThreadWorkflowTemplateId,
    title: Schema.optionalKey(Schema.String),
    comment: Schema.optionalKey(Schema.String),
    steps: Schema.optionalKey(Schema.Array(ThreadWorkflowStartStep)),
    requestId,
  }),
  success: ThreadWorkflowMutationAck,
}).annotate(Tool.Destructive, false);

const TickTool = Tool.make("thread_workflow_tick", {
  ...shared,
  description: `Mark a step of the calling thread's workflow done. ${ABOUT} comment is required: one or two lines on what you did and how you know it worked. The user reads it under the step. proof is the evidence the step asked for (a commit SHA, a test command and its result, a PR URL). Returns the next step and the call to make when it is done.`,
  parameters: Schema.Struct({
    stepId: ThreadWorkflowStepId,
    comment: Schema.String,
    proof: Schema.optionalKey(Schema.String),
    requestId,
  }),
  success: ThreadWorkflowTickResult,
}).annotate(Tool.Destructive, false);

/** Flat on purpose: some providers mangle `oneOf` parameters, so one struct covers every action. */
export const ThreadWorkflowChangeParams = Schema.Struct({
  action: Schema.Literals(["skip", "insert", "remove", "reopen", "comment"]),
  stepId: Schema.optionalKey(ThreadWorkflowStepId),
  target: Schema.optionalKey(ThreadWorkflowTarget),
  reason: Schema.optionalKey(Schema.String),
  comment: Schema.optionalKey(Schema.String),
  proof: Schema.optionalKey(Schema.String),
  afterStepId: Schema.optionalKey(Schema.NullOr(ThreadWorkflowStepId)),
  instanceId: Schema.optionalKey(ThreadWorkflowInstanceId),
  title: Schema.optionalKey(Schema.String),
  instructions: Schema.optionalKey(Schema.String),
  proofLevel: Schema.optionalKey(ThreadWorkflowProofLevel),
  proofHint: Schema.optionalKey(Schema.String),
  waitsForUser: Schema.optionalKey(Schema.Boolean),
  requestId,
});
export type ThreadWorkflowChangeParams = typeof ThreadWorkflowChangeParams.Type;

const ChangeTool = Tool.make("thread_workflow_change", {
  ...shared,
  description: `Change the calling thread's workflow in a way that is not a tick. ${ABOUT} action skip (stepId, reason), remove (stepId, reason) and reopen (target, reason) move one step; reopen also reopens a closed workflow by its instance id when none is open. action comment (target, comment, proof) records a note on a step or a workflow without changing it: use it for progress, side quests and detail on the current step. action insert (title, instructions, reason; afterStepId or instanceId; proofLevel defaults to none, waitsForUser to false) adds a stage, an outcome at the same level as the others, and is refused past ${THREAD_WORKFLOW_LIMITS.steps} open or done steps. Every reason is recorded with who gave it. ${ACK}`,
  parameters: ThreadWorkflowChangeParams,
  success: ThreadWorkflowMutationAck,
}).annotate(Tool.Destructive, false);

const CloseTool = Tool.make("thread_workflow_close", {
  ...shared,
  description: `Close the calling thread's workflow. ${ABOUT} outcome finished needs every step done, skipped or removed; abandoned closes it as it stands. reason is recorded with who gave it. A closed workflow releases the thread to settle, archive or be deleted. ${ACK}`,
  parameters: Schema.Struct({
    instanceId: ThreadWorkflowInstanceId,
    outcome: ThreadWorkflowOutcome,
    reason: Schema.String,
    requestId,
  }),
  success: ThreadWorkflowMutationAck,
}).annotate(Tool.Destructive, false);

export const ThreadWorkflowToolkit = Toolkit.make(
  GetTool,
  StartTool,
  TickTool,
  ChangeTool,
  CloseTool,
);
