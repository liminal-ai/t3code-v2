import {
  EnvironmentId,
  ThreadId,
  ThreadWorkflowInstanceId,
  ThreadWorkflowQuestionId,
  ThreadWorkflowStepId,
  ThreadWorkflowTemplateId,
  type ThreadWorkflowInstanceSummary,
  type ThreadWorkflowQuestionSummary,
  type ThreadWorkflowRequest,
  type ThreadWorkflowStamp,
  type ThreadWorkflowStepSummary,
  type ThreadWorkflowSubscriptionState,
} from "@t3tools/contracts";
import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";

const state = vi.hoisted(() => ({
  workflow: null as unknown,
  submit: vi.fn<(request: unknown) => Promise<boolean>>(),
}));

vi.mock("~/state/threadWorkflow", () => ({
  threadWorkflowStateAtom: () => "workflow-state",
  threadWorkflowEnvironment: { instance: () => "workflow-instance" },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === "workflow-state" ? state.workflow : null,
    error: null,
  }),
}));
vi.mock("./useThreadWorkflowActions", () => ({
  useThreadWorkflowActions: () => ({
    canOperate: true,
    busy: false,
    failure: null,
    submit: state.submit,
    dismissFailure: () => {},
  }),
}));

import { ThreadWorkflowPanel } from "./ThreadWorkflowPanel";
import { revealThreadWorkflowQuestion } from "./threadWorkflowQuestionReveal";

const stamp = {
  seq: 1,
  at: "2026-10-17T10:00:00.000Z",
  by: { _tag: "user" },
} as ThreadWorkflowStamp;

const step = (
  id: string,
  title: string,
  state: ThreadWorkflowStepSummary["state"]["_tag"],
  options: { waitsForUser?: boolean; comment?: string } = {},
) =>
  ({
    id: ThreadWorkflowStepId.make(id),
    title,
    instructions: `Agent brief for ${title}.`,
    proofLevel: "none",
    waitsForUser: options.waitsForUser ?? false,
    origin: { _tag: "template" },
    state:
      state === "open"
        ? { _tag: "open" }
        : state === "done"
          ? { _tag: "done", stamp, comment: options.comment ?? null, proof: null }
          : { _tag: state, stamp, reason: "because" },
  }) as ThreadWorkflowStepSummary;

const template = {
  id: ThreadWorkflowTemplateId.make("open-ended"),
  version: 2,
  source: null,
  staleAtStart: false,
};

const abandoned = {
  id: ThreadWorkflowInstanceId.make("w1"),
  title: "Single task",
  template,
  status: { _tag: "closed", outcome: "abandoned", stamp, reason: "wrong plan" },
  currentStepId: null,
  started: stamp,
  lastChangeAt: stamp.at,
  steps: [step("w1.1", "Ground the subsystem", "open")],
  questions: [],
} as ThreadWorkflowInstanceSummary;

const sliceOne = {
  id: ThreadWorkflowInstanceId.make("w2"),
  title: "Slice 1 startup: groundwork, scope, plan, build, retro, and a very long tail",
  template,
  status: { _tag: "open" },
  currentStepId: ThreadWorkflowStepId.make("w2.3"),
  started: stamp,
  lastChangeAt: stamp.at,
  steps: [
    step("w2.1", "Groundwork", "done", { comment: "Repo, Linear project and judge set up" }),
    step("w2.2", "Scope slice 1", "skipped"),
    step("w2.3", "Plan slice 1", "open"),
    step("w2.4", "Build slice 1", "open", { waitsForUser: true }),
    step("w2.5", "Retro and close", "open", { waitsForUser: true }),
  ],
  questions: [],
} as ThreadWorkflowInstanceSummary;

const workflowQuestion = (
  id: string,
  title: string,
  fields: Partial<Omit<ThreadWorkflowQuestionSummary, "id" | "title">> = {},
) =>
  ({
    id: ThreadWorkflowQuestionId.make(id),
    title,
    state: { _tag: "open" },
    ...fields,
  }) as ThreadWorkflowQuestionSummary;

const withQuestions = {
  ...sliceOne,
  questions: [
    workflowQuestion("w2.q1", "Merge without a second review?", {
      summary: "Yes (recommended) · No, wait for Sam",
      details: "Sam is out until Monday. Waiting costs a day; merging now risks a revert.",
      options: [{ label: "Yes", recommended: true }, { label: "No, wait for Sam" }],
      blocksStepId: ThreadWorkflowStepId.make("w2.4"),
    }),
    workflowQuestion("w2.q2", "Ship to staging first?", { summary: "Staging is up again" }),
    workflowQuestion("w2.q3", "Which base branch?", {
      state: { _tag: "answered", stamp, answer: "main", source: "pane" },
    }),
  ],
} as ThreadWorkflowInstanceSummary;

const threadRef = {
  environmentId: EnvironmentId.make("primary"),
  threadId: ThreadId.make("thread-1"),
};

