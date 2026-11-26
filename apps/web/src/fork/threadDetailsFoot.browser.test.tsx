import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  /** The thread runs on a Limbase instance and is pinned as an agent. */
  limbaseAgent: false,
  showContext: false,
}));

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProject: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "project",
          environmentId: "environment",
          title: "plain",
          workspaceRoot: "/work/plain",
          scripts: [],
        }) as never,
  useProjects: (() => []) as never,
  useQuietThreadShell: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "thread",
          environmentId: "environment",
          projectId: "project",
          worktreePath: "/work/plain",
          branch: null,
          pullRequests: [],
        }) as never,
  useServerConfigs: (() =>
    new Map([
      [
        EnvironmentId.make("environment"),
        {
          scratchWorkspaceRoot: "/home/user/.t3/scratch",
          environment: { capabilities: { pullRequests: true } },
        },
      ],
    ])) as never,
}));
vi.mock(import("~/state/vcs"), async (importOriginal) => {
  const actual = await importOriginal();
  const notARepo = Atom.make(
    AsyncResult.success({
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    }),
  );
  return {
    ...actual,
    vcsEnvironment: { ...actual.vcsEnvironment, status: (() => notARepo) as never },
  };
});
vi.mock(import("~/hooks/useSettings"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useClientSettings: ((selector: (settings: unknown) => unknown) =>
      selector({
        threadDetailsItems: state.showContext ? { context: true } : {},
        threadDetailsUsageEnabled: false,
      })) as never,
  };
});
// Automations and lineage hold their own data; stand-ins of their size are enough to see whether
// the card shows them, and carry the markers the card's measure reads.
vi.mock(import("~/components/chat/ThreadAutomationsPanel"), async () => {
  const { ThreadDetailsSection } = await import("~/components/chat/ThreadDetailsSection");
  return {
    ThreadAutomationsPanel: () => (
      <ThreadDetailsSection
        headingId="automations-heading"
        title="Automations"
        data-thread-automations-panel
      >
        <div style={{ height: 96 }}>Release checklist</div>
      </ThreadDetailsSection>
    ),
  };
});
vi.mock(import("~/components/chat/ThreadRelationshipsControl"), async (importOriginal) => {
  const { ThreadDetailsSection } = await import("~/components/chat/ThreadDetailsSection");
  return {
    ...(await importOriginal()),
    ThreadRelationshipsPanel: () => (
      <ThreadDetailsSection
        headingId="lineage-heading"
        title="Lineage"
        showHeading={false}
        data-thread-relationships-panel
      >
        <div style={{ height: 32 }}>Previous agents</div>
      </ThreadDetailsSection>
    ),
  };
});
// The rows' own behavior has its own tests; here they only take the room they take in the app.
vi.mock(import("./threadSettings/LimbaseCompactionRow"), () => ({
  LimbaseCompactionRow: () =>
    state.limbaseAgent ? <div style={{ height: 24 }}>Limbase compaction</div> : null,
}));
vi.mock(import("./ThreadAgentRow"), () => ({
  ThreadAgentRow: () =>
    state.limbaseAgent ? <div style={{ height: 30 }}>Pinned as agent</div> : null,
}));

import { render } from "../../test/render";
import { ChatCanvasContext } from "../components/chat/ChatCanvasContext";
import { resolveChatCanvasLayout } from "../components/chat/chatCanvasLayout";
import { ThreadDetailsPanel } from "../components/chat/ThreadDetailsPanel";
import { PopoverCreateHandle } from "../components/ui/popover";
import { useRightPanelStore } from "../rightPanelStore";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const container = { width: 1200, height: 2000 };
const handle = PopoverCreateHandle();
const anchor = { current: document.createElement("div") };

