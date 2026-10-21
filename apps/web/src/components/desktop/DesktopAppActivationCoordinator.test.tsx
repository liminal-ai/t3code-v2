import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DesktopAppActivationRequest,
  type DesktopAppActivationRequestType,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const localId = EnvironmentId.make("environment-local");
const dgxId = EnvironmentId.make("environment-dgx");

const testState = vi.hoisted(() => ({
  primaryEnvironment: null as unknown,
  shell: { data: undefined } as unknown,
  catalogReads: [] as Array<ReadonlyMap<string, unknown>>,
  pairEnvironment: vi.fn(),
  openThread: vi.fn(),
  commands: {
    createProject: Symbol("createProject"),
    connectPairing: Symbol("connectPairing"),
    readCatalogEntries: Symbol("readCatalogEntries"),
  },
}));

vi.mock("../../connection/catalog", () => ({
  readEnvironmentCatalogEntries: testState.commands.readCatalogEntries,
}));
vi.mock("../../connection/onboarding", () => ({
  connectPairing: testState.commands.connectPairing,
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => testState.openThread,
}));
vi.mock("../../lib/projectPaths", () => ({
  findProjectByPath: (projects: ReadonlyArray<{ workspaceRoot: string }>, root: string) =>
    projects.find((project) => project.workspaceRoot === root),
  inferProjectTitleFromPath: (root: string) => root,
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => undefined } }));
vi.mock("../../state/entities", () => ({
  readProjects: () => [
    { id: ProjectId.make("project-1"), environmentId: localId, workspaceRoot: "/work/app" },
  ],
  waitForProject: async () => undefined,
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => testState.primaryEnvironment,
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => Symbol("presentation") },
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { create: testState.commands.createProject },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => testState.shell }));
vi.mock("../../state/shell", () => ({
  environmentShell: { stateAtom: () => Symbol("shell") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) => {
    switch (command) {
      case testState.commands.connectPairing:
        return async (input: unknown) => ({
          _tag: "Success",
          value: await testState.pairEnvironment(input),
        });
      case testState.commands.readCatalogEntries:
        return async () => ({
          _tag: "Success",
          value: testState.catalogReads.shift() ?? new Map(),
        });
      default:
        return async () => ({ _tag: "Success", value: undefined });
    }
  },
}));

import { DesktopAppActivationCoordinator } from "./DesktopAppActivationCoordinator";

const PAIRING_URL = "https://dgx-01.example.ts.net/pair#token=pairing-token";

function dgxEntry(): ConnectionCatalogEntry {
  const connectionId = "bearer:environment-dgx";
  return {
    target: new BearerConnectionTarget({ environmentId: dgxId, label: "dgx-01", connectionId }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId: dgxId,
        label: "dgx-01",
        httpBaseUrl: "https://dgx-01.example.ts.net/",
        wsBaseUrl: "wss://dgx-01.example.ts.net/",
      }),
    ),
    enabled: true,
  };
}

const connectedLocal = {
  environmentId: localId,
  connection: { phase: "connected" },
  serverConfig: { environment: { platform: { os: "linux" } } },
};

let renderer: ReactTestRenderer | null = null;
let deliver: ((request: DesktopAppActivationRequest) => void) | null = null;
const bridge = {
  setReady: vi.fn(async (_accepts: ReadonlyArray<DesktopAppActivationRequestType>) => undefined),
  complete: vi.fn(async (_response: DesktopAppActivationResponse) => undefined),
  onRequest: vi.fn((listener: (request: DesktopAppActivationRequest) => void) => {
    deliver = listener;
    return () => {
      deliver = null;
    };
  }),
};

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
  });
}

async function handle(request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> {
  expect(deliver).not.toBeNull();
  deliver!(request);
  await vi.waitFor(() =>
    expect(bridge.complete).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: request.requestId }),
    ),
  );
  return bridge.complete.mock.calls.find(
    ([response]) => response.requestId === request.requestId,
  )![0];
}

beforeEach(() => {
  vi.stubGlobal("window", { desktopBridge: { appActivation: bridge } });
  testState.primaryEnvironment = null;
  testState.shell = { data: undefined };
  testState.catalogReads = [];
  testState.pairEnvironment.mockReset();
  testState.openThread.mockReset();
  bridge.setReady.mockClear();
  bridge.complete.mockClear();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("DesktopAppActivationCoordinator", () => {
  it.each([
    ["no local environment", null],
    [
      "a local environment that is not connected",
      { environmentId: localId, connection: { phase: "offline" }, serverConfig: null },
    ],
  ])(
    "pairs and lists with %s, and defers opening a workspace until it connects",
    async (_, primaryEnvironment) => {
      testState.primaryEnvironment = primaryEnvironment;
      await act(async () => {
        renderer = create(<DesktopAppActivationCoordinator />);
      });
      await settle();

      expect(bridge.setReady).toHaveBeenLastCalledWith(["pair-environment", "list-environments"]);

      testState.catalogReads = [new Map(), new Map([[dgxId, dgxEntry()]])];
      testState.pairEnvironment.mockResolvedValue(dgxId);
      await expect(
        handle({
          version: 1,
          requestId: "pair-1",
          type: "pair-environment",
          pairingUrl: PAIRING_URL,
          label: "dgx-01",
          force: false,
        }),
      ).resolves.toMatchObject({
        ok: true,
        type: "pair-environment",
        outcome: "paired",
        environment: { environmentId: dgxId, label: "dgx-01" },
      });
      expect(testState.pairEnvironment).toHaveBeenCalledWith({
        pairingUrl: PAIRING_URL,
        label: "dgx-01",
      });

      testState.catalogReads = [new Map([[dgxId, dgxEntry()]])];
      await expect(
        handle({ version: 1, requestId: "list-1", type: "list-environments" }),
      ).resolves.toMatchObject({
        ok: true,
        type: "list-environments",
        environments: [{ environmentId: dgxId }],
      });

      // The desktop app holds open-workspace until the window says it can take it.
      expect(bridge.setReady.mock.calls.flatMap(([accepts]) => accepts)).not.toContain(
        "open-workspace",
      );

      testState.primaryEnvironment = connectedLocal;
      testState.shell = { data: { snapshot: { _tag: "Some" } } };
      await act(async () => {
        renderer!.update(<DesktopAppActivationCoordinator />);
      });
      await settle();

      expect(bridge.setReady).toHaveBeenLastCalledWith([
        "open-workspace",
        "pair-environment",
        "list-environments",
      ]);
      testState.openThread.mockResolvedValue({ threadId: ThreadId.make("thread-1") });
      await expect(
        handle({
          version: 1,
          requestId: "open-1",
          type: "open-workspace",
          workspaceRoot: "/work/app",
          platform: "linux",
        }),
      ).resolves.toMatchObject({ ok: true, projectId: "project-1", threadId: "thread-1" });
    },
  );

  it("keeps its subscription when the local environment disconnects", async () => {
    testState.primaryEnvironment = connectedLocal;
    testState.shell = { data: { snapshot: { _tag: "Some" } } };
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    await settle();
    expect(bridge.setReady).toHaveBeenLastCalledWith([
      "open-workspace",
      "pair-environment",
      "list-environments",
    ]);

    testState.primaryEnvironment = { ...connectedLocal, connection: { phase: "reconnecting" } };
    await act(async () => {
      renderer!.update(<DesktopAppActivationCoordinator />);
    });
    await settle();

    expect(bridge.setReady).toHaveBeenLastCalledWith(["pair-environment", "list-environments"]);
    expect(bridge.setReady).not.toHaveBeenCalledWith([]);
    expect(deliver).not.toBeNull();
  });
});
