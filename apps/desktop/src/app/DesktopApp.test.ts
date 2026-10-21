// @effect-diagnostics nodeBuiltinImport:off -- This test connects to the real control socket the bootstrap opens.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as NetService from "@t3tools/shared/Net";
import { vi } from "vite-plus/test";

vi.mock("../ipc/DesktopIpcHandlers.ts", async () => {
  const Effect = await import("effect/Effect");
  return { installDesktopIpcHandlers: () => Effect.void };
});

import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import * as BrowserImport from "../preview/BrowserImport/BrowserImport.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import { bootstrap } from "./DesktopApp.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

// The local backend and the IPC handlers' services. With the local environment off and the
// handlers mocked out, bootstrap reaches none of them, so any use fails the test.
const unreachedServices = Layer.mergeAll(
  Layer.mock(BrowserImport.BrowserImport, {}),
  Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration, {}),
  Layer.mock(DesktopBackendPool.DesktopBackendPool, {}),
  Layer.mock(DesktopCliCommand.DesktopCliCommand, {}),
  Layer.mock(DesktopClientSettings.DesktopClientSettings, {}),
  Layer.mock(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, {}),
  Layer.mock(DesktopIpc.DesktopIpc, {}),
  Layer.mock(DesktopLifecycle.DesktopLifecycle, {}),
  Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {}),
  Layer.mock(DesktopServerExposure.DesktopServerExposure, {}),
  Layer.mock(DesktopShutdown.DesktopShutdown, {}),
  Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment, {}),
  Layer.mock(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {}),
  Layer.mock(DesktopUpdates.DesktopUpdates, {}),
  Layer.mock(DesktopWebLinks.DesktopWebLinks, {}),
  Layer.mock(DesktopWslBackend.DesktopWslBackend, {}),
  Layer.mock(DesktopWslEnvironment.DesktopWslEnvironment, {}),
  Layer.mock(ElectronApp.ElectronApp, {}),
  Layer.mock(ElectronDialog.ElectronDialog, {}),
  Layer.mock(ElectronMenu.ElectronMenu, {}),
  Layer.mock(ElectronShell.ElectronShell, {}),
  Layer.mock(ElectronTheme.ElectronTheme, {}),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("unreached")),
  ),
  Layer.mock(MacPermissions.MacPermissions, {}),
  Layer.mock(NetService.NetService, {}),
  Layer.mock(PreviewManager.PreviewManager, {
    isBrowserPartition: () => assert.fail("unreached"),
  }),
);

function exchange(address: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk) => (response += chunk));
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

describe("DesktopApp bootstrap", () => {
  it.effect("answers on the control socket with the local environment switched off", () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bootstrap-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const platform = yield* HostProcess.Platform;
      let mainWindowRequests = 0;

      const environmentLayer = DesktopEnvironment.layer({
        dirname: NodePath.join(home, "app", "dist-electron"),
        homeDirectory: home,
        platform,
        processArch: yield* HostProcess.Architecture,
        appVersion: "1.2.3",
        appPath: NodePath.join(home, "app"),
        isPackaged: true,
        resourcesPath: NodePath.join(home, "app", "resources"),
        runningUnderArm64Translation: false,
      }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));
      const windowLayer = Layer.mergeAll(
        Layer.mock(DesktopWindow.DesktopWindow, {
          activate: Effect.void,
          createMainIfBackendReady: Effect.sync(() => {
            mainWindowRequests += 1;
          }),
        }),
        Layer.mock(ElectronWindow.ElectronWindow, { main: Effect.succeedNone }),
      );
      const layer = Layer.mergeAll(
        DesktopAppActivation.layer.pipe(Layer.provide(windowLayer)),
        windowLayer,
        DesktopState.layer,
        DesktopAppSettings.layerTest({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          localEnvironmentEnabled: false,
        }),
        Layer.mock(DesktopSnapShot.DesktopSnapShot, { initialize: Effect.void }),
        Layer.mock(ElectronProtocol.ElectronProtocol, {
          registerDesktopProtocol: () => Effect.void,
        }),
        Layer.mock(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage, {
          load: () => Effect.void,
        }),
        Layer.mock(DesktopAppIdentity.DesktopAppIdentity, {
          resolveUserDataPath: Effect.succeed(NodePath.join(home, "userdata")),
        }),
        unreachedServices,
      ).pipe(Layer.provideMerge(environmentLayer), Layer.provideMerge(NodeServices.layer));

      const address = yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return resolveDesktopAppControlAddress({
          stateDir: NodePath.resolve(environment.stateDir),
          platform: environment.platform,
          tempDir: NodeOS.tmpdir(),
          userId: yield* HostProcess.UserId,
          joinPath: NodePath.join,
        }).address;
      }).pipe(Effect.provide(environmentLayer));

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* bootstrap;
          assert.equal(mainWindowRequests, 1);

          const response = JSON.parse(yield* Effect.promise(() => exchange(address, "not json")));
          assert.equal(response.ok, false);
          assert.equal(response.code, "invalid-request");
        }).pipe(Effect.provide(layer)),
      );

      if (platform !== "win32") {
        const left = yield* Effect.promise(() =>
          NodeFSP.lstat(address).then(
            () => true,
            () => false,
          ),
        );
        assert.isFalse(left, "the socket closes with the app");
      }
    }).pipe(Effect.scoped),
  );
});
