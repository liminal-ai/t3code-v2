import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useThreadWorkflowLayoutStore } from "./threadWorkflowLayoutStore";

beforeEach(() => {
  useThreadWorkflowLayoutStore.setState({ layout: "focus" });
});

describe("thread workflow layout choice", () => {
  it("writes the choice to storage and reads it back on reload", async () => {
    useThreadWorkflowLayoutStore.getState().setLayout("checklist");
    const { storage, name } = useThreadWorkflowLayoutStore.persist.getOptions();
    expect(await storage!.getItem(name!)).toEqual({ state: { layout: "checklist" }, version: 1 });

    useThreadWorkflowLayoutStore.setState({ layout: "focus" });
    await storage!.setItem(name!, { state: { layout: "checklist" }, version: 1 });
    await useThreadWorkflowLayoutStore.persist.rehydrate();
    expect(useThreadWorkflowLayoutStore.getState().layout).toBe("checklist");
  });

  it.each([null, {}, { layout: "grid" }, { layout: 3 }])(
    "falls back to the focus layout for stored value %j",
    async (state) => {
      const { storage, name } = useThreadWorkflowLayoutStore.persist.getOptions();
      await storage!.setItem(name!, { state: state as { layout: "focus" }, version: 0 });
      await useThreadWorkflowLayoutStore.persist.rehydrate();
      expect(useThreadWorkflowLayoutStore.getState().layout).toBe("focus");
    },
  );
});
