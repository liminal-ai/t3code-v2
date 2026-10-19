import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

// Each import after resetModules is a fresh module, as after a document reload.
const loadFreshModule = () => import("./mainAppLocation");

describe("mainAppReturnHref", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns the last main-app href after a reload in the same tab", async () => {
    const storage = createStorageStub();
    (await loadFreshModule()).rememberMainAppHref(
      "/environment-1/thread-1?tab=diff",
      () => storage,
    );

    vi.resetModules();
    expect((await loadFreshModule()).mainAppReturnHref(() => storage)).toBe(
      "/environment-1/thread-1?tab=diff",
    );
  });

  it("falls back to the root when storage is unavailable", async () => {
    const broken = () => {
      throw new Error("storage disabled");
    };
    (await loadFreshModule()).rememberMainAppHref("/environment-1/thread-1", broken);

    vi.resetModules();
    expect((await loadFreshModule()).mainAppReturnHref(broken)).toBe("/");
  });

  it("ignores a saved value that is not a main-app path", async () => {
    const { mainAppReturnHref } = await loadFreshModule();
    for (const saved of [
      "/settings",
      "/group-chat/abc",
      "//evil.example/x",
      "https://evil.example/",
    ]) {
      const storage = createStorageStub();
      storage.setItem("t3code:main-app-href", saved);
      expect(mainAppReturnHref(() => storage)).toBe("/");
    }
  });
});
