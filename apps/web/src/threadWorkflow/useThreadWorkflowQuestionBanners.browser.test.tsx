import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  ThreadWorkflowQuestionId,
  type ScopedThreadRef,
  type ThreadWorkflowQuestionSummary,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";

const state = vi.hoisted(() => ({ questions: null as unknown }));

vi.mock("~/state/threadWorkflow", () => ({
  threadWorkflowOpenQuestionsAtom: () => state.questions,
}));

import { ComposerBannerStack } from "~/components/chat/ComposerBannerStack";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { usePendingThreadWorkflowReveal } from "./threadWorkflowQuestionReveal";
import { useThreadWorkflowQuestionBanners } from "./useThreadWorkflowQuestionBanners";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("primary"),
  threadId: ThreadId.make("thread-1"),
};

const merge = {
  id: ThreadWorkflowQuestionId.make("w2.q1"),
  title: "Merge without a second review?",
  summary: "Yes (recommended) or wait for Sam",
  state: { _tag: "open" },
} as ThreadWorkflowQuestionSummary;
const branch = {
  id: ThreadWorkflowQuestionId.make("w2.q2"),
  title: "Which base branch?",
  options: [{ label: "main", recommended: true }, { label: "release/next" }],
  state: { _tag: "open" },
} as ThreadWorkflowQuestionSummary;

function ChatColumn() {
  const items = useThreadWorkflowQuestionBanners(threadRef);
  const reveal = usePendingThreadWorkflowReveal(threadRef);
  return (
    <div data-reveal={reveal ?? ""}>
      <ComposerBannerStack items={items} />
    </div>
  );
}

describe("workflow questions in the chat column", () => {
  it("shows each open question until it is answered, and opens the Workflow tab on it", async () => {
    const registry = AtomRegistry.make();
    const questions = Atom.make<ReadonlyArray<ThreadWorkflowQuestionSummary>>([merge, branch]);
    state.questions = questions;
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ChatColumn />
      </RegistryContext.Provider>,
    );

    const text = () => screen.container.textContent ?? "";
    expect(text()).toContain("Merge without a second review?");
    expect(text()).toContain("Yes (recommended) or wait for Sam");
    expect(text()).toContain("Which base branch?");
    expect(text()).toContain("main (recommended) · release/next");

    await userEvent.click(
      screen.getByRole("button", { name: "Answer in Workflow: Which base branch?" }),
    );
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe(
      "workflow",
    );
    await expect
      .poll(() => screen.container.querySelector<HTMLElement>("[data-reveal]")?.dataset.reveal)
      .toBe("w2.q2");

    registry.set(questions, [merge]);
    await expect.poll(text).not.toContain("Which base branch?");
    expect(text()).toContain("Merge without a second review?");

    registry.set(questions, []);
    await expect.poll(() => screen.getByRole("button").all().length).toBe(0);
    registry.dispose();
  });
});
