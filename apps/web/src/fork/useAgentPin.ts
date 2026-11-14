import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { AGENT_THREAD_TAG } from "./agentThreads";

type Step = () => Promise<AtomCommandResult<unknown, unknown>>;

async function runInOrder(failureTitle: string, steps: readonly Step[]) {
  for (const step of steps) {
    const result = await step();
    if (result._tag === "Success") continue;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failureTitle,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    return;
  }
}

export function useAgentPin() {
  const setTag = useOrchestrationCommand(threadEnvironment.setTag, { reportFailure: false });
  const pin = useOrchestrationCommand(threadEnvironment.pin, { reportFailure: false });
  const unpin = useOrchestrationCommand(threadEnvironment.unpin, { reportFailure: false });
  const tag = (ref: ScopedThreadRef, tagged: boolean) => () =>
    setTag({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, tag: AGENT_THREAD_TAG, tagged },
    });
  const input = (ref: ScopedThreadRef) => ({
    environmentId: ref.environmentId,
    input: { threadId: ref.threadId },
  });
  const pinAsAgent = (ref: ScopedThreadRef) =>
    runInOrder("Failed to pin as agent", [tag(ref, true), () => pin(input(ref))]);
  const unpinAgent = (ref: ScopedThreadRef) =>
    runInOrder("Failed to unpin agent", [() => unpin(input(ref)), tag(ref, false)]);
  const handleAgentMenuAction = (action: ThreadActionMenuId, ref: ScopedThreadRef) => {
    if (action === "agent-pin") {
      void pinAsAgent(ref);
    } else if (action === "agent-unpin") {
      void unpinAgent(ref);
    }
    return action === "agent-pin" || action === "agent-unpin";
  };
  return { unpinAgent, handleAgentMenuAction };
}
