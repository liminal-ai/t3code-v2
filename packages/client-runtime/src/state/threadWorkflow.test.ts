import {
  ThreadWorkflowInstanceId,
  ThreadWorkflowStepId,
  ThreadWorkflowTemplateId,
  type ThreadWorkflowInstanceSummary,
  type ThreadWorkflowStamp,
  type ThreadWorkflowStepSummary,
  type ThreadWorkflowSubscriptionState,
  type ThreadWorkflowSubscriptionView,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadPendingUserInput } from "./threadRequests.ts";
import {
  deriveThreadWorkflowAsks,
  threadWorkflowProgress,
  threadWorkflowRevisionAtom,
  threadWorkflowStepNumbers,
} from "./threadWorkflow.ts";

const stamp = {
  seq: 1,
  at: "2026-10-17T10:00:00.000Z",
  by: { _tag: "user" },
} as ThreadWorkflowStamp;

const step = (
  id: string,
  state: ThreadWorkflowStepSummary["state"]["_tag"],
  options: { waitsForUser?: boolean; inserted?: boolean } = {},
) =>
  ({
    id: ThreadWorkflowStepId.make(id),
    title: `Step ${id}`,
    instructions: "Do it.",
    proofLevel: "none",
    waitsForUser: options.waitsForUser ?? false,
    origin: options.inserted ? { _tag: "inserted", stamp, reason: "added" } : { _tag: "template" },
    state:
      state === "open"
        ? { _tag: "open" }
        : state === "done"
          ? { _tag: "done", stamp, comment: null, proof: null }
          : { _tag: state, stamp, reason: "because" },
  }) as ThreadWorkflowStepSummary;

const instance = (
  id: string,
  steps: ThreadWorkflowStepSummary[],
  status: "open" | "closed" = "open",
) =>
  ({
    id: ThreadWorkflowInstanceId.make(id),
    title: `Workflow ${id}`,
    template: {
      id: ThreadWorkflowTemplateId.make("single-task"),
      version: 1,
      source: null,
      staleAtStart: false,
    },
    status:
      status === "open"
        ? { _tag: "open" }
        : { _tag: "closed", outcome: "finished", stamp, reason: "done" },
    currentStepId: steps.find((candidate) => candidate.state._tag === "open")?.id ?? null,
    started: stamp,
    lastChangeAt: stamp.at,
    steps,
  }) as ThreadWorkflowInstanceSummary;

const view = (
  active: string | null,
  instances: ThreadWorkflowInstanceSummary[],
): ThreadWorkflowSubscriptionView =>
  ({
    threadId: "thread",
    revision: 3,
    activeInstanceId: active,
    corruption: null,
    instances,
  }) as never;

const question = (requestId: string, createdAt: string) =>
  ({
    requestId,
    createdAt,
    questions: [],
    responseCapability: "live",
  }) as unknown as ThreadPendingUserInput;

describe("deriveThreadWorkflowAsks", () => {
  it("lists pending questions oldest first", () => {
    const asks = deriveThreadWorkflowAsks([
      question("req-later", "2026-10-17T12:00:00.000Z"),
      question("req-earlier", "2026-10-17T11:00:00.000Z"),
    ]);
    expect(asks.map((ask) => ask.requestId)).toEqual(["req-earlier", "req-later"]);
  });

  it("is empty with no pending question", () => {
    expect(deriveThreadWorkflowAsks([])).toEqual([]);
  });
});

describe("step numbering and progress", () => {
  it("numbers live steps in display order and leaves removed steps unnumbered", () => {
    const numbers = threadWorkflowStepNumbers([
      step("w1.1", "done"),
      step("w1.5", "removed"),
      step("w1.2", "open"),
    ]);
    expect([...numbers.entries()]).toEqual([
      ["w1.1", 1],
      ["w1.2", 2],
    ]);
  });

  it("counts resolved, skipped, inserted and removed steps", () => {
    expect(
      threadWorkflowProgress([
        step("w1.1", "done"),
        step("w1.2", "skipped"),
        step("w1.3", "removed", { inserted: true }),
        step("w1.4", "open", { inserted: true }),
      ]),
    ).toEqual({ live: 3, resolved: 2, skipped: 1, inserted: 2, removed: 1 });
  });
});

describe("threadWorkflowRevisionAtom", () => {
  const snapshot = (revision: number) =>
    AsyncResult.success({
      enabled: true,
      visible: true,
      unavailable: null,
      view: { ...view("w1", [instance("w1", [step("w1.1", "open")])]), revision },
    } as ThreadWorkflowSubscriptionState);

  it("signals the open history to refetch when a write moves the revision, and only then", () => {
    const registry = AtomRegistry.make();
    const state = Atom.make<AsyncResult.AsyncResult<ThreadWorkflowSubscriptionState>>(
      AsyncResult.initial(),
    );
    const signals: Array<number | null> = [];
    registry.subscribe(threadWorkflowRevisionAtom(state), (revision) => signals.push(revision), {
      immediate: true,
    });

    registry.set(state, snapshot(3));
    registry.set(state, snapshot(3));
    registry.set(state, snapshot(4));

    expect(signals).toEqual([null, 3, 4]);
    registry.dispose();
  });
});
