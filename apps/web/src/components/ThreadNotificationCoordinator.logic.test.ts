import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import { RunId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a completion when the thread resumes within the grace", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS - 1);
    observe(working);
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies a real completion once after the grace", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS - 1);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...completed(1) });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies attention at once and replaces a pending completion", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ attention: "run-1:approval", settled: false, completedAt: null });
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
    vi.advanceTimersByTime(60_000);
    // The request resolves and the same run reads as completed again.
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("notifies one completion across continuation gaps", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(300);
    observe(working);
    vi.advanceTimersByTime(5_000);
    observe(completed(2));
    vi.advanceTimersByTime(300);
    observe(working);
    vi.advanceTimersByTime(5_000);
    observe(completed(3));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("keeps a completion interrupted by attention after a working gap from firing", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe({ attention: "run-1:approval", settled: false, completedAt: null });
    vi.advanceTimersByTime(60_000);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("adds nothing when attention follows a completion that already fired", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    observe({ attention: "run-1:limited", settled: false, completedAt: null });
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "input"],
    ]);
  });

  it("still notifies a newer completion after attention", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ attention: "run-2:approval", settled: false, completedAt: null });
    observe(working);
    observe(completed(2));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([
      ["thread", "input"],
      ["thread", "completion"],
    ]);
  });

  it("ignores unrelated updates while a completion waits", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(1_500);
    observe({ ...completed(1) });
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies a run that settles again after a brief runtime blip", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("restarts the grace when a newer completion replaces a pending one", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(1_500);
    observe(completed(2));
    vi.advanceTimersByTime(1_500);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("drops a pending completion on archive, stop request, removal or clear", () => {
    for (const end of [
      (h: ReturnType<typeof harness>) => h.observe(completed(1), { ...visible, archived: true }),
      (h: ReturnType<typeof harness>) =>
        h.observe({ ...completed(1) }, { ...visible, quiet: true }),
      (h: ReturnType<typeof harness>) => h.gate.retain(new Set()),
      (h: ReturnType<typeof harness>) => h.gate.clear(),
    ]) {
      const h = harness();
      h.observe(working);
      h.observe(completed(1));
      end(h);
      vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
      expect(h.notify).not.toHaveBeenCalled();
    }
  });

  it("never notifies a stopped run or the first observation", () => {
    const { notify, observe } = harness();
    observe(completed(1));
    observe(working);
    observe(completed(2), { ...visible, quiet: true });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
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
