import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "../hooks/useThreadActions";
import { useThreadUndoNotice } from "../hooks/showThreadUndoNotice";
import { threadEnvironment } from "../state/threads";
import { AGENT_THREAD_TAG } from "./agentThreads";
import { useAgentPin } from "./useAgentPin";

const commands = vi.hoisted(() => ({
  pin: vi.fn(),
  unpin: vi.fn(),
  setTag: vi.fn(),
  settle: vi.fn(),
  unsettle: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn(), state: { location: { href: "/" }, matches: [] } }),
}));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => false }));
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/announce", () => ({ announce: vi.fn(), cancelAnnouncement: vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
const threadShell = vi.hoisted(() => ({
  title: "Thread",
  pinOrderKey: null,
  pinnedAt: null,
  snoozedUntil: null,
  projectId: "project",
  environmentId: "agent-env",
  session: null,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentServerConfigLoaded: () => true,
  readThreadShell: () => threadShell,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    switch (command) {
      case threadEnvironment.pin:
        return commands.pin;
      case threadEnvironment.unpin:
        return commands.unpin;
      case threadEnvironment.setTag:
        return commands.setTag;
      case threadEnvironment.settle:
        return commands.settle;
      case threadEnvironment.unsettle:
        return commands.unsettle;
      case threadEnvironment.snooze:
        return commands.snooze;
      case threadEnvironment.unsnooze:
        return commands.unsnooze;
      default:
        return vi.fn();
    }
  },
}));

const target = {
  environmentId: EnvironmentId.make("agent-env"),
  threadId: ThreadId.make("thread"),
};

function currentUndo() {
  const notice = useThreadUndoNotice.getState().notice;
  expect(notice).not.toBeNull();
  return notice!.undo;
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const command of Object.values(commands)) {
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  }
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Pin as agent", () => {
  it.each([
    ["settled", (actions: ReturnType<typeof useThreadActions>) => actions.settleThread(target)],
    [
      "snoozed",
      (actions: ReturnType<typeof useThreadActions>) =>
        actions.snoozeThread(target, "2099-01-01T09:00:00.000Z"),
    ],
  ] as const)("expires the Undo of a thread just %s", async (_state, act) => {
    await act(useThreadActions());
    const staleUndo = currentUndo();
    await useAgentPin().pinAsAgent(target);
    for (const command of Object.values(commands)) command.mockClear();
    await staleUndo();
    for (const command of Object.values(commands)) expect(command).not.toHaveBeenCalled();
  });

  it("pins, then tags", async () => {
    await useAgentPin().pinAsAgent(target);
    expect(commands.setTag).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, tag: AGENT_THREAD_TAG, tagged: true },
    });
    expect(commands.pin.mock.invocationCallOrder[0]).toBeLessThan(
      commands.setTag.mock.invocationCallOrder[0]!,
    );
  });

  it("does not tag a thread it failed to pin", async () => {
    commands.pin.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("down"))));
    await useAgentPin().pinAsAgent(target);
    expect(commands.setTag).not.toHaveBeenCalled();
  });
});