function Panel({ height }: { height: number }) {
  const noop = () => {};
  const scriptResult = async () => ({ ok: true }) as never;
  const placement = { x: 908, y: 0, right: 12, width: 280, height } as const;
  return (
    <ChatCanvasContext
      value={{
        container,
        lane: { padding: 48, minChatWidth: 640 },
        layout: resolveChatCanvasLayout({ container, preview: null }),
        previewKey: null,
        registerTimeline: noop,
        measureDetailsCard: noop,
        detailsCardTopInset: 0,
        preferredDetailsCard: placement,
        detailsCardPlacement: placement,
      }}
    >
      <ThreadDetailsPanel
        anchor={anchor}
        handle={handle}
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        projectId={ProjectId.make("project")}
        composerDraftTarget={threadRef}
        worktreePath="/work/plain"
        isServerThread
        activeProjectName="plain"
        activeProjectScripts={[]}
        preferredScriptId={null}
        keybindings={[]}
        availableEditors={[]}
        showOpenInPicker={false}
        openInShortcutEnabled={false}
        gitCwd="/work/plain"
        workspaceMutationId={null}
        isGitRepo={false}
        offersWorkspaceModes={false}
        envLocked
        availableEnvironments={[]}
        onEnvModeChange={noop}
        envMode="local"
        startFromOrigin={false}
        onStartFromOriginChange={noop}
        onComposerFocusRequest={noop}
        onRunProjectScript={noop}
        onAddProjectScript={scriptResult}
        onUpdateProjectScript={scriptResult}
        onDeleteProjectScript={scriptResult}
        usage={
          {
            providerInstanceId: null,
            model: null,
            providers: [],
            sources: {},
            contextWindow: {
              usedTokens: 51_000,
              maxTokens: 1_000_000,
              usedPercentage: 5.1,
              autoCompactThreshold: null,
            },
          } as never
        }
      />
    </ChatCanvasContext>
  );
}

const card = () => page.getByRole("region", { name: "Thread details" });

/**
 * The shortest card at which the plain thread stays at full density. The card leaves the
 * automations and lineage lists out of that measure, so they scroll on a card this short.
 */
async function plainFullHeight() {
  state.limbaseAgent = false;
  await using _screen = await render(<Panel height={2000} />);
  await expect.element(card()).toHaveAttribute("data-density", "full");
  await expect.element(page.getByText("Previous agents")).toBeInTheDocument();
  const lists = document.querySelectorAll<HTMLElement>(
    "[data-thread-automations-panel], [data-thread-relationships-panel]",
  );
  const listsHeight = [...lists].reduce((sum, list) => sum + list.offsetHeight, 0);
  return (
    document.querySelector<HTMLElement>("[data-thread-details-card]")!.offsetHeight - listsHeight
  );
}

describe.each([
  { context: "off", showContext: false },
  { context: "on", showContext: true },
])("with the context row $context", ({ showContext }) => {
  it("keeps a Limbase agent thread's card at full density wherever a plain thread's is full", async () => {
    useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
    state.showContext = showContext;
    const height = await plainFullHeight();

    state.limbaseAgent = false;
    {
      await using _screen = await render(<Panel height={height} />);
      await expect.element(card()).toHaveAttribute("data-density", "full");
    }

    state.limbaseAgent = true;
    await using _screen = await render(<Panel height={height} />);
    await expect.element(page.getByText("Limbase compaction")).toBeInTheDocument();
    await expect.element(page.getByText("Pinned as agent")).toBeInTheDocument();
    await expect.element(card()).toHaveAttribute("data-density", "full");
    await expect.element(page.getByRole("region", { name: "Automations" })).toBeInTheDocument();
    await expect.element(page.getByText("Previous agents")).toBeInTheDocument();
    // The fork's rows come last, so on a card this short they are what scrolls out of view.
    const rows = [...document.querySelectorAll<HTMLElement>("[data-thread-details-card] *")];
    const previous = rows.find((element) => element.textContent === "Previous agents")!;
    const compaction = rows.find((element) => element.textContent === "Limbase compaction")!;
    expect(
      previous.compareDocumentPosition(compaction) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
