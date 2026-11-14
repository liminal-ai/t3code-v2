import type { ContextMenuItem } from "@t3tools/contracts";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";

type Item = ContextMenuItem<ThreadActionMenuId>;

const PIN_SETTLE_SNOOZE_IDS = new Set<ThreadActionMenuId>([
  "pin",
  "unpin",
  "settle",
  "unsettle",
  "snooze",
  "unsnooze",
]);

export function withAgentMenuItems(items: ReadonlyArray<Item>, isAgent: boolean): Item[] {
  return items.flatMap((item): Item[] => {
    if (item.id !== "pin" && item.id !== "unpin") {
      return isAgent && PIN_SETTLE_SNOOZE_IDS.has(item.id) ? [] : [item];
    }
    return isAgent
      ? [{ id: "agent-unpin", label: "Unpin agent", icon: "pin-off" }]
      : [item, { id: "agent-pin", label: "Pin as agent", icon: "pin" }];
  });
}