const setWorkflow = (
  instances: ReadonlyArray<ThreadWorkflowInstanceSummary>,
  activeInstanceId: ThreadWorkflowInstanceId | null,
) => {
  state.workflow = {
    enabled: true,
    visible: true,
    unavailable: null,
    view: {
      threadId: threadRef.threadId,
      revision: 4,
      activeInstanceId,
      corruption: null,
      instances,
    },
  } as ThreadWorkflowSubscriptionState;
};

const question = {
  requestId: "req-1",
  createdAt: "2026-10-17T11:00:00.000Z",
  questions: [{ id: "q1", header: "Merge without review?", question: "Merge without review?" }],
  responseCapability: "live",
} as unknown as ThreadPendingUserInput;

const panel = (pendingUserInputs: ReadonlyArray<ThreadPendingUserInput> = []) => (
  <ThreadWorkflowPanel
    threadRef={threadRef}
    pendingUserInputs={pendingUserInputs}
    onAnswerInComposer={() => {}}
  />
);

describe("thread workflow pane", () => {
  it("shows the arc as one list and only pending questions as waiting on you", async () => {
    state.submit.mockReset().mockResolvedValue(true);
    setWorkflow([abandoned, sliceOne], sliceOne.id);
    await using screen = await render(panel());

    expect(screen.getByText("Stage 3 of 5")).toBeTruthy();
    const rows = [...screen.container.querySelectorAll<HTMLElement>("[data-step-id]")];
    expect(rows.map((row) => row.dataset.stepPhase)).toEqual([
      "done",
      "skipped",
      "current",
      "upcoming",
      "upcoming",
    ]);
    expect(screen.getByText("Repo, Linear project and judge set up")).toBeTruthy();
    expect(screen.getByText("your call", { exact: true }).all()).toHaveLength(2);
    expect(screen.container.querySelector("[data-thread-workflow-asks]")).toBeNull();
    expect(screen.getByRole("button", { name: "Done" }).all()).toHaveLength(1);
    expect(screen.container.textContent).not.toContain("Agent brief for");

    await userEvent.click(screen.getByRole("button", { name: "Details" }).nth(2));
    await expect
      .poll(() => screen.container.textContent)
      .toContain("Agent brief for Plan slice 1.");
  });

  it("shows open questions collapsed above the steps and the answered ones folded away", async () => {
    state.submit.mockReset().mockResolvedValue(true);
    setWorkflow([withQuestions], withQuestions.id);
    await using screen = await render(panel());

    const section = screen.container.querySelector("[data-thread-workflow-questions]")!;
    const rows = [...section.querySelectorAll<HTMLElement>("[data-question-id]")];
    expect(rows.map((row) => row.dataset.questionId)).toEqual(["w2.q1", "w2.q2"]);
    expect(
      section.compareDocumentPosition(screen.container.querySelector("[data-step-id]")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(section.textContent).toContain("Yes (recommended) · No, wait for Sam");
    expect(section.textContent).not.toContain("Sam is out until Monday");
    expect(section.textContent).toContain("Answered (1)");
    expect(section.textContent).not.toContain("Answered by you");
    expect(screen.getByRole("button", { name: "Answer" }).all()).toHaveLength(0);
    expect(screen.getByText("waiting on question", { exact: true }).all()).toHaveLength(1);
    expect(screen.container.querySelector('[data-step-id="w2.4"]')?.textContent).toContain(
      "waiting on question",
    );

    await userEvent.click(screen.getByRole("button", { name: "Answered questions" }));
    await expect.poll(() => section.textContent).toContain("Answered by you · main");
  });

  it("expands a question in place and answers it from an option or in words", async () => {
    state.submit.mockReset().mockResolvedValue(true);
    setWorkflow([withQuestions], withQuestions.id);
    await using screen = await render(panel());

    await userEvent.click(
      screen.getByRole("button", { name: "Details for Merge without a second review?" }),
    );
    const section = screen.container.querySelector("[data-thread-workflow-questions]")!;
    await expect.poll(() => section.textContent).toContain("Sam is out until Monday");
    expect(section.textContent).toContain("recommended");
    expect(section.textContent).toContain("Waiting on this: Build slice 1");
    expect(section.textContent).not.toContain("Staging is up again\n");

    await userEvent.click(screen.getByRole("button", { name: "Yes", exact: true }));
    expect(state.submit).toHaveBeenCalledWith({
      _tag: "answer",
      questionId: ThreadWorkflowQuestionId.make("w2.q1"),
      answer: "Yes",
      source: "pane",
    } satisfies ThreadWorkflowRequest);

    await userEvent.click(
      screen.getByRole("button", { name: "Details for Ship to staging first?" }),
    );
    await userEvent.fill(
      screen.getByLabelText("Answer to Ship to staging first?"),
      "Yes, staging first",
    );
    await userEvent.click(screen.getByRole("button", { name: "Answer", exact: true }).nth(1));
    expect(state.submit).toHaveBeenLastCalledWith({
      _tag: "answer",
      questionId: ThreadWorkflowQuestionId.make("w2.q2"),
      answer: "Yes, staging first",
      source: "pane",
    } satisfies ThreadWorkflowRequest);

    await userEvent.click(screen.getByRole("button", { name: "Answered questions" }));
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(state.submit).toHaveBeenLastCalledWith({
      _tag: "reopen",
      target: ThreadWorkflowQuestionId.make("w2.q3"),
      reason: "Reopened from the Workflow tab",
    } satisfies ThreadWorkflowRequest);
  });

  it("opens on the question the chat column asked for, expanded with its answer field focused", async () => {
    state.submit.mockReset().mockResolvedValue(true);
    setWorkflow([withQuestions], withQuestions.id);
    revealThreadWorkflowQuestion(threadRef, ThreadWorkflowQuestionId.make("w2.q2"));
    await using screen = await render(panel());

    const focused = () => document.activeElement?.getAttribute("aria-label");
    await expect.poll(focused).toBe("Answer to Ship to staging first?");
    expect(screen.getByLabelText("Answer to Merge without a second review?").all()).toHaveLength(0);

    revealThreadWorkflowQuestion(threadRef, ThreadWorkflowQuestionId.make("w2.q1"));
    await expect.poll(focused).toBe("Answer to Merge without a second review?");
    expect(screen.getByLabelText("Answer to Ship to staging first?").all()).toHaveLength(1);

    await screen.unmount();
    await using again = await render(panel());
    expect(again.getByRole("button", { name: "Answer", exact: true }).all()).toHaveLength(0);
  });

  it("leaves a historical workflow for the question the chat column asked for", async () => {
    state.submit.mockReset().mockResolvedValue(true);
    setWorkflow([abandoned, withQuestions], withQuestions.id);
    await using screen = await render(panel());

    await userEvent.click(screen.getByRole("button", { name: "Workflow menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: /Single task/ }));
    await expect.poll(() => screen.getByText("Ground the subsystem").all().length).toBe(1);

    revealThreadWorkflowQuestion(threadRef, ThreadWorkflowQuestionId.make("w2.q2"));
    await expect
      .poll(() => document.activeElement?.getAttribute("aria-label"))
      .toBe("Answer to Ship to staging first?");
  });

  it("pins a pending question above the list", async () => {
    state.submit.mockReset().mockResolvedValue(true);
    setWorkflow([sliceOne], sliceOne.id);
    await using screen = await render(panel([question]));

    const strip = screen.container.querySelector("[data-thread-workflow-asks]");
    expect(strip?.textContent).toContain("Merge without review?");
  });

  it("marks the current step done with an optional note and offers undo", async () => {
    state.submit.mockReset().mockResolvedValue(true);
    setWorkflow([sliceOne], sliceOne.id);
    await using screen = await render(panel());

    await userEvent.fill(screen.getByLabelText("Note"), "Plan approved");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(state.submit).toHaveBeenCalledWith({
      _tag: "tick",
      stepId: sliceOne.steps[2]!.id,
      comment: "Plan approved",
    } satisfies ThreadWorkflowRequest);

    setWorkflow(
      [
        {
          ...sliceOne,
          currentStepId: ThreadWorkflowStepId.make("w2.4"),
          steps: sliceOne.steps.map((candidate, index) =>
            index === 2
              ? step("w2.3", "Plan slice 1", "done", { comment: "Plan approved" })
              : candidate,
          ),
        } as ThreadWorkflowInstanceSummary,
      ],
      sliceOne.id,
    );
    await screen.rerender(panel());
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(state.submit).toHaveBeenLastCalledWith({
      _tag: "reopen",
      target: sliceOne.steps[2]!.id,
      reason: "Undone from the Workflow tab",
    } satisfies ThreadWorkflowRequest);
  });

  it("marks done with no note when the note is empty", async () => {
    state.submit.mockReset().mockResolvedValue(true);
    setWorkflow([sliceOne], sliceOne.id);
    await using screen = await render(panel());

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(state.submit).toHaveBeenCalledWith({
      _tag: "tick",
      stepId: sliceOne.steps[2]!.id,
    } satisfies ThreadWorkflowRequest);
  });

  it("reopens a closed workflow from the menu", async () => {
    state.submit.mockReset().mockResolvedValue(true);
    setWorkflow([abandoned], null);
    await using screen = await render(panel());

    await userEvent.click(screen.getByRole("button", { name: "Workflow menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Reopen…" }));
    await userEvent.fill(
      screen.container.querySelector("#thread-workflow-reason")!,
      "back on track",
    );
    await userEvent.click(screen.container.querySelector('form button[type="submit"]')!);

    expect(state.submit).toHaveBeenCalledWith({
      _tag: "reopen",
      target: abandoned.id,
      reason: "back on track",
    } satisfies ThreadWorkflowRequest);
  });

  it("drops a pending abandon when the user views another workflow", async () => {
    state.submit.mockReset().mockResolvedValue(true);
    setWorkflow([abandoned, sliceOne], sliceOne.id);
    await using screen = await render(panel());

    await userEvent.click(screen.getByRole("button", { name: "Workflow menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Abandon…" }));
    expect(screen.container.querySelectorAll("form[data-thread-workflow-form]")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Workflow menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: /Single task/ }));

    await expect
      .poll(() => screen.container.querySelectorAll("form[data-thread-workflow-form]").length)
      .toBe(0);
    expect(state.submit).not.toHaveBeenCalled();
  });
});
