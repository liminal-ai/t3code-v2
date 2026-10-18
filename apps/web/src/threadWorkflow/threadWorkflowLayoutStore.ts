import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/** `checklist` is layout A, `focus` is layout B (focus card and step rail). */
export type ThreadWorkflowLayout = "checklist" | "focus";

export const THREAD_WORKFLOW_LAYOUTS: ReadonlyArray<{
  readonly id: ThreadWorkflowLayout;
  readonly label: string;
}> = [
  { id: "checklist", label: "Checklist" },
  { id: "focus", label: "Focus" },
];

interface ThreadWorkflowLayoutStoreState {
  layout: ThreadWorkflowLayout;
  setLayout: (layout: ThreadWorkflowLayout) => void;
}

const isLayout = (value: unknown): value is ThreadWorkflowLayout =>
  value === "checklist" || value === "focus";

// Once Lee picks a layout, delete this store with the losing layout file and the toggle.
export const useThreadWorkflowLayoutStore = create<ThreadWorkflowLayoutStoreState>()(
  persist(
    (set) => ({
      layout: "focus",
      setLayout: (layout) => set({ layout }),
    }),
    {
      name: "t3code:thread-workflow-layout:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ layout }) => ({ layout }),
      migrate: (persisted) => {
        const layout = (persisted as { layout?: unknown } | null)?.layout;
        return { layout: isLayout(layout) ? layout : "focus" };
      },
    },
  ),
);
