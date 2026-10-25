import {
  ThreadWorkflowInstanceId,
  ThreadWorkflowStepId,
  ThreadWorkflowTemplateId,
  type ThreadWorkflowInstanceSummary,
  type ThreadWorkflowStamp,
  type ThreadWorkflowStepSummary,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

type Box = { readonly children?: ReactNode; readonly testID?: string };

vi.mock("react-native", () => ({
  View: ({ children, testID }: Box) => <div data-testid={testID}>{children}</div>,
  Text: ({ children }: Box) => <span>{children}</span>,
  TextInput: () => null,
  Platform: { OS: "ios", Version: 18 },
}));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: () => null,
}));

import { ThreadWorkflowArc } from "./ThreadWorkflowArc";

const stamp = {
  seq: 1,
  at: "2026-10-17T10:00:00.000Z",
  by: { _tag: "agent", runId: "run" },
} as ThreadWorkflowStamp;

const step = (
  id: string,
  title: string,
  state: ThreadWorkflowStepSummary["state"],
  waitsForUser = false,
) =>
  ({
    id: ThreadWorkflowStepId.make(id),
    title,
    instructions: "Do it.",
    proofLevel: "none",
    waitsForUser,
    origin: { _tag: "template" },
    state,
  }) as ThreadWorkflowStepSummary;

const instance = (steps: ThreadWorkflowStepSummary[]) =>
  ({
    id: ThreadWorkflowInstanceId.make("w1"),
    title: "Ship the variant",
    template: {
      id: ThreadWorkflowTemplateId.make("single-task"),
      version: 1,
      source: null,
      staleAtStart: false,
    },
    status: { _tag: "open" },
    currentStepId: steps.find((candidate) => candidate.state._tag === "open")?.id ?? null,
    started: stamp,
    lastChangeAt: stamp.at,
    steps,
  }) as ThreadWorkflowInstanceSummary;

let root: Root | null = null;

function render(arc: ThreadWorkflowInstanceSummary) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<ThreadWorkflowArc instance={arc} />));
  const row = (id: string) =>
    container.querySelector(`[data-testid="thread-workflow-step-${id}"]`)?.textContent ?? null;
  return { container, row };
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

it("reads the arc as title, stage line, and one line per step", () => {
  const { container, row } = render(
    instance([
      step("w1.1", "Plan", { _tag: "done", stamp, comment: "Agreed in chat", proof: "notes" }),
      step("w1.2", "Build", { _tag: "done", stamp, comment: null, proof: "vp test run" }),
      step("w1.3", "Review", { _tag: "skipped", stamp, reason: "self-reviewed" }),
      step("w1.4", "Verify", { _tag: "open" }, true),
      step("w1.5", "Ship", { _tag: "open" }, true),
      step("w1.6", "Old step", { _tag: "removed", stamp, reason: "folded into Ship" }),
    ]),
  );

  expect(container.textContent).toContain("Ship the variant");
  expect(container.textContent).toContain("Stage 4 of 5");
  expect(row("w1.1")).toBe("PlanAgreed in chat");
  expect(row("w1.2")).toBe("Buildvp test run");
  expect(row("w1.3")).toBe("ReviewSkipped · self-reviewed");
  expect(row("w1.4")).toBe("Verify  your call");
  expect(row("w1.5")).toBe("Ship  your call");
  expect(row("w1.6")).toBe("Old stepRemoved · folded into Ship");
});

it("marks only open steps as your call, and upcoming steps carry no result", () => {
  const { row } = render(
    instance([
      step("w1.1", "Decide", { _tag: "done", stamp, comment: null, proof: null }, true),
      step("w1.2", "Build", { _tag: "open" }),
      step("w1.3", "Ship", { _tag: "open" }),
    ]),
  );

  expect(row("w1.1")).toBe("Decide");
  expect(row("w1.2")).toBe("Build");
  expect(row("w1.3")).toBe("Ship");
});

it("says when every stage is done", () => {
  const { container } = render(
    instance([step("w1.1", "Only step", { _tag: "done", stamp, comment: null, proof: null })]),
  );
  expect(container.textContent).toContain("All 1 stages done");
});
