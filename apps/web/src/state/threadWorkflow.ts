import { scopedThreadKey, parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  createThreadWorkflowEnvironmentAtoms,
  NO_THREAD_WORKFLOW_QUESTIONS,
  nextOpenThreadWorkflowQuestions,
} from "@t3tools/client-runtime/state/thread-workflow";
import type {
  ScopedThreadRef,
  ThreadWorkflowQuestionSummary,
  ThreadWorkflowSubscriptionState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreads } from "./threads";
import { threadWorkflowAttentionAtom } from "./threadWorkflowAttention";

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
const NO_QUESTIONS_ATOM = Atom.make(NO_THREAD_WORKFLOW_QUESTIONS).pipe(
  Atom.withLabel("thread-workflow:open-questions:none"),
);

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
    const questionTool =
      projection === undefined || Option.isNone(projection)
        ? 0
        : derivePendingThreadRequests(projection.value).userInputs.length;
    const workflow = get(threadWorkflowAttentionAtom(ref.environmentId)).get(ref.threadId);
    return questionTool + (workflow?.openQuestions ?? 0);
  }).pipe(Atom.withLabel(`thread-workflow:asks:${threadKey}`));
});

const openQuestionsFamily = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey);
  let previous = NO_THREAD_WORKFLOW_QUESTIONS;
  return Atom.make((get) => {
    if (ref === null) return previous;
    previous = nextOpenThreadWorkflowQuestions(previous, get(threadWorkflowStateAtom(ref)));
    return previous;
  }).pipe(Atom.withLabel(`thread-workflow:open-questions:${threadKey}`));
});

/** Whether the Workflow tab and its `+` item show: the flag is on, or an instance is open or corrupt. */
export function threadWorkflowVisibleAtom(ref: ScopedThreadRef | null) {
  return ref === null ? FALSE_ATOM : visibleFamily(scopedThreadKey(ref));
}

export function threadWorkflowOpenAskCountAtom(ref: ScopedThreadRef | null) {
  return ref === null ? ZERO_ATOM : openAskCountFamily(scopedThreadKey(ref));
}

/** The open questions the chat column shows, from the pane's own subscription. */
export function threadWorkflowOpenQuestionsAtom(
  ref: ScopedThreadRef | null,
): Atom.Atom<ReadonlyArray<ThreadWorkflowQuestionSummary>> {
  return ref === null ? NO_QUESTIONS_ATOM : openQuestionsFamily(scopedThreadKey(ref));
}
