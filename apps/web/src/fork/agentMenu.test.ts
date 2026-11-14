import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
} from "../components/threadActionMenu.logic";

const state: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: true,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [],
};

const ids = (input: ThreadActionMenuState) =>
  buildThreadActionMenuItems(input).map((item) => item.id);

describe("agent menu items", () => {
  it("puts Pin as agent directly under the pin item", () => {
    expect(ids({ ...state, isPinned: false }).slice(0, 4)).toEqual([
      "pin",
      "agent-pin",
      "settle",
      "snooze",
    ]);
    expect(ids(state).slice(0, 2)).toEqual(["unpin", "agent-pin"]);
  });

  it("gives an agent only Unpin agent, with no pin, settle, snooze or auto-settle item", () => {
    expect(ids(state)).toContain("auto-settle");
    const agentIds = ids({ ...state, isAgent: true, isSettled: true, isSnoozed: true });
    expect(agentIds[0]).toBe("agent-unpin");
    for (const id of [
      "pin",
      "unpin",
      "agent-pin",
      "settle",
      "unsettle",
      "snooze",
      "unsnooze",
      "auto-settle",
    ]) {
      expect(agentIds).not.toContain(id);
    }
  });

  it("needs operate access", () => {
    const items = buildThreadActionMenuItems({ ...state, isAgent: true, canOperate: false });
    expect(items.find((item) => item.id === "agent-unpin")?.disabled).toBe(true);
  });
});
