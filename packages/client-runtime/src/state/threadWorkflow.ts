// The thread workflow pane's state: the user's checklist for one thread. Unrelated to
// `./threadWorkflows.ts`, which covers Claude workflow runs and queued turns.
import {
  WS_METHODS,
  type ThreadWorkflowInstanceSummary,
  type ThreadWorkflowStepId,
  type ThreadWorkflowStepSummary,
  type ThreadWorkflowSubscriptionState,
  type ThreadWorkflowSubscriptionView,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { ThreadPendingUserInput } from "./threadRequests.ts";

export function createThreadWorkflowEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const state = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:thread-workflow:state",
    tag: WS_METHODS.threadWorkflowSubscribe,
  });
  return {
    state,
    // The full history is only in `get`, so an open history refetches on each thread write.
    instance: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-workflow:instance",
      tag: WS_METHODS.threadWorkflowGet,
      staleTimeMs: 0,
      refreshTrigger: ({ environmentId, input }) =>
        threadWorkflowRevisionAtom(state({ environmentId, input: { threadId: input.threadId } })),
    }),
    templates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-workflow:templates",
      tag: WS_METHODS.threadWorkflowTemplates,
      staleTimeMs: 60_000,
    }),
    apply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-workflow:apply",
      tag: WS_METHODS.threadWorkflowApply,
    }),
  };
}

/** The subscription's revision, or null before its first snapshot. Unchanged revisions signal nothing. */
export function threadWorkflowRevisionAtom(
  state: Atom.Atom<AsyncResult.AsyncResult<ThreadWorkflowSubscriptionState, unknown>>,
): Atom.Atom<number | null> {
  return Atom.make((get) => Option.getOrNull(AsyncResult.value(get(state)))?.view.revision ?? null);
}

export function activeThreadWorkflowInstance(
  view: Pick<ThreadWorkflowSubscriptionView, "activeInstanceId" | "instances">,
): ThreadWorkflowInstanceSummary | null {
  if (view.activeInstanceId === null) return null;
  return view.instances.find((instance) => instance.id === view.activeInstanceId) ?? null;
}

/**
 * The subscription's open workflow, or null. Only a live snapshot counts: `AsyncResult.value` keeps
 * the last success through a failure, which would leave a dead subscription's workflow on screen.
 */
export function activeThreadWorkflowInstanceAtom(
  state: Atom.Atom<AsyncResult.AsyncResult<ThreadWorkflowSubscriptionState, unknown>>,
): Atom.Atom<ThreadWorkflowInstanceSummary | null> {
  return Atom.make((get) => {
    const result = get(state);
    return AsyncResult.isSuccess(result) ? activeThreadWorkflowInstance(result.value.view) : null;
  });
}

/** Removed steps keep their row but no number, so the numbers match the turn note. */
export function threadWorkflowStepNumbers(
  steps: ReadonlyArray<Pick<ThreadWorkflowStepSummary, "id" | "state">>,
): ReadonlyMap<ThreadWorkflowStepId, number> {
  const numbers = new Map<ThreadWorkflowStepId, number>();
  let next = 1;
  for (const step of steps) {
    if (step.state._tag === "removed") continue;
    numbers.set(step.id, next);
    next += 1;
  }
  return numbers;
}

export interface ThreadWorkflowProgress {
  /** Steps that still count: everything not removed. */
  readonly live: number;
  /** Done or skipped, the steps the note counts as behind the agent. */
  readonly resolved: number;
  readonly skipped: number;
  readonly inserted: number;
  readonly removed: number;
}

export function threadWorkflowProgress(
  steps: ReadonlyArray<Pick<ThreadWorkflowStepSummary, "state" | "origin">>,
): ThreadWorkflowProgress {
  let live = 0;
  let resolved = 0;
  let skipped = 0;
  let inserted = 0;
  let removed = 0;
  for (const step of steps) {
    if (step.origin._tag === "inserted") inserted += 1;
    if (step.state._tag === "removed") {
      removed += 1;
      continue;
    }
    live += 1;
    if (step.state._tag === "skipped") skipped += 1;
    if (step.state._tag !== "open") resolved += 1;
  }
  return { live, resolved, skipped, inserted, removed };
}

/**
 * Where a step sits in the arc. `current` and `upcoming` split the open steps by position, so a
 * row's treatment is one lookup on this and never a pair of booleans that must agree.
 */
export type ThreadWorkflowStepPhase = "done" | "current" | "upcoming" | "skipped" | "removed";

export function threadWorkflowStepPhase(
  step: Pick<ThreadWorkflowStepSummary, "id" | "state">,
  instance: Pick<ThreadWorkflowInstanceSummary, "currentStepId">,
): ThreadWorkflowStepPhase {
  if (step.state._tag !== "open") return step.state._tag;
  return step.id === instance.currentStepId ? "current" : "upcoming";
}

/** The line under a resolved step's title: a done step's note, else its proof; a skipped or removed step's reason. */
export function threadWorkflowStepResult(
  step: Pick<ThreadWorkflowStepSummary, "state">,
): string | null {
  const { state } = step;
  switch (state._tag) {
    case "open":
      return null;
    case "done":
      return state.comment ?? state.proof;
    case "skipped":
    case "removed":
      return state.reason;
  }
}

/** "Stage 3 of 5", or where a finished or closed workflow ended up. */
export function threadWorkflowStageLine(
  instance: Pick<ThreadWorkflowInstanceSummary, "status" | "currentStepId" | "steps">,
): string {
  const progress = threadWorkflowProgress(instance.steps);
  if (instance.status._tag === "closed") {
    return instance.status.outcome === "finished"
      ? `Finished · ${progress.live} ${progress.live === 1 ? "stage" : "stages"}`
      : `Abandoned · ${instance.status.reason}`;
  }
  if (instance.currentStepId === null) {
    return progress.live === 0 ? "No stages yet" : `All ${progress.live} stages done`;
  }
  const position = threadWorkflowStepNumbers(instance.steps).get(instance.currentStepId) ?? 0;
  return `Stage ${position} of ${progress.live}`;
}

/**
 * The pane's pinned "Waiting on you" strip: the pending question-tool requests, oldest first. A
 * step marked `waitsForUser` is a static property of the plan and never an ask by itself; it
 * becomes one only when the agent asks through its question tool.
 */
export function deriveThreadWorkflowAsks(
  pendingUserInputs: ReadonlyArray<ThreadPendingUserInput>,
): ReadonlyArray<ThreadPendingUserInput> {
  return [...pendingUserInputs].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}
