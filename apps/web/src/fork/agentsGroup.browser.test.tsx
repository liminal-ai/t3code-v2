import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import Sidebar from "../components/Sidebar";
import { SidebarProvider } from "../components/ui/sidebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { readLocalApi } from "../localApi";
import {
  readEnvironmentServerConfigLoaded,
  useProjects,
  useQuietThreadShells,
  useServerConfigs,
  useThreadShell,
} from "../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { makeThreadFixture } from "../test-fixtures";
import type { Project } from "../types";
import { AGENT_THREAD_TAG, AGENTS_SHELF_EXPANDED_KEY } from "./agentThreads";
import { ThreadAgentRow } from "./ThreadAgentRow";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock("../localApi", { spy: true });
vi.mock("../components/sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const activeProject: Project = {
  id: projectId,
  environmentId,
  title: "project",
  workspaceRoot: "/projects/project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
};

function shell(
  id: string,
  agent: boolean,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  const base = makeThreadFixture({
    environmentId,
    projectId,
    id: ThreadId.make(id),
    title: id,
  });
  return {
    ...base,
    ...(agent
      ? {
          pinnedAt: "2026-01-02T00:00:00.000Z",
          source: { ...base.source, tags: [AGENT_THREAD_TAG] },
        }
      : {}),
    ...overrides,
  };
}

type CommandName = "pin" | "unpin" | "setTag";
type SentCommand = {
  readonly command: CommandName;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tagged?: boolean;
};

/** Stands in for the server: each command updates the threads the sidebar reads. */
function fakeServer(initial: EnvironmentThreadShell[]) {
  let threads = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const snapshot = () => threads;
  const useThreads = () => useSyncExternalStore(subscribe, snapshot);
  const sent: SentCommand[] = [];
  const update = (
    threadId: ThreadId,
    change: (thread: EnvironmentThreadShell) => EnvironmentThreadShell,
  ) => {
    threads = threads.map((thread) => (thread.id === threadId ? change(thread) : thread));
    for (const listener of listeners) listener();
  };
  const handlers: Record<CommandName, (input: { threadId: ThreadId; tagged?: boolean }) => void> = {
    pin: ({ threadId }) =>
      update(threadId, (thread) => ({ ...thread, pinnedAt: "2026-01-03T00:00:00.000Z" })),
    unpin: ({ threadId }) => update(threadId, (thread) => ({ ...thread, pinnedAt: null })),
    setTag: ({ threadId, tagged }) =>
      update(threadId, (thread) => ({
        ...thread,
        source: { ...thread.source, tags: tagged ? [AGENT_THREAD_TAG] : [] },
      })),
  };
  const spies = new Map<unknown, CommandName>([
    [threadEnvironment.pin, "pin"],
    [threadEnvironment.unpin, "unpin"],
    [threadEnvironment.setTag, "setTag"],
  ]);
  vi.mocked(useQuietThreadShells).mockImplementation(useThreads);
  vi.mocked(useThreadShell).mockImplementation(
    (ref) => useThreads().find((thread) => thread.id === ref?.threadId) ?? null,
  );
  vi.mocked(readEnvironmentServerConfigLoaded).mockReturnValue(true);
  vi.mocked(useOrchestrationCommand).mockImplementation(((command: unknown) => {
    const name = spies.get(command);
    return async (call: {
      environmentId: EnvironmentId;
      input: { threadId: ThreadId; tagged?: boolean };
    }) => {
      if (name !== undefined) {
        sent.push({
          command: name,
          environmentId: call.environmentId,
          threadId: call.input.threadId,
          ...(call.input.tagged === undefined ? {} : { tagged: call.input.tagged }),
        });
        handlers[name](call.input);
      }
      return { _tag: "Success", value: { sequence: 1 } };
    };
  }) as never);
  return { sent };
}

const showMenu = vi.fn();

