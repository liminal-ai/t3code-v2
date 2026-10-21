// @effect-diagnostics nodeBuiltinImport:off -- The integration fixture binds the same platform socket or named pipe as the CLI.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";
import { describe, expect } from "vite-plus/test";

import { makeCli } from "../binCli.ts";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";

const encodeRuntimeState = Schema.encodeEffect(Schema.fromJsonString(PersistedServerRuntimeState));

const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Command.runWith(makeCli(), { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );

const pathExists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.stat(path).then(
      () => true,
      () => false,
    ),
  );

const PAIRING_URL = "https://dgx-01.example.ts.net/pair#token=pairing-token";

const dgxEnvironment = {
  environmentId: "environment-dgx",
  label: "dgx-01",
  kind: "remote",
  httpBaseUrl: "https://dgx-01.example.ts.net/",
  enabled: true,
  connection: "connecting",
} as const;

const localEnvironment = {
  environmentId: "environment-local",
  label: "This Mac",
  kind: "local",
  httpBaseUrl: "http://127.0.0.1:3773/",
  enabled: true,
  connection: "connected",
} as const;

async function startFakeDesktop(input: {
  readonly baseDir: string;
  readonly stateSubdirectory?: "userdata" | "dev";
  readonly platform: NodeJS.Platform;
  readonly userId: number | undefined;
  readonly reply?: (request: DesktopAppActivationRequest) => unknown;
}) {
  const target = resolveDesktopAppControlAddress({
    stateDir: NodePath.join(input.baseDir, input.stateSubdirectory ?? "userdata"),
    platform: input.platform,
    tempDir: NodeOS.tmpdir(),
    userId: input.userId,
    joinPath: NodePath.join,
  });
  if (target.directory !== null) {
    await NodeFSP.mkdir(target.directory, { recursive: true, mode: 0o700 });
    await NodeFSP.unlink(target.address).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  const received: DesktopAppActivationRequest[] = [];
  const server = NodeNet.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as DesktopAppActivationRequest;
      received.push(request);
      const response = input.reply
        ? input.reply(request)
        : request.type === "open-workspace"
          ? {
              version: 1,
              requestId: request.requestId,
              ok: true,
              projectId: "project-1",
              threadId: `thread-${received.length}`,
            }
          : request.type === "pair-environment"
            ? {
                version: 1,
                requestId: request.requestId,
                ok: true,
                type: "pair-environment",
                outcome: "paired",
                environment: { ...dgxEnvironment, label: request.label ?? dgxEnvironment.label },
              }
            : {
                version: 1,
                requestId: request.requestId,
                ok: true,
                type: "list-environments",
                environments: [localEnvironment, dgxEnvironment],
              };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(target.address, resolve);
  });

  return {
    received,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (target.directory !== null) {
        await NodeFSP.unlink(target.address).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

const fakeDesktop = Effect.fn(function* (
  input: Omit<Parameters<typeof startFakeDesktop>[0], "platform" | "userId">,
) {
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  return yield* Effect.acquireRelease(
    Effect.promise(() => startFakeDesktop({ ...input, platform, userId })),
    (server) => Effect.promise(() => server.close()),
  );
});

const withTempDirectory = <A, E, R>(
  prefix: string,
  use: (root: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))),
    use,
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );

