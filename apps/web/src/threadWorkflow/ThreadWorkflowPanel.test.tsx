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
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("~/components/ui/menu", () => ({
  Menu: "div",
  MenuItem: "div",
  MenuPopup: "div",
  MenuTrigger: ({ render, children }: { render: ReactElement; children?: ReactNode }) =>
    cloneElement(render, {}, children),
}));
vi.mock("~/components/ui/scroll-area", () => ({ ScrollArea: "div" }));

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

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

describe("thread workflow pane", () => {
  it.each(THREAD_WORKFLOW_LAYOUTS.map((layout) => layout.id))(
    "reopens a closed workflow from the %s layout",
    async (layout) => {
      useThreadWorkflowLayoutStore.setState({ layout });
      await act(() => {
        renderer = create(
          <ThreadWorkflowPanel
            threadRef={threadRef}
            pendingUserInputs={[]}
            onAnswerInComposer={() => {}}
          />,
        );
      });
      const root = renderer!.root;

      const reopen = root
        .findAllByType("button")
        .find((button) => textOf(button).includes("Reopen…"));
      expect(reopen).toBeDefined();
      await act(() => reopen!.props.onClick());

      const reason = root.find((node) => node.props.id === "thread-workflow-reason");
      await act(() => reason.props.onChange({ currentTarget: { value: "back on track" } }));
      await act(() =>
        root.find((node) => node.type === "form").props.onSubmit({ preventDefault: () => {} }),
      );

      expect(state.submit).toHaveBeenCalledWith({
        _tag: "reopen",
        target: abandoned.id,
        reason: "back on track",
      } satisfies ThreadWorkflowRequest);
    },
  );
});
