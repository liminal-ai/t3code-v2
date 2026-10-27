import {
  createThreadWorkflowAttentionAtoms,
  EMPTY_THREAD_WORKFLOW_ATTENTION,
  nextThreadWorkflowAttention,
} from "@t3tools/client-runtime/state/thread-workflow";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const attentionSubscription = createThreadWorkflowAttentionAtoms(connectionAtomRuntime);

const attentionFamily = Atom.family((environmentId: EnvironmentId) => {
  let previous = EMPTY_THREAD_WORKFLOW_ATTENTION;
  return Atom.make((get) => {
    previous = nextThreadWorkflowAttention(
      previous,
      get(attentionSubscription({ environmentId, input: {} })),
    );
    return previous;
  }).pipe(Atom.withLabel(`thread-workflow:attention:${environmentId}`));
});

/** Every thread of the environment with an open workflow question. The sidebar, the notifications and the tab count read it. */
export function threadWorkflowAttentionAtom(environmentId: EnvironmentId) {
  return attentionFamily(environmentId);
}

const readyFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    AsyncResult.isSuccess(get(attentionSubscription({ environmentId, input: {} }))),
  ).pipe(Atom.withLabel(`thread-workflow:attention-ready:${environmentId}`)),
);

/** Whether the attention subscription has a live snapshot. Before it does, the map above is empty and says nothing. */
export function threadWorkflowAttentionReadyAtom(environmentId: EnvironmentId) {
  return readyFamily(environmentId);
}
