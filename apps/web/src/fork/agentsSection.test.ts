import { describe, expect, it } from "vite-plus/test";

import {
  planSidebarThreadDrop,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "../components/Sidebar.logic";

const marker = (name: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker: name });
const row = (key: string, section: SidebarSection): SidebarListItem => ({
  kind: "thread",
  key,
  section,
});
const items: readonly SidebarListItem[] = [
  marker("pinned-header"),
  row("p1", "pinned"),
  marker("pinned-divider"),
  row("a1", "active"),
  row("a2", "active"),
  marker("agents-header"),
  row("g1", "agents"),
  row("g2", "agents"),
  marker("working-header"),
  row("w1", "working"),
  marker("settled-header"),
  row("s1", "settled"),
];

describe("the Agents section", () => {
  it("accepts no drop and keeps agent rows out of the active order", () => {
    expect(resolveSidebarDropTarget(items, "a1", "g1")).toBeNull();
    expect(resolveSidebarDropTarget(items, "a1", "g2")).toBeNull();
    expect(resolveSidebarDropTarget(items, "p1", "a2")).toEqual({
      section: "active",
      pinnedOrder: [],
      activeOrder: ["a1", "a2", "p1"],
    });
    expect(resolveSidebarDropVerb("active", "agents")).toBeNull();
  });

  it.each([
    ["pinned", "p1"],
    ["active", "a2"],
    ["settled", "s1"],
  ] as const)("never moves an agent row into %s", (section, overKey) => {
    const target = resolveSidebarDropTarget(items, "g1", overKey);
    expect(target?.section).toBe(section);
    expect(
      planSidebarThreadDrop({
        activeKey: "g1",
        activeSection: "agents",
        target: target!,
        pinnedOrder: ["p1"],
        pinnedKeysById: new Map([["p1", "m"]]),
        activeOrder: ["a1", "a2"],
        activeKeysById: new Map([
          ["a1", "f"],
          ["a2", "t"],
        ]),
      }),
    ).toEqual({ kind: "none" });
  });
});
