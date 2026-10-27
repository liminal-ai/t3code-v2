import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { laterWorkflowQuestion, threadAttentionKey } from "./ThreadNotificationCoordinator.logic";

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
