import { scopedThreadKey, parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  countOpenThreadWorkflowAsks,
  createThreadWorkflowEnvironmentAtoms,
} from "@t3tools/client-runtime/state/thread-workflow";
import type { ScopedThreadRef, ThreadWorkflowSubscriptionState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreads } from "./threads";

export const threadWorkflowEnvironment =
  createThreadWorkflowEnvironmentAtoms(connectionAtomRuntime);

const NO_WORKFLOW_STATE_ATOM = Atom.make(
  AsyncResult.initial<ThreadWorkflowSubscriptionState, never>(),
).pipe(Atom.withLabel("thread-workflow:none"));

export function threadWorkflowStateAtom(ref: ScopedThreadRef | null) {
  return ref === null
    ? NO_WORKFLOW_STATE_ATOM
    : threadWorkflowEnvironment.state({
        environmentId: ref.environmentId,
        input: { threadId: ref.threadId },
      });
}

export function readThreadWorkflowState(
  result: AsyncResult.AsyncResult<ThreadWorkflowSubscriptionState, unknown>,
): ThreadWorkflowSubscriptionState | null {
  return Option.getOrNull(AsyncResult.value(result));
}

const FALSE_ATOM = Atom.make(false).pipe(Atom.withLabel("thread-workflow:visible:none"));
const ZERO_ATOM = Atom.make(0).pipe(Atom.withLabel("thread-workflow:asks:none"));

// Keyed by thread so every consumer of one thread shares one derived atom. Primitive results
// keep consumers quiet while the underlying streams change without changing the answer.
const visibleFamily = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey);
  return Atom.make((get) =>
    ref === null
      ? false
      : (readThreadWorkflowState(get(threadWorkflowStateAtom(ref)))?.visible ?? false),
  ).pipe(Atom.withLabel(`thread-workflow:visible:${threadKey}`));
});

const openAskCountFamily = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey);
  return Atom.make((get) => {
    if (ref === null) return 0;
    const projection = Option.getOrNull(
      AsyncResult.value(get(environmentThreads.stateAtom(ref.environmentId, ref.threadId))),
    )?.data;
    const pendingUserInputCount =
      projection === undefined || Option.isNone(projection)
        ? 0
        : derivePendingThreadRequests(projection.value).userInputs.length;
    return countOpenThreadWorkflowAsks({
      pendingUserInputCount,
      view: readThreadWorkflowState(get(threadWorkflowStateAtom(ref)))?.view ?? null,
    });
  }).pipe(Atom.withLabel(`thread-workflow:asks:${threadKey}`));
});

/** Whether the Workflow tab and its `+` item show: the flag is on, or an instance is open or corrupt. */
export function threadWorkflowVisibleAtom(ref: ScopedThreadRef | null) {
  return ref === null ? FALSE_ATOM : visibleFamily(scopedThreadKey(ref));
}

/** Pending question-tool requests plus open waits-for-user steps: the tab title's count. */
export function threadWorkflowOpenAskCountAtom(ref: ScopedThreadRef | null) {
  return ref === null ? ZERO_ATOM : openAskCountFamily(scopedThreadKey(ref));
}
