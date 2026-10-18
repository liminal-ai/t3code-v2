import {
  ThreadWorkflowError,
  WS_METHODS,
  type ThreadWorkflowApplyInput,
  type ThreadWorkflowGetInput,
  type ThreadWorkflowSubscribeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { printedCall } from "./domain.ts";
import type { ThreadWorkflowService } from "./ThreadWorkflowService.ts";

/** The pane's RPC handlers. The pane acts as the user; the client session traces the device. */
export const handlers = (service: ThreadWorkflowService["Service"], clientSessionId: string) => ({
  [WS_METHODS.threadWorkflowSubscribe]: (input: typeof ThreadWorkflowSubscribeInput.Type) =>
    service.subscribe(input.threadId),
  [WS_METHODS.threadWorkflowGet]: (input: typeof ThreadWorkflowGetInput.Type) =>
    service.view(input.threadId).pipe(
      Effect.flatMap((view) => {
        const instance = view.instances.find((candidate) => candidate.id === input.instanceId);
        return instance === undefined
          ? new ThreadWorkflowError({
              code: "unknown_instance",
              message: `No workflow ${input.instanceId} on this thread. See them all: ${printedCall.get()}`,
            })
          : Effect.succeed(instance);
      }),
    ),
  [WS_METHODS.threadWorkflowApply]: (input: ThreadWorkflowApplyInput) =>
    service.apply({ _tag: "user", clientSessionId }, input.threadId, input.request, {
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
    }),
  [WS_METHODS.threadWorkflowTemplates]: () => service.templates,
});
