import { describe, expect, it } from "vite-plus/test";

import { isSidebarUtilityPage } from "./mainAppLocation";

describe("isSidebarUtilityPage", () => {
  it("a group chat path with an id is a utility page", () => {
    expect(isSidebarUtilityPage("/group-chat")).toBe(true);
    expect(isSidebarUtilityPage("/group-chat/does-not-exist")).toBe(true);
  });

  it("a thread path is not", () => {
    expect(isSidebarUtilityPage("/environment-1/thread-1")).toBe(false);
    expect(isSidebarUtilityPage("/group-chatter")).toBe(false);
  });
});
