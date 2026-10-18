import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  isThreadWorkflowError,
  type ScopedThreadRef,
  type ThreadWorkflowRequest,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useState } from "react";

import { randomUUID } from "../lib/utils";
import { threadWorkflowEnvironment, threadWorkflowStateAtom } from "../state/threadWorkflow";
import { useAtomCommand } from "../state/use-atom-command";

interface PendingWrite {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly request: ThreadWorkflowRequest;
}

export interface ThreadWorkflowWriteFailure {
  readonly message: string;
  /** Present when the write may not have reached the server: it resends the same request id. */
  readonly retry: (() => void) | null;
}

/**
 * The pane's one write path. Every write carries a fresh request id and the revision the pane
 * rendered. A revision conflict refreshes the view and asks for the change again; a transport
 * failure offers a retry that reuses the id, so a write the server did see replays instead of
 * repeating.
 */
export function useThreadWorkflowActions(threadRef: ScopedThreadRef, revision: number) {
  const apply = useAtomCommand(threadWorkflowEnvironment.apply, { reportFailure: false });
  const canOperate = useAtomValue(
    threadWorkflowEnvironment.apply.permissionAtom(threadRef.environmentId),
  );
  const refresh = useAtomRefresh(threadWorkflowStateAtom(threadRef));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ThreadWorkflowWriteFailure | null>(null);

  const send = async (write: PendingWrite): Promise<boolean> => {
    setBusy(true);
    setFailure(null);
    const result = await apply({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        request: write.request,
        requestId: write.requestId,
        expectedRevision: write.expectedRevision,
      },
    });
    setBusy(false);
    if (result._tag === "Success") return true;
    const error = Option.getOrNull(Cause.findErrorOption(result.cause));
    if (isThreadWorkflowError(error)) {
      if (error.code === "revision_conflict") {
        refresh();
        setFailure({
          message:
            "The workflow changed while you were editing. Check it and apply your change again.",
          retry: null,
        });
      } else {
        setFailure({ message: error.message, retry: null });
      }
      return false;
    }
    setFailure({
      message:
        error instanceof Error && error.message.length > 0
          ? error.message
          : "The change did not reach the server.",
      retry: () => void send(write),
    });
    return false;
  };

  return {
    canOperate,
    busy,
    failure,
    dismissFailure: () => setFailure(null),
    submit: (request: ThreadWorkflowRequest) =>
      send({ requestId: randomUUID(), expectedRevision: revision, request }),
  };
}
