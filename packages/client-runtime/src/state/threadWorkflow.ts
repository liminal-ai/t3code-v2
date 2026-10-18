// The thread workflow pane's state: the user's checklist for one thread. Unrelated to
// `./threadWorkflows.ts`, which covers Claude workflow runs and queued turns.
import {
  WS_METHODS,
  type ThreadWorkflowInstanceSummary,
  type ThreadWorkflowStepId,
  type ThreadWorkflowStepSummary,
  type ThreadWorkflowSubscriptionView,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

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
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:thread-workflow:state",
      tag: WS_METHODS.threadWorkflowSubscribe,
    }),
    instance: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-workflow:instance",
      tag: WS_METHODS.threadWorkflowGet,
      staleTimeMs: 0,
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

export function activeThreadWorkflowInstance(
  view: Pick<ThreadWorkflowSubscriptionView, "activeInstanceId" | "instances">,
): ThreadWorkflowInstanceSummary | null {
  if (view.activeInstanceId === null) return null;
  return view.instances.find((instance) => instance.id === view.activeInstanceId) ?? null;
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
 * One entry of the pane's pinned "Waiting on you" strip. A question leaves when its request
 * stops being pending; a step leaves when it is ticked, skipped or removed.
 */
export type ThreadWorkflowAsk =
  | { readonly kind: "question"; readonly request: ThreadPendingUserInput }
  | {
      readonly kind: "step";
      readonly instance: ThreadWorkflowInstanceSummary;
      readonly step: ThreadWorkflowStepSummary;
      readonly stepNumber: number;
    };

export function deriveThreadWorkflowAsks(input: {
  readonly pendingUserInputs: ReadonlyArray<ThreadPendingUserInput>;
  readonly view: Pick<ThreadWorkflowSubscriptionView, "activeInstanceId" | "instances"> | null;
}): ReadonlyArray<ThreadWorkflowAsk> {
  const questions = [...input.pendingUserInputs]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((request): ThreadWorkflowAsk => ({ kind: "question", request }));
  const instance = input.view === null ? null : activeThreadWorkflowInstance(input.view);
  if (instance === null) return questions;
  const numbers = threadWorkflowStepNumbers(instance.steps);
  const steps = instance.steps.flatMap((step): ThreadWorkflowAsk[] =>
    step.waitsForUser && step.state._tag === "open"
      ? [{ kind: "step", instance, step, stepNumber: numbers.get(step.id) ?? 0 }]
      : [],
  );
  return [...questions, ...steps];
}

export function countOpenThreadWorkflowAsks(input: {
  readonly pendingUserInputCount: number;
  readonly view: Pick<ThreadWorkflowSubscriptionView, "activeInstanceId" | "instances"> | null;
}): number {
  const instance = input.view === null ? null : activeThreadWorkflowInstance(input.view);
  const waiting =
    instance === null
      ? 0
      : instance.steps.filter((step) => step.waitsForUser && step.state._tag === "open").length;
  return input.pendingUserInputCount + waiting;
}
