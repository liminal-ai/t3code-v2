import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, test } from "vite-plus/test";

import { AGENT_THREAD_TAG, splitAgentThreads } from "./agentThreads";

const projectId = ProjectId.make("benchmark-project");
const start = Date.parse("2026-08-11T00:00:00.000Z");
const threads = Array.from({ length: 1_000 }, (_, index) => {
  const timestamp = new Date(start + ((index * 997) % 1_000) * 60_000).toISOString();
  const agent = index % 100 === 0;
  return {
    id: ThreadId.make(`thread-${index}`),
    projectId,
    updatedAt: timestamp,
    latestUserMessageAt: timestamp,
    latestRun: null,
    pinnedAt: agent ? timestamp : null,
    source: { tags: agent ? [AGENT_THREAD_TAG] : [] },
  };
});

describe("agent threads performance", () => {
  test("split 1000 threads with 10 agents", async ({ bench }) => {
    await bench("split", () => {
      splitAgentThreads(threads);
    }).run();
  });
});