describe("t3 server command safety", () => {
  it.effect("rejects unknown command words without creating a home or project", () =>
    withTempDirectory("t3-cli-unknown-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        for (const word of [
          "account",
          "login",
          "clients",
          "conenct",
          "package.json",
          "C:new-project",
        ]) {
          const error = yield* runCli([word, "--base-dir", baseDir]).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.flip,
          );
          expect(String(error)).toContain(`Unknown command "${word}"`);
          expect(yield* pathExists(word)).toBe(word === "package.json");
          expect(yield* pathExists(baseDir)).toBe(false);
        }
      }),
    ),
  );

  it.effect("shows help without creating state", () =>
    withTempDirectory("t3-cli-help-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        const help = yield* runCli(["help"], { T3CODE_HOME: baseDir }).pipe(Effect.flip);
        expect(help).toMatchObject({ _tag: "ShowHelp", commandPath: ["t3"], errors: [] });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("refuses manual startup over a live server before creating directories", () =>
    withTempDirectory("t3-cli-running-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        const stateDir = NodePath.join(baseDir, "userdata");
        const statePath = NodePath.join(stateDir, "server-runtime.json");
        const record = yield* encodeRuntimeState({
          version: 1,
          pid: process.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-10-01T00:00:00.000Z",
          serviceManaged: true,
        });
        yield* Effect.promise(() => NodeFSP.mkdir(stateDir, { recursive: true }));
        yield* Effect.promise(() => NodeFSP.writeFile(statePath, record));
        const newDirectory = NodePath.join(root, "new-project");
        const platform = yield* HostProcess.Platform;
        for (const args of [
          [],
          ["start"],
          ["."],
          ["node_modules"],
          ["C:new-project"],
          [newDirectory],
          ["start", newDirectory],
        ]) {
          const error = yield* runCli(args, { T3CODE_HOME: baseDir }).pipe(
            Effect.provideService(
              HostProcess.Platform,
              args[0] === "C:new-project" ? "win32" : platform,
            ),
            Effect.flip,
          );
          expect(String(error)).toContain("A T3 Code server is already running");
          expect(yield* Effect.promise(() => NodeFSP.readFile(statePath, "utf8"))).toBe(record);
          expect(yield* pathExists(newDirectory)).toBe(false);
          expect(yield* Effect.promise(() => NodeFSP.readdir(stateDir))).toEqual([
            "server-runtime.json",
          ]);
        }
      }),
    ),
  );
});

