import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  activeThreadWorkflowInstanceAtom,
  createThreadWorkflowEnvironmentAtoms,
} from "@t3tools/client-runtime/state/thread-workflow";
import type { ScopedThreadRef, ThreadWorkflowInstanceSummary } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const threadWorkflowEnvironment = createThreadWorkflowEnvironmentAtoms(connectionAtomRuntime);

const NO_INSTANCE_ATOM = Atom.make<ThreadWorkflowInstanceSummary | null>(null).pipe(
  Atom.withLabel("mobile-thread-workflow:none"),
);

// Keyed by thread so the header button and the sheet share one subscription. A thread with no
// workflow, a server without the feature, and a failed subscription all read as null, so the
// thread screen is unchanged in every case but an open workflow.
const activeInstanceFamily = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey);
  if (ref === null) return NO_INSTANCE_ATOM;
  return activeThreadWorkflowInstanceAtom(
    threadWorkflowEnvironment.state({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId },
    }),
  ).pipe(Atom.withLabel(`mobile-thread-workflow:active:${threadKey}`));
});

function activeInstanceAtom(ref: ScopedThreadRef | null) {
  return ref === null ? NO_INSTANCE_ATOM : activeInstanceFamily(scopedThreadKey(ref));
}

/** The thread's open workflow, or null. */
export function useActiveThreadWorkflow(
  ref: ScopedThreadRef | null,
): ThreadWorkflowInstanceSummary | null {
  return useAtomValue(activeInstanceAtom(ref));
}

/** Whether the thread has an open workflow. A boolean keeps the thread screen quiet while steps change. */
export function useThreadHasWorkflow(ref: ScopedThreadRef | null): boolean {
  return useAtomValue(activeInstanceAtom(ref), (instance) => instance !== null);
}
