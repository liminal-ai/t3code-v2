import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import Sidebar from "../components/Sidebar";
import { SidebarProvider } from "../components/ui/sidebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { readLocalApi } from "../localApi";
import {
  useProjects,
  useQuietThreadShells,
  useServerConfigs,
  useThreadShell,
} from "../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
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

function shell(id: string, agent: boolean): EnvironmentThreadShell {
  const base = makeThreadFixture({
    environmentId,
    projectId,
    id: ThreadId.make(id),
    title: id,
  });
  return agent
    ? {
        ...base,
        pinnedAt: "2026-01-02T00:00:00.000Z",
        source: { ...base.source, tags: [AGENT_THREAD_TAG] },
      }
    : base;
}

const showMenu = vi.fn();

function mockApp(threads: EnvironmentThreadShell[]) {
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  vi.mocked(useProjects).mockReturnValue([activeProject]);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
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
}

async function renderSidebar() {
  return render(
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
  );
}

function rowOf(container: HTMLElement, title: string) {
  return [...container.querySelectorAll<HTMLElement>("[data-sidebar-row]")].find(
    (row) => row.getAttribute("aria-label")?.includes(title) ?? false,
  );
}

async function menuIdsFor(container: HTMLElement, title: string) {
  const row = rowOf(container, title)!;
  await act(() => {
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
  });
  await vi.waitFor(() => expect(showMenu).toHaveBeenCalled());
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
    expect(agentRow.dataset.testid).toBe("sidebar-row-slim");
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
});

describe("ThreadAgentRow", () => {
  it("shows Pinned as agent and unpins before untagging", async () => {
    const agent = shell("lead-agent", true);
    vi.mocked(useThreadShell).mockReturnValue(agent);
    vi.mocked(readEnvironmentScope).mockReturnValue(true);
    const dispatch = vi.fn().mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
    vi.mocked(useOrchestrationCommand).mockReturnValue(dispatch);
    await using screen = await render(
      <ThreadAgentRow environmentId={environmentId} threadId={agent.id} />,
    );
    await expect.element(screen.getByText("Pinned as agent")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unpin", exact: true }));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch.mock.calls.map(([call]) => call.input)).toEqual([
      { threadId: agent.id },
      { threadId: agent.id, tag: AGENT_THREAD_TAG, tagged: false },
    ]);
  });

  it("renders nothing for a plain thread", async () => {
    vi.mocked(useThreadShell).mockReturnValue(shell("plain-thread", false));
    await using screen = await render(
      <ThreadAgentRow environmentId={environmentId} threadId={ThreadId.make("plain-thread")} />,
    );
    expect(screen.container.textContent).toBe("");
  });
});
