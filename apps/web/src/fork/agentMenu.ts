/* oxlint-disable t3code/no-untranslated-copy -- fork copy stays English, so the catalogs stay upstream's */
import type { ContextMenuItem } from "@t3tools/contracts";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";

type Item = ContextMenuItem<ThreadActionMenuId>;

const HIDDEN_ON_AGENTS = new Set<ThreadActionMenuId>([
  "pin",
  "unpin",
  "settle",
  "unsettle",
  "snooze",
  "unsnooze",
  "auto-settle",
]);

export function withAgentMenuItems(items: ReadonlyArray<Item>, isAgent: boolean): Item[] {
  return items.flatMap((item): Item[] => {
    if (item.id !== "pin" && item.id !== "unpin") {
      return isAgent && HIDDEN_ON_AGENTS.has(item.id) ? [] : [item];
    }
    return isAgent
      ? [{ id: "agent-unpin", label: "Unpin agent", icon: "pin-off" }]
      : [item, { id: "agent-pin", label: "Pin as agent", icon: "pin" }];
  });
}
