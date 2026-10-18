import {
  ThreadWorkflowInstanceId,
  ThreadWorkflowStepId,
  ThreadWorkflowTemplateId,
  type ThreadWorkflowInstanceSummary,
  type ThreadWorkflowStamp,
  type ThreadWorkflowStepSummary,
  type ThreadWorkflowSubscriptionView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadPendingUserInput } from "./threadRequests.ts";
import {
  countOpenThreadWorkflowAsks,
  deriveThreadWorkflowAsks,
  threadWorkflowProgress,
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
  it("lists pending questions oldest first, then the active instance's open waits-for-user steps", () => {
    const gate = step("w1.3", "open", { waitsForUser: true });
    const asks = deriveThreadWorkflowAsks({
      pendingUserInputs: [
        question("req-later", "2026-10-17T12:00:00.000Z"),
        question("req-earlier", "2026-10-17T11:00:00.000Z"),
      ],
      view: view("w1", [
        instance("w1", [
          step("w1.1", "done"),
          step("w1.2", "open"),
          gate,
          step("w1.4", "done", { waitsForUser: true }),
        ]),
      ]),
    });
    expect(asks).toEqual([
      { kind: "question", request: expect.objectContaining({ requestId: "req-earlier" }) },
      { kind: "question", request: expect.objectContaining({ requestId: "req-later" }) },
      { kind: "step", instance: expect.objectContaining({ id: "w1" }), step: gate, stepNumber: 3 },
    ]);
  });

  it("is empty with no questions and no open waits-for-user step", () => {
    expect(
      deriveThreadWorkflowAsks({
        pendingUserInputs: [],
        view: view("w1", [
          instance("w1", [step("w1.1", "open"), step("w1.2", "skipped", { waitsForUser: true })]),
        ]),
      }),
    ).toEqual([]);
    expect(deriveThreadWorkflowAsks({ pendingUserInputs: [], view: null })).toEqual([]);
  });

  it("ignores waits-for-user steps of closed instances", () => {
    const asks = deriveThreadWorkflowAsks({
      pendingUserInputs: [],
      view: view(null, [instance("w1", [step("w1.1", "open", { waitsForUser: true })], "closed")]),
    });
    expect(asks).toEqual([]);
    expect(
      countOpenThreadWorkflowAsks({
        pendingUserInputCount: 2,
        view: view("w2", [
          instance("w1", [step("w1.1", "open", { waitsForUser: true })], "closed"),
          instance("w2", [step("w2.1", "open", { waitsForUser: true })]),
        ]),
      }),
    ).toBe(3);
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
