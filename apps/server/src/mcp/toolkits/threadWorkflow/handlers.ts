import {
  OrchestratorMcpFailure,
  ProviderSessionId,
  ThreadWorkflowError,
  ThreadWorkflowRequest,
  type ThreadId,
  type ThreadWorkflowActor,
  type ThreadWorkflowInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { printedCall, progress } from "../../../threadWorkflow/domain.ts";
import * as ThreadWorkflowService from "../../../threadWorkflow/ThreadWorkflowService.ts";
import { turnNote } from "../../../threadWorkflow/turnNote.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import {
  ThreadWorkflowToolkit,
  type ThreadWorkflowAgentView,
  type ThreadWorkflowChangeParams,
} from "./tools.ts";

const decodeRequest = Schema.decodeUnknownEffect(ThreadWorkflowRequest);
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
// Tool parameters are loose strings; decoding applies the contract's length caps.
const parseRequest = (raw: unknown) =>
  decodeRequest(raw).pipe(Effect.mapError((error) => invalid(error.message)));

/**
 * The credential carries the capability when the flag is on or the thread already has an open
 * or corrupt instance. The tool stays listed either way, so a missing capability is a refusal
 * the agent can read, not a tool that vanished.
 */
const callingThread = (operation: string) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const { thread } = yield* McpInvocationContext.requireThreadScope(scope, operation);
    if (!scope.capabilities.has("thread-workflow")) {
      return yield* new ThreadWorkflowError({
        code: "disabled",
        message:
          "Thread workflows are turned off on this server and this thread has none open, so the thread_workflow tools do nothing here. The user can turn them on with threadWorkflowsEnabled in the server settings.",
      });
    }
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const shell = yield* threads.getThreadShell(thread.threadId).pipe(Effect.mapError(unavailable));
    const actor: ThreadWorkflowActor = {
      _tag: "agent",
      threadId: thread.threadId,
      providerInstanceId: thread.providerInstanceId,
      providerSessionId: ProviderSessionId.make(thread.providerSessionId),
      ...(shell?.activeRunId == null ? {} : { runId: shell.activeRunId }),
    };
    return { threadId: thread.threadId, actor };
  });

const needed = <T>(value: T | undefined, name: string, action: string) =>
  value === undefined
    ? Effect.fail(invalid(`action ${action} needs ${name}.`))
    : Effect.succeed(value);

/** `optionalKey` fields decode only when absent, so an unset parameter must not reach the decoder as `undefined`. */
const present = (record: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

/** The flat change parameters as the request `decide` understands, or the field that is missing. */
const changeRequest = (
  params: ThreadWorkflowChangeParams,
): Effect.Effect<unknown, OrchestratorMcpFailure> => {
  const { action } = params;
  switch (action) {
    case "skip":
    case "remove":
      return Effect.all({
        _tag: Effect.succeed(action),
        stepId: needed(params.stepId, "stepId", action),
        reason: needed(params.reason, "reason", action),
      });
    case "reopen":
      return Effect.all({
        _tag: Effect.succeed(action),
        target: needed(params.target, "target", action),
        reason: needed(params.reason, "reason", action),
      });
    case "comment":
      return Effect.all({
        _tag: Effect.succeed(action),
        target: needed(params.target, "target", action),
        comment: needed(params.comment, "comment", action),
        proof: Effect.succeed(params.proof),
      }).pipe(Effect.map(present));
    case "insert":
      return Effect.all({
        _tag: Effect.succeed(action),
        instanceId: Effect.succeed(params.instanceId),
        afterStepId: Effect.succeed(params.afterStepId),
        reason: needed(params.reason, "reason", action),
        step: Effect.all({
          title: needed(params.title, "title", action),
          instructions: needed(params.instructions, "instructions", action),
          proofLevel: Effect.succeed(params.proofLevel ?? "none"),
          proofHint: Effect.succeed(params.proofHint),
          waitsForUser: Effect.succeed(params.waitsForUser ?? false),
        }).pipe(Effect.map(present)),
      }).pipe(Effect.map(present));
  }
};

const layerHandlers = Effect.gen(function* () {
  const service = yield* ThreadWorkflowService.ThreadWorkflowService;

  const agentView = (
    threadId: ThreadId,
    instanceId?: ThreadWorkflowInstanceId,
  ): Effect.Effect<ThreadWorkflowAgentView, ThreadWorkflowError> =>
    Effect.gen(function* () {
      const [view, state] = yield* Effect.all([service.view(threadId), service.state(threadId)]);
      const focusId = instanceId ?? view.activeInstanceId;
      const instance = view.instances.find((candidate) => candidate.id === focusId) ?? null;
      if (instanceId !== undefined && instance === null) {
        return yield* new ThreadWorkflowError({
          code: "unknown_instance",
          message: `No workflow ${instanceId} on this thread. See them all: ${printedCall.get()}`,
        });
      }
      return {
        enabled: state.enabled,
        revision: view.revision,
        activeInstanceId: view.activeInstanceId,
        corruption: view.corruption,
        instance,
        instances: state.view.instances,
        templates: view.activeInstanceId === null ? yield* service.templates : [],
        note: turnNote(state.view),
      };
    });

  const applyThenView = (
    raw: unknown,
    options: ThreadWorkflowService.ThreadWorkflowApplyOptions,
    operation: string,
  ) =>
    Effect.gen(function* () {
      const { threadId, actor } = yield* callingThread(operation);
      yield* service.apply(actor, threadId, yield* parseRequest(raw), options);
      return yield* agentView(threadId);
    });

  return {
    thread_workflow_get: McpToolAccess.readsAsCaller((params) =>
      Effect.gen(function* () {
        const { threadId } = yield* callingThread("thread_workflow_get");
        return yield* agentView(threadId, params.instanceId);
      }),
    ),
    thread_workflow_start: McpToolAccess.actsAsCaller(({ requestId, ...request }) =>
      applyThenView({ _tag: "start", ...request }, { requestId }, "thread_workflow_start"),
    ),
    thread_workflow_tick: McpToolAccess.actsAsCaller(({ requestId, ...request }) =>
      Effect.gen(function* () {
        const { threadId, actor } = yield* callingThread("thread_workflow_tick");
        const { view } = yield* service.apply(
          actor,
          threadId,
          yield* parseRequest({ _tag: "tick", ...request }),
          { requestId },
        );
        const instance = view.instances.find((candidate) =>
          candidate.steps.some((step) => step.id === request.stepId),
        )!;
        const step = instance.steps.find((candidate) => candidate.id === request.stepId)!;
        const currentStep =
          instance.steps.find((candidate) => candidate.id === instance.currentStepId) ?? null;
        return {
          step,
          currentStep,
          progress: progress(instance),
          next:
            currentStep === null
              ? printedCall.close(instance.id, "finished")
              : printedCall.tick(currentStep),
        };
      }),
    ),
    thread_workflow_change: McpToolAccess.actsAsCaller((params) =>
      changeRequest(params).pipe(
        Effect.flatMap((request) =>
          applyThenView(request, { requestId: params.requestId }, "thread_workflow_change"),
        ),
      ),
    ),
    thread_workflow_close: McpToolAccess.actsAsCaller(({ requestId, ...request }) =>
      applyThenView({ _tag: "close", ...request }, { requestId }, "thread_workflow_close"),
    ),
  } satisfies McpToolAccess.Handlers<typeof ThreadWorkflowToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(ThreadWorkflowToolkit, layerHandlers);