function mockApp(threads: EnvironmentThreadShell[]) {
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  vi.mocked(useProjects).mockReturnValue([activeProject]);
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "none" } as never);
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: { environmentId, projectId },
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef: null,
  });
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([
      [
        environmentId,
        {
          scratchWorkspaceRoot: null,
          shellThreadFamilies: false,
          environment: { capabilities: {} },
        } as unknown as EnvironmentServerConfig,
      ],
    ]),
  );
  showMenu.mockReset().mockResolvedValue(null);
  vi.mocked(readLocalApi).mockReturnValue({
    contextMenu: { show: showMenu, close: vi.fn() },
  } as never);
  return fakeServer(threads);
}

const sidebar = (
  <SidebarProvider>
    <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
  </SidebarProvider>
);

async function renderSidebar() {
  return render(sidebar);
}

function rowOf(container: HTMLElement, title: string) {
  return [...container.querySelectorAll<HTMLElement>("[data-sidebar-row]")].find(
    (row) => row.getAttribute("aria-label")?.includes(title) ?? false,
  );
}

async function openMenu(container: HTMLElement, title: string) {
  const row = rowOf(container, title)!;
  await act(() => {
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
  });
  await vi.waitFor(() => expect(showMenu).toHaveBeenCalled());
}

async function menuIdsFor(container: HTMLElement, title: string) {
  await openMenu(container, title);
  const items = showMenu.mock.calls.at(-1)![0] as ReadonlyArray<{ id: string }>;
  showMenu.mockClear();
  return items.map((item) => item.id);
}

describe("Agents group", () => {
  it("lists agent threads under a collapsible Agents header, out of Pinned and Active", async () => {
    using stack = new DisposableStack();
    stack.defer(() => localStorage.removeItem(AGENTS_SHELF_EXPANDED_KEY));
    mockApp([shell("plain-thread", false), shell("lead-agent", true)]);
    await using screen = await renderSidebar();
    const header = screen.container.querySelector<HTMLElement>('[data-sidebar-row="shelf:agents"]');
    expect(header?.textContent).toContain("Agents");
    expect(header?.getAttribute("aria-expanded")).toBe("true");
    const agentRow = rowOf(screen.container, "lead-agent")!;
    expect(agentRow.dataset.sidebarParent).toBe("shelf:agents");
    expect(agentRow.querySelector('[aria-label="Unpin thread"]')).toBeNull();
    expect(agentRow.querySelector('[aria-label="Settle thread"]')).toBeNull();
    expect(rowOf(screen.container, "plain-thread")?.dataset.sidebarParent).toBeUndefined();

    await userEvent.click(header!);
    expect(header!.getAttribute("aria-expanded")).toBe("false");
    expect(rowOf(screen.container, "lead-agent")).toBeUndefined();
    expect(localStorage.getItem(AGENTS_SHELF_EXPANDED_KEY)).toBe("false");
  });

  it("renders no Agents header without agents", async () => {
    mockApp([shell("plain-thread", false)]);
    await using screen = await renderSidebar();
    expect(screen.container.querySelector('[data-sidebar-row="shelf:agents"]')).toBeNull();
  });

  it("does not call a sidebar of only agents empty", async () => {
    mockApp([shell("lead-agent", true)]);
    await using screen = await renderSidebar();
    expect(rowOf(screen.container, "lead-agent")).toBeDefined();
    expect(screen.container.textContent).not.toContain("No threads yet");
  });

  it("offers Pin as agent under Pin thread, and only Unpin agent on an agent", async () => {
    mockApp([shell("plain-thread", false), shell("lead-agent", true)]);
    await using screen = await renderSidebar();
    const plainIds = await menuIdsFor(screen.container, "plain-thread");
    expect(plainIds.indexOf("agent-pin")).toBe(plainIds.indexOf("pin") + 1);
    const agentIds = await menuIdsFor(screen.container, "lead-agent");
    expect(agentIds).toContain("agent-unpin");
    for (const id of ["pin", "unpin", "agent-pin", "settle", "unsettle", "snooze", "unsnooze"]) {
      expect(agentIds).not.toContain(id);
    }
  });

  it("Pin as agent pins, then tags, and moves the thread into Agents", async () => {
    const { sent } = mockApp([shell("plain-thread", false)]);
    await using screen = await renderSidebar();
    showMenu.mockResolvedValueOnce("agent-pin");
    await openMenu(screen.container, "plain-thread");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { command: "pin", environmentId, threadId: ThreadId.make("plain-thread") },
      { command: "setTag", environmentId, threadId: ThreadId.make("plain-thread"), tagged: true },
    ]);
    await vi.waitFor(() =>
      expect(rowOf(screen.container, "plain-thread")?.dataset.sidebarParent).toBe("shelf:agents"),
    );
  });

  it("places Agents below the project folders and above Snoozed and Settled in folder mode", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({ ...previousSettings, boringSidebarEnabled: true });
    mockApp([
      shell("plain-thread", false),
      shell("lead-agent", true),
      shell("snoozed-thread", false, {
        snoozedUntil: "2099-01-01T00:00:00.000Z",
        snoozedAt: "2026-01-02T00:00:00.000Z",
      }),
      shell("settled-thread", false, {
        settledOverride: "settled",
        settledAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);
    await using screen = await renderSidebar();
    const rowIds = [...screen.container.querySelectorAll<HTMLElement>("[data-sidebar-row]")].map(
      (row) => row.dataset.sidebarRow!,
    );
    const folder = rowIds.findIndex((id) => id.startsWith("folder:"));
    const agents = rowIds.indexOf("shelf:agents");
    expect(folder).toBeGreaterThanOrEqual(0);
    expect(agents).toBeGreaterThan(folder);
    expect(rowIds.indexOf("shelf:snoozed")).toBeGreaterThan(agents);
    expect(rowIds.indexOf("shelf:settled")).toBeGreaterThan(agents);
  });
});

