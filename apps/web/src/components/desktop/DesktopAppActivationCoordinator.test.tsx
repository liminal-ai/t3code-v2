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

import {
  DesktopAppActivationCoordinator,
  DesktopAppActivationShellShown,
} from "./DesktopAppActivationCoordinator";

// The root route mounts the coordinator above the first-run gate, and the marker with the app
// shell inside it. Without the marker, the gate is pending or the window is on /welcome.
function Window({ appShell }: { readonly appShell: boolean }) {
  return (
    <>
      <DesktopAppActivationCoordinator />
      {appShell ? <DesktopAppActivationShellShown /> : null}
    </>
  );
}

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
  bridge.onRequest.mockClear();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
        renderer!.update(<Window appShell />);
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

  it("answers a listing while a pairing is still running", async () => {
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    await settle();
    let finishPairing: (environmentId: EnvironmentId) => void = () => undefined;
    testState.pairEnvironment.mockReturnValue(
      new Promise<EnvironmentId>((resolve) => {
        finishPairing = resolve;
      }),
    );
    testState.catalogReads = [new Map(), new Map([[dgxId, dgxEntry()]])];
    deliver!({
      version: 1,
      requestId: "pair-1",
      type: "pair-environment",
      pairingUrl: PAIRING_URL,
      force: false,
    });
    await vi.waitFor(() => expect(testState.pairEnvironment).toHaveBeenCalled());

    await expect(
      handle({ version: 1, requestId: "list-1", type: "list-environments" }),
    ).resolves.toMatchObject({ ok: true, type: "list-environments" });
    expect(bridge.complete).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "pair-1" }),
    );

    testState.catalogReads = [new Map([[dgxId, dgxEntry()]])];
    finishPairing(dgxId);
    await vi.waitFor(() =>
      expect(bridge.complete).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "pair-1", ok: true }),
      ),
    );
  });

  it.each([
    ["once", 1, [true, true]],
    ["every time", 3, [true, true, true, false]],
  ] as const)(
    "sends a result the desktop app refuses %s again, and then a failure in its place",
    async (_, refusals, sentResult) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await act(async () => {
        renderer = create(<DesktopAppActivationCoordinator />);
      });
      await settle();
      for (let refusal = 0; refusal < refusals; refusal++) {
        bridge.complete.mockRejectedValueOnce(new Error("An object could not be cloned."));
      }
      testState.catalogReads = [new Map(), new Map([[dgxId, dgxEntry()]])];
      testState.pairEnvironment.mockResolvedValue(dgxId);

      deliver!({
        version: 1,
        requestId: "pair-1",
        type: "pair-environment",
        pairingUrl: PAIRING_URL,
        force: false,
      });
      await vi.waitFor(() => expect(bridge.complete).toHaveBeenCalledTimes(sentResult.length));
      await settle();

      expect(bridge.complete.mock.calls.map(([response]) => response.ok)).toEqual(sentResult);
      if (sentResult.at(-1) === false) {
        expect(bridge.complete).toHaveBeenLastCalledWith({
          version: 1,
          requestId: "pair-1",
          ok: false,
          code: "internal-error",
          message:
            "T3 Code finished the pairing but could not report how it went, so it may have saved the environment. Run `t3 app environments` before you create a new link.",
        });
      }

      // The window still takes requests afterwards.
      testState.catalogReads = [new Map()];
      await expect(
        handle({ version: 1, requestId: "list-1", type: "list-environments" }),
      ).resolves.toMatchObject({ ok: true });
    },
  );

  it("pairs and lists before the app shell shows, and opens a workspace only once it does", async () => {
    // A new install: the local environment is up, and the first-run gate holds the app shell.
    testState.primaryEnvironment = connectedLocal;
    testState.shell = { data: { snapshot: { _tag: "Some" } } };
    await act(async () => {
      renderer = create(<Window appShell={false} />);
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
        force: false,
      }),
    ).resolves.toMatchObject({ ok: true, outcome: "paired" });
    testState.catalogReads = [new Map([[dgxId, dgxEntry()]])];
    await expect(
      handle({ version: 1, requestId: "list-1", type: "list-environments" }),
    ).resolves.toMatchObject({ ok: true, environments: [{ environmentId: dgxId }] });
    expect(bridge.setReady.mock.calls.flatMap(([accepts]) => accepts)).not.toContain(
      "open-workspace",
    );

    await act(async () => {
      renderer!.update(<Window appShell />);
    });
    await settle();
    expect(bridge.setReady).toHaveBeenLastCalledWith([
      "open-workspace",
      "pair-environment",
      "list-environments",
    ]);

    // Back on /welcome, the app shell is gone again, and so is open-workspace.
    await act(async () => {
      renderer!.update(<Window appShell={false} />);
    });
    await settle();
    expect(bridge.setReady).toHaveBeenLastCalledWith(["pair-environment", "list-environments"]);
    expect(bridge.setReady).not.toHaveBeenCalledWith([]);
    expect(bridge.onRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps its subscription when the local environment disconnects", async () => {
    testState.primaryEnvironment = connectedLocal;
    testState.shell = { data: { snapshot: { _tag: "Some" } } };
    await act(async () => {
      renderer = create(<Window appShell />);
    });
    await settle();
    expect(bridge.setReady).toHaveBeenLastCalledWith([
      "open-workspace",
      "pair-environment",
      "list-environments",
    ]);

    testState.primaryEnvironment = { ...connectedLocal, connection: { phase: "reconnecting" } };
    await act(async () => {
      renderer!.update(<Window appShell />);
    });
    await settle();

    expect(bridge.setReady).toHaveBeenLastCalledWith(["pair-environment", "list-environments"]);
    expect(bridge.setReady).not.toHaveBeenCalledWith([]);
    expect(deliver).not.toBeNull();
  });
});
