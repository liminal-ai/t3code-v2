import { RunId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadNotificationGate,
  laterWorkflowQuestion,
  threadAttentionKey,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";

const working: ThreadNotificationObservation = {
  attention: null,
  settled: false,
  completedAt: null,
};
const completed = (at: number): ThreadNotificationObservation => ({
  attention: null,
  settled: true,
  completedAt: at,
});
const visible = { archived: false, quiet: false };

function harness() {
  const notify = vi.fn();
  const gate = createThreadNotificationGate<string>(notify);
  let prior: ThreadNotificationObservation | undefined;
  const observe = (next: ThreadNotificationObservation, options = visible) => {
    gate.observe("thread", prior, next, options);
    prior = next;
  };
  return { gate, notify, observe };
}

describe("createThreadNotificationGate", () => {
  it("notifies a completion immediately and only once", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...completed(1) });
    observe(working);
    observe(completed(1));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies each newer completion immediately", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    observe(working);
    observe(completed(2));
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "completion"],
    ]);
    observe(completed(1));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("notifies attention once and still notifies the subsequent completion", () => {
    const { notify, observe } = harness();
    observe(working);
    const attention = { attention: "run-1:approval", settled: false, completedAt: null };
    observe(attention);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
    observe({ ...attention });
    expect(notify).toHaveBeenCalledTimes(1);
    observe(working);
    observe(completed(1));
    expect(notify.mock.calls).toEqual([
      ["thread", "input"],
      ["thread", "completion"],
    ]);
  });

  it("does not replay a completion after attention resolves", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    observe({ attention: "run-1:limited", settled: false, completedAt: null });
    observe(completed(1));
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "input"],
    ]);
  });

  it("never notifies existing, archived or stopped completions, including when unarchived", () => {
    const { notify, observe } = harness();
    observe(completed(1));
    observe(working);
    observe(completed(2), { ...visible, quiet: true });
    observe(completed(2));
    observe(working);
    observe(completed(3), { ...visible, archived: true });
    observe(completed(3));
    expect(notify).not.toHaveBeenCalled();
    observe(working);
    observe(completed(4));
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("forgets handled completions when a thread is removed or the gate is cleared", () => {
    for (const reset of [
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.retain(new Set()),
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.clear(),
    ]) {
      const { gate, notify, observe } = harness();
      observe(completed(1));
      reset(gate);
      gate.observe("thread", undefined, working, visible);
      gate.observe("thread", working, completed(1), visible);
      expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    }
  });
});

const run = (id: string) => ({
  runId: RunId.make(id),
  status: "completed" as const,
  requestedAt: null,
  startedAt: null,
  completedAt: null,
  assistantMessageId: null,
});

const quiet = { hasPendingUserInput: false, pendingSubagentRequest: null };

describe("threadAttentionKey", () => {
  it("keys workflow-only input on the highest question seen, not on the run", () => {
    const first = threadAttentionKey("input", { ...quiet, latestRun: run("run-1") }, "w1.q1");
    expect(first).toBe("workflow:w1.q1");
    expect(threadAttentionKey("input", { ...quiet, latestRun: run("run-2") }, "w1.q1")).toBe(first);
    expect(threadAttentionKey("input", { ...quiet, latestRun: run("run-2") }, "w1.q2")).not.toBe(
      first,
    );
  });

  it("keeps the run in the key for a question-tool ask, and nothing for a quiet thread", () => {
    const ask = {
      hasPendingUserInput: true,
      pendingSubagentRequest: null,
      latestRun: run("run-1"),
    };
    expect(threadAttentionKey("input", ask, null)).toBe("run-1:input:");
    expect(threadAttentionKey("input", { ...ask, latestRun: run("run-2") }, null)).toBe(
      "run-2:input:",
    );
    expect(threadAttentionKey("approval", { ...quiet, latestRun: run("run-1") }, "w1.q3")).toBe(
      "run-1:approval:w1.q3",
    );
    expect(
      threadAttentionKey("working", { ...quiet, latestRun: run("run-1") }, "w1.q3"),
    ).toBeNull();
    expect(threadAttentionKey("ready", { ...quiet, latestRun: null }, null)).toBeNull();
  });
});

describe("laterWorkflowQuestion", () => {
  it("orders by workflow first, so a new workflow's first question comes after the old one's last", () => {
    expect(laterWorkflowQuestion("w1.q5", "w2.q1")).toBe("w2.q1");
    expect(laterWorkflowQuestion("w2.q1", "w1.q5")).toBe("w2.q1");
    expect(laterWorkflowQuestion("w1.q2", "w1.q10")).toBe("w1.q10");
    expect(laterWorkflowQuestion("w12.q3", "w9.q30")).toBe("w12.q3");
  });

  it("keeps the high-water mark when a question is answered and an earlier one stays open", () => {
    expect(laterWorkflowQuestion("w1.q2", "w1.q1")).toBe("w1.q2");
  });

  it("takes whichever side is a question id, and null for none", () => {
    expect(laterWorkflowQuestion(null, "w1.q1")).toBe("w1.q1");
    expect(laterWorkflowQuestion("w1.q1", undefined)).toBe("w1.q1");
    expect(laterWorkflowQuestion(null, undefined)).toBeNull();
  });
});