describe("ThreadAgentRow", () => {
  it("Unpin untags, then unpins, and returns the thread to Active", async () => {
    const agent = shell("lead-agent", true);
    const { sent } = mockApp([agent]);
    const page = (
      <>
        {sidebar}
        <ThreadAgentRow environmentId={environmentId} threadId={agent.id} />
      </>
    );
    await using screen = await render(page);
    expect(rowOf(screen.container, "lead-agent")?.dataset.sidebarParent).toBe("shelf:agents");
    await expect.element(screen.getByText("Pinned as agent")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unpin", exact: true }));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { command: "setTag", environmentId, threadId: agent.id, tagged: false },
      { command: "unpin", environmentId, threadId: agent.id },
    ]);
    await vi.waitFor(() => {
      const row = rowOf(screen.container, "lead-agent")!;
      expect(row.dataset.sidebarParent).toBeUndefined();
      expect(row.querySelector('[aria-label="Unpin thread"]')).toBeNull();
      expect(screen.container.querySelector('[data-sidebar-row="shelf:agents"]')).toBeNull();
      expect(screen.container.textContent).not.toContain("Pinned as agent");
    });
  });

  it("disables Unpin without operate access", async () => {
    const agent = shell("lead-agent", true);
    vi.mocked(useThreadShell).mockReturnValue(agent);
    vi.mocked(useEnvironmentScope).mockReturnValue(false);
    await using screen = await render(
      <ThreadAgentRow environmentId={environmentId} threadId={agent.id} />,
    );
    await expect.element(screen.getByRole("button", { name: "Unpin", exact: true })).toBeDisabled();
  });

  it("renders nothing for a plain thread", async () => {
    vi.mocked(useThreadShell).mockReturnValue(shell("plain-thread", false));
    await using screen = await render(
      <ThreadAgentRow environmentId={environmentId} threadId={ThreadId.make("plain-thread")} />,
    );
    expect(screen.container.textContent).toBe("");
  });
});
