import {
  EnvironmentId,
  ThreadId,
  ThreadWorkflowInstanceId,
  ThreadWorkflowStepId,
  ThreadWorkflowTemplateId,
  type ThreadWorkflowInstanceSummary,
  type ThreadWorkflowRequest,
  type ThreadWorkflowStamp,
  type ThreadWorkflowSubscriptionState,
} from "@t3tools/contracts";
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
import { THREAD_WORKFLOW_LAYOUTS, useThreadWorkflowLayoutStore } from "./threadWorkflowLayoutStore";

const stamp = {
  seq: 1,
  at: "2026-10-17T10:00:00.000Z",
  by: { _tag: "user" },
} as ThreadWorkflowStamp;

const abandoned = {
  id: ThreadWorkflowInstanceId.make("w1"),
  title: "Single task",
  template: {
    id: ThreadWorkflowTemplateId.make("single-task"),
    version: 1,
    source: null,
    staleAtStart: false,
  },
  status: { _tag: "closed", outcome: "abandoned", stamp, reason: "wrong plan" },
  currentStepId: null,
  started: stamp,
  lastChangeAt: stamp.at,
  steps: [
    {
      id: ThreadWorkflowStepId.make("w1.1"),
      title: "Ground the subsystem",
      instructions: "Read the code.",
      proofLevel: "none",
      waitsForUser: false,
      origin: { _tag: "template" },
      state: { _tag: "open" },
    },
  ],
} as ThreadWorkflowInstanceSummary;

const threadRef = {
  environmentId: EnvironmentId.make("primary"),
  threadId: ThreadId.make("thread-1"),
};

const resetState = () => {
  state.submit.mockReset().mockResolvedValue(true);
  state.workflow = {
    enabled: true,
    visible: true,
    unavailable: null,
    view: {
      threadId: threadRef.threadId,
      revision: 4,
      activeInstanceId: null,
      corruption: null,
      instances: [abandoned],
    },
  } as ThreadWorkflowSubscriptionState;
};

const panel = (
  <ThreadWorkflowPanel threadRef={threadRef} pendingUserInputs={[]} onAnswerInComposer={() => {}} />
);

describe("thread workflow pane", () => {
  it.each(THREAD_WORKFLOW_LAYOUTS.map((layout) => layout.id))(
    "reopens a closed workflow from the %s layout",
    async (layout) => {
      resetState();
      useThreadWorkflowLayoutStore.setState({ layout });
      await using screen = await render(panel);

      await userEvent.click(screen.getByRole("button", { name: "Reopen…" }));
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
    },
  );

  it.each(THREAD_WORKFLOW_LAYOUTS.map((layout) => layout.id))(
    "drops a pending abandon when the user views another workflow in the %s layout",
    async (layout) => {
      resetState();
      useThreadWorkflowLayoutStore.setState({ layout });
      const active = {
        ...abandoned,
        id: ThreadWorkflowInstanceId.make("w2"),
        title: "Open-ended",
        status: { _tag: "open" },
        currentStepId: ThreadWorkflowStepId.make("w2.1"),
        steps: abandoned.steps.map((step) => ({ ...step, id: ThreadWorkflowStepId.make("w2.1") })),
      } as ThreadWorkflowInstanceSummary;
      state.workflow = {
        ...(state.workflow as ThreadWorkflowSubscriptionState),
        view: {
          ...(state.workflow as ThreadWorkflowSubscriptionState).view,
          activeInstanceId: active.id,
          instances: [abandoned, active],
        },
      } as ThreadWorkflowSubscriptionState;
      await using screen = await render(panel);

      await userEvent.click(screen.getByRole("button", { name: "Abandon…" }));
      expect(screen.container.querySelectorAll("form")).toHaveLength(1);

      await userEvent.click(screen.getByRole("button", { name: "Switch workflow" }));
      await userEvent.click(page.getByRole("menuitem", { name: /Single task/ }));

      await expect.poll(() => screen.container.querySelectorAll("form").length).toBe(0);
      expect(state.submit).not.toHaveBeenCalled();
    },
  );
});
