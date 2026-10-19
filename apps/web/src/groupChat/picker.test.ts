import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { matchesThread, pickerRows } from "./picker";

const shell = (
  id: string,
  title: string,
  overrides: Partial<
    Pick<EnvironmentThreadShell, "archivedAt" | "deletedAt" | "lineage" | "updatedAt">
  > = {},
): EnvironmentThreadShell =>
  ({
    id,
    title,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-10-19T00:00:00.000Z",
    lineage: { parentThreadId: null, relationshipToParent: null },
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const uuid = "be3e4c75-1a2b-4c3d-9e8f-123456789abc";
const threads = [
  shell(uuid, "Plain thread", { updatedAt: "2026-10-19T00:01:00.000Z" }),
  shell(`mcp:${uuid.replace("be3e", "7f1d")}`, "MCP thread", {
    updatedAt: "2026-10-19T00:03:00.000Z",
  }),
  shell("thread_sub", "A subagent", {
    lineage: { parentThreadId: uuid, relationshipToParent: "subagent" },
    updatedAt: "2026-10-19T00:02:00.000Z",
  } as never),
  shell("thread_archived", "Archived work", { archivedAt: "2026-10-18T00:00:00.000Z" }),
];

const noFilter = { query: "", showSubagents: false, exclude: new Set<never>() };

describe("thread picker", () => {
  it("a six-character id prefix finds the thread", () => {
    expect(matchesThread(threads[0]!, "be3e4c")).toBe(true);
    expect(matchesThread(threads[0]!, "be3e4")).toBe(false);
    expect(matchesThread(threads[0]!, uuid)).toBe(true);
  });

  it("a bare UUID prefix finds an mcp:-prefixed thread", () => {
    expect(matchesThread(threads[1]!, "7f1d4c75")).toBe(true);
    expect(pickerRows(threads, { ...noFilter, query: "7f1d4c75" }).map((t) => t.id)).toEqual([
      threads[1]!.id,
    ]);
  });

  it("a title fragment finds the thread", () => {
    expect(pickerRows(threads, { ...noFilter, query: "plain" }).map((t) => t.title)).toEqual([
      "Plain thread",
    ]);
  });

  it("subagents stay hidden until the toggle", () => {
    expect(pickerRows(threads, noFilter).map((t) => t.id)).not.toContain("thread_sub");
    expect(pickerRows(threads, { ...noFilter, showSubagents: true }).map((t) => t.id)).toContain(
      "thread_sub",
    );
  });

  it("archived threads never appear", () => {
    for (const showSubagents of [false, true]) {
      for (const query of ["", "archived", "thread_archived"]) {
        expect(
          pickerRows(threads, { ...noFilter, showSubagents, query }).map((t) => t.id),
        ).not.toContain("thread_archived");
      }
    }
  });

  it("rows come newest first and leave out excluded threads", () => {
    expect(pickerRows(threads, { ...noFilter, showSubagents: true }).map((t) => t.title)).toEqual([
      "MCP thread",
      "A subagent",
      "Plain thread",
    ]);
    expect(
      pickerRows(threads, { ...noFilter, exclude: new Set([threads[1]!.id]) }).map((t) => t.title),
    ).toEqual(["Plain thread"]);
  });
});
