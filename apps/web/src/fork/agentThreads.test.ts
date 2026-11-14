import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { AGENT_THREAD_TAG, isAgentThread, splitAgentThreads } from "./agentThreads";

type Fixture = {
  id: ThreadId;
  pinnedAt: string | null;
  settledOverride: "settled" | "active" | null;
  snoozedUntil: string | null;
  latestUserMessageAt: string | null;
  latestRun: null;
  updatedAt: string;
  source: { tags?: string[] };
};

function thread(id: string, overrides: Partial<Fixture> = {}): Fixture {
  return {
    id: ThreadId.make(id),
    pinnedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    latestUserMessageAt: null,
    latestRun: null,
    updatedAt: "2026-11-01T00:00:00.000Z",
    source: {},
    ...overrides,
  };
}

const agent = (id: string, overrides: Partial<Fixture> = {}) =>
  thread(id, {
    pinnedAt: "2026-11-01T00:00:00.000Z",
    source: { tags: ["work", AGENT_THREAD_TAG] },
    ...overrides,
  });

describe("isAgentThread", () => {
  it("needs both the reserved tag and a pin", () => {
    expect(isAgentThread(agent("a"))).toBe(true);
    expect(isAgentThread(thread("tagged", { source: { tags: [AGENT_THREAD_TAG] } }))).toBe(false);
    expect(isAgentThread(thread("pinned", { pinnedAt: "2026-11-01T00:00:00.000Z" }))).toBe(false);
    expect(
      isAgentThread(agent("upper", { source: { tags: [AGENT_THREAD_TAG.toUpperCase()] } })),
    ).toBe(false);
  });
});

describe("splitAgentThreads", () => {
  it("passes an untagged list through unchanged", () => {
    const threads = [thread("a"), thread("b", { pinnedAt: "2026-11-01T00:00:00.000Z" })];
    const split = splitAgentThreads(threads);
    expect(split.agents).toEqual([]);
    expect(split.others.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("takes pinned, settled and snoozed agents out of every other section", () => {
    const plain = thread("plain");
    const pinned = thread("pinned", { pinnedAt: "2026-11-01T00:00:00.000Z" });
    const taggedUnpinned = thread("tagged", { source: { tags: [AGENT_THREAD_TAG] } });
    const settledAgent = agent("settled-agent", { settledOverride: "settled" });
    const snoozedAgent = agent("snoozed-agent", { snoozedUntil: "2099-01-01T00:00:00.000Z" });
    const pinnedAgent = agent("pinned-agent");
    const split = splitAgentThreads([
      plain,
      settledAgent,
      pinned,
      snoozedAgent,
      taggedUnpinned,
      pinnedAgent,
    ]);
    expect(split.others.map((t) => t.id)).toEqual(["plain", "pinned", "tagged"]);
    expect(split.agents.map((t) => t.id).toSorted()).toEqual([
      "pinned-agent",
      "settled-agent",
      "snoozed-agent",
    ]);
  });

  it("orders agents by latest activity, newest first, with an id tiebreak", () => {
    const split = splitAgentThreads([
      agent("old", { updatedAt: "2026-11-01T00:00:00.000Z" }),
      agent("sent", {
        updatedAt: "2026-11-01T00:00:00.000Z",
        latestUserMessageAt: "2026-11-10T00:00:00.000Z",
      }),
      agent("tie-b", { updatedAt: "2026-11-05T00:00:00.000Z" }),
      agent("tie-a", { updatedAt: "2026-11-05T00:00:00.000Z" }),
    ]);
    expect(split.agents.map((t) => t.id)).toEqual(["sent", "tie-a", "tie-b", "old"]);
  });
});
