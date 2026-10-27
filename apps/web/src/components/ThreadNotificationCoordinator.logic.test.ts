import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadAttentionKey, workflowQuestionNumber } from "./ThreadNotificationCoordinator.logic";

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
    const first = threadAttentionKey("input", { ...quiet, latestRun: run("run-1") }, 1);
    expect(first).toBe("workflow:1");
    expect(threadAttentionKey("input", { ...quiet, latestRun: run("run-2") }, 1)).toBe(first);
    expect(threadAttentionKey("input", { ...quiet, latestRun: run("run-2") }, 2)).not.toBe(first);
  });

  it("keeps the run in the key for a question-tool ask, and nothing for a quiet thread", () => {
    const ask = {
      hasPendingUserInput: true,
      pendingSubagentRequest: null,
      latestRun: run("run-1"),
    };
    expect(threadAttentionKey("input", ask, 0)).toBe("run-1:input:0");
    expect(threadAttentionKey("input", { ...ask, latestRun: run("run-2") }, 0)).toBe(
      "run-2:input:0",
    );
    expect(threadAttentionKey("approval", { ...quiet, latestRun: run("run-1") }, 3)).toBe(
      "run-1:approval:3",
    );
    expect(threadAttentionKey("working", { ...quiet, latestRun: run("run-1") }, 3)).toBeNull();
    expect(threadAttentionKey("ready", { ...quiet, latestRun: null }, 0)).toBeNull();
  });
});

describe("workflowQuestionNumber", () => {
  it("reads the counter of a question id and 0 for none", () => {
    expect(workflowQuestionNumber("w1.q1")).toBe(1);
    expect(workflowQuestionNumber("w12.q30")).toBe(30);
    expect(workflowQuestionNumber(null)).toBe(0);
    expect(workflowQuestionNumber(undefined)).toBe(0);
  });
});
