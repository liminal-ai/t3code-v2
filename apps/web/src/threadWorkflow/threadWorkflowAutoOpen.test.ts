import type { ThreadWorkflowSubscriptionState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_THREAD_WORKFLOW_AUTO_OPEN,
  nextThreadWorkflowAutoOpen,
} from "./threadWorkflowAutoOpen";

const snapshot = (activeInstanceId: string | null): ThreadWorkflowSubscriptionState =>
  ({
    enabled: true,
    visible: true,
    unavailable: null,
    view: { threadId: "thread", revision: 1, activeInstanceId, corruption: null, instances: [] },
  }) as never;

describe("thread workflow auto-open", () => {
  it("opens on the first snapshot with an active instance, and never again for that mount", () => {
    const first = nextThreadWorkflowAutoOpen(INITIAL_THREAD_WORKFLOW_AUTO_OPEN, snapshot("w1"));
    expect(first.open).toBe(true);
    expect(nextThreadWorkflowAutoOpen(first.state, snapshot("w1")).open).toBe(false);
    expect(nextThreadWorkflowAutoOpen(first.state, snapshot("w2")).open).toBe(false);
  });

  it("stays closed when the first snapshot has no active instance, even if one starts later", () => {
    const first = nextThreadWorkflowAutoOpen(INITIAL_THREAD_WORKFLOW_AUTO_OPEN, snapshot(null));
    expect(first.open).toBe(false);
    expect(nextThreadWorkflowAutoOpen(first.state, snapshot("w1")).open).toBe(false);
  });

  it("waits for the first snapshot instead of deciding on nothing", () => {
    const pending = nextThreadWorkflowAutoOpen(INITIAL_THREAD_WORKFLOW_AUTO_OPEN, null);
    expect(pending.open).toBe(false);
    expect(nextThreadWorkflowAutoOpen(pending.state, snapshot("w1")).open).toBe(true);
  });
});