describe("t3 app", () => {
  it.effect("rejects SSH before it tries to reach a desktop app", () =>
    withTempDirectory("t3-app-ssh-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "missing-t3-home");
        const error = yield* runCli(["app", "--base-dir", baseDir], {
          SSH_CONNECTION: "client server",
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DesktopAppSshUnsupportedError",
          message:
            "`t3 app` only controls a desktop app on the same machine. It cannot run over SSH. To set up the machine you are logged into from a script, pass --allow-ssh.",
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("rejects unsupported platforms without creating state", () =>
    withTempDirectory("t3-app-platform-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "missing-t3-home");
        const error = yield* runCli(["app", "--base-dir", baseDir]).pipe(
          Effect.provideService(HostProcess.Platform, "freebsd"),
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "DesktopAppPlatformUnsupportedError",
          platform: "freebsd",
          message: "`t3 app` is not supported on freebsd.",
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("does not create state when only a server or no desktop app is running", () =>
    withTempDirectory("t3-app-missing-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "missing-t3-home");
        const error = yield* runCli(["app", "--base-dir", baseDir]).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DesktopAppUnreachableError",
          candidateAddresses: [expect.any(String)],
          workspaceRoot: yield* HostProcess.WorkingDirectory,
          message: expect.stringContaining("Could not reach the T3 Code desktop app."),
          cause: { code: "ENOENT" },
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("uses T3CODE_HOME or --base-dir and sends the default or explicit path", () =>
    withTempDirectory("t3-app-command-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        const explicitPath = NodePath.join(root, "project");
        const platform = yield* HostProcess.Platform;
        const workingDirectory = yield* HostProcess.WorkingDirectory;
        const desktop = yield* fakeDesktop({ baseDir });

        yield* runCli(["app"], { T3CODE_HOME: baseDir });
        yield* runCli(["app", explicitPath, "--base-dir", baseDir]);

        expect(desktop.received).toMatchObject([
          { type: "open-workspace", workspaceRoot: workingDirectory, platform },
          { type: "open-workspace", workspaceRoot: explicitPath, platform },
        ]);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("prefers the installed desktop app when a dev desktop is also running", () =>
    withTempDirectory("t3-app-preferred-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, ".t3");
        const desktop = yield* fakeDesktop({ baseDir });
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        yield* runCli(["app"]);

        expect(desktop.received).toHaveLength(1);
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect("finds the dev desktop when the default desktop socket is absent", () =>
    withTempDirectory("t3-app-dev-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, ".t3");
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        yield* runCli(["app"]);
        yield* runCli(["app"], { T3CODE_HOME: "   " });

        expect(development.received).toHaveLength(2);
        expect(yield* pathExists(baseDir)).toBe(false);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect("never searches a dev state directory for an explicit T3 home", () =>
    withTempDirectory("t3-app-explicit-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, ".t3");
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        const flagError = yield* runCli(["app", "--base-dir", baseDir]).pipe(Effect.flip);
        const envError = yield* runCli(["app"], { T3CODE_HOME: baseDir }).pipe(Effect.flip);

        expect(flagError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(envError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
    ),
  );

  it.effect.each(["failure", "invalid"] as const)(
    "never falls back after the default desktop sends a %s response",
    (responseKind) =>
      withTempDirectory("t3-app-response-test-", (root) =>
        Effect.gen(function* () {
          const baseDir = NodePath.join(root, ".t3");
          const desktop = yield* fakeDesktop({
            baseDir,
            reply: (request) =>
              responseKind === "failure"
                ? {
                    version: 1,
                    requestId: request.requestId,
                    ok: false,
                    code: "project-create-failed",
                    message: "The project path is not available.",
                  }
                : { invalid: true },
          });
          const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

          const error = yield* runCli(["app"]).pipe(Effect.flip);

          expect(desktop.received).toHaveLength(1);
          expect(development.received).toHaveLength(0);
          if (responseKind === "failure") {
            expect(error).toMatchObject({
              _tag: "DesktopAppRequestFailedError",
              code: "project-create-failed",
              requestId: desktop.received[0]?.requestId,
              workspaceRoot: yield* HostProcess.WorkingDirectory,
              message: expect.stringContaining("project-create-failed"),
              cause: {
                ok: false,
                code: "project-create-failed",
                message: "The project path is not available.",
              },
            });
          } else {
            expect(error).toMatchObject({
              _tag: "DesktopAppUnreachableError",
              cause: { message: "The desktop app response is invalid." },
            });
          }
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, root), Effect.scoped),
      ),
  );

  it.effect("runs under SSH when --allow-ssh or T3_APP_ALLOW_SSH=1 is set", () =>
    withTempDirectory("t3-app-allow-ssh-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        const desktop = yield* fakeDesktop({ baseDir });
        const ssh = {
          T3CODE_HOME: baseDir,
          SSH_CONNECTION: "client server",
          SSH_TTY: "/dev/pts/1",
        };

        yield* runCli(["app", "--allow-ssh"], ssh);
        yield* runCli(["app"], { ...ssh, T3_APP_ALLOW_SSH: "1" });
        const refused = yield* runCli(["app"], { ...ssh, T3_APP_ALLOW_SSH: "0" }).pipe(Effect.flip);

        expect(desktop.received).toHaveLength(2);
        expect(refused).toMatchObject({ _tag: "DesktopAppSshUnsupportedError" });
      }).pipe(Effect.scoped),
    ),
  );
});

describe("t3 app pair", () => {
  it.effect("sends the link, label and --force to the app and prints the outcome", () =>
    withTempDirectory("t3-app-pair-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        const desktop = yield* fakeDesktop({ baseDir });

        yield* runCli(["app", "pair", PAIRING_URL, "--base-dir", baseDir]);
        yield* runCli([
          "app",
          "pair",
          PAIRING_URL,
          "--label",
          "DGX 01",
          "--force",
          "--base-dir",
          baseDir,
        ]);

        expect(desktop.received).toEqual([
          {
            version: 1,
            requestId: expect.any(String),
            type: "pair-environment",
            pairingUrl: PAIRING_URL,
            force: false,
          },
          {
            version: 1,
            requestId: expect.any(String),
            type: "pair-environment",
            pairingUrl: PAIRING_URL,
            label: "DGX 01",
            force: true,
          },
        ]);
        expect(yield* TestConsole.logLines).toEqual([
          "Paired dgx-01 (environment-dgx) at https://dgx-01.example.ts.net/.",
          "Paired DGX 01 (environment-dgx) at https://dgx-01.example.ts.net/.",
        ]);
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("reports an environment the app already has without failing", () =>
    withTempDirectory("t3-app-pair-existing-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        yield* fakeDesktop({
          baseDir,
          reply: (request) => ({
            version: 1,
            requestId: request.requestId,
            ok: true,
            type: "pair-environment",
            outcome: "already-paired",
            environment: dgxEnvironment,
          }),
        });

        yield* runCli(["app", "pair", PAIRING_URL, "--base-dir", baseDir]);

        expect(yield* TestConsole.logLines).toEqual([
          "Already paired: dgx-01 (environment-dgx) at https://dgx-01.example.ts.net/. Pass --force to pair again.",
        ]);
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("fails with the app's reason, never printing the token", () =>
    withTempDirectory("t3-app-pair-failure-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        yield* fakeDesktop({
          baseDir,
          reply: (request) => ({
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "pairing-rejected",
            message: "https://dgx-01.example.ts.net/ rejected the pairing token.",
          }),
        });

        const error = yield* runCli(["app", "pair", PAIRING_URL, "--base-dir", baseDir]).pipe(
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "DesktopAppPairFailedError",
          code: "pairing-rejected",
          httpBaseUrl: "https://dgx-01.example.ts.net/",
          message:
            "Could not pair https://dgx-01.example.ts.net/ (pairing-rejected): https://dgx-01.example.ts.net/ rejected the pairing token.",
        });
        expect(String(error)).not.toContain("pairing-token");
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("rejects a link without a token before it reaches the app", () =>
    withTempDirectory("t3-app-pair-invalid-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        const desktop = yield* fakeDesktop({ baseDir });

        const error = yield* runCli([
          "app",
          "pair",
          "https://dgx-01.example.ts.net/pair",
          "--base-dir",
          baseDir,
        ]).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DesktopAppPairingUrlInvalidError",
          message: expect.stringContaining("Pairing URL is missing its token."),
        });
        expect(desktop.received).toHaveLength(0);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("treats a response for another request kind as invalid", () =>
    withTempDirectory("t3-app-pair-mismatch-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        yield* fakeDesktop({
          baseDir,
          reply: (request) => ({
            version: 1,
            requestId: request.requestId,
            ok: true,
            projectId: "project-1",
            threadId: "thread-1",
          }),
        });

        const error = yield* runCli(["app", "pair", PAIRING_URL, "--base-dir", baseDir]).pipe(
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "DesktopAppUnreachableError",
          cause: { message: "The desktop app response is invalid." },
        });
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("refuses SSH unless --allow-ssh is passed", () =>
    withTempDirectory("t3-app-pair-ssh-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        const desktop = yield* fakeDesktop({ baseDir });
        const ssh = { SSH_CONNECTION: "client server" };

        const error = yield* runCli(["app", "pair", PAIRING_URL, "--base-dir", baseDir], ssh).pipe(
          Effect.flip,
        );
        yield* runCli(["app", "pair", PAIRING_URL, "--allow-ssh", "--base-dir", baseDir], ssh);

        expect(error).toMatchObject({ _tag: "DesktopAppSshUnsupportedError" });
        expect(desktop.received).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
    ),
  );
});

describe("t3 app environments", () => {
  it.effect("prints the app's environments as a table or as JSON", () =>
    withTempDirectory("t3-app-environments-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        const desktop = yield* fakeDesktop({ baseDir });

        yield* runCli(["app", "environments", "--base-dir", baseDir]);
        yield* runCli(["app", "environments", "--json", "--base-dir", baseDir]);

        expect(desktop.received).toMatchObject([
          { type: "list-environments" },
          { type: "list-environments" },
        ]);
        const [table, json] = yield* TestConsole.logLines;
        expect(table).toBe(
          [
            "ENVIRONMENT ID     LABEL     KIND    CONNECTION  URL",
            "environment-local  This Mac  local   connected   http://127.0.0.1:3773/",
            "environment-dgx    dgx-01    remote  connecting  https://dgx-01.example.ts.net/",
          ].join("\n"),
        );
        expect(JSON.parse(String(json))).toEqual([localEnvironment, dgxEnvironment]);
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
    ),
  );
});
