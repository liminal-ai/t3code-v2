// @effect-diagnostics nodeBuiltinImport:off - The stub server cuts an answer off mid-body, which Effect's HTTP server cannot.
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import { threadCommand } from "../cli/thread.ts";
import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { LIMBASE_MIGRATION_ROUTE_PREFIX } from "./LimbaseMigration.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  const session = Effect.map(DateTime.now, (expiresAt) => ({
    sessionId: AuthSessionId.make("test-session"),
    token: "synthetic-token",
    expiresAt,
  }));
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: () => session,
      issueSession: () =>
        Effect.map(session, (issued) => ({
          ...issued,
          method: "bearer-access-token" as const,
          scopes: [],
          subject: "owner",
          client: { deviceType: "bot" as const },
        })),
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const thread = {
  threadId: "thread-1",
  projectId: "project-1",
  title: "Triage me",
  createdBy: "user",
  creationSource: "web",
  status: "completed",
  latestRunId: null,
  activeRunId: null,
  providerInstanceId: "claudeLimbase",
  model: "claude-haiku-5-5",
  runtimeMode: "full-access",
  interactionMode: "default",
  linkedPullRequest: null,
  pullRequests: [],
  pullRequestCount: 0,
  openPullRequestCount: 0,
  titleRegeneration: null,
  lastTitleRegeneration: null,
  branch: null,
  worktreePath: null,
  parentThreadId: null,
  relationshipToParent: null,
  runCount: 0,
  itemCount: 0,
  pendingRequestCount: 0,
  archived: false,
  settled: false,
  settledAt: null,
  snoozed: false,
  snoozedUntil: null,
  pinned: false,
  blockedOnThreadWait: false,
  pendingBackgroundTasks: [],
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
};

const ids = { providerThreadId: "provider-thread:limbase", limbaseThreadId: "th_0123456789abcdef" };
const threadLines = [thread.title, "thread-1  completed  claudeLimbase/claude-haiku-5-5"];

type Respond = (response: NodeHttp.ServerResponse) => void;

const json =
  (status: number, body: unknown): Respond =>
  (response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

/** Serves the ids route as `respond` says, and counts its requests. */
const idsServer = (respond: Respond) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      let requests = 0;
      const server = NodeHttp.createServer((request: NodeHttp.IncomingMessage, response) => {
        request.resume();
        if (request.url !== `${LIMBASE_MIGRATION_ROUTE_PREFIX}/ids`) {
          response.writeHead(500).end();
          return;
        }
        requests++;
        respond(response);
      });
      server.listen(0, "127.0.0.1");
      await NodeEvents.once(server, "listening");
      return {
        server,
        port: (server.address() as NodeNet.AddressInfo).port,
        requests: () => requests,
      };
    }),
    ({ server }) =>
      Effect.promise(() => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
  );

const closedPort = Effect.promise(async () => {
  const server = NodeHttp.createServer();
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  const { port } = server.address() as NodeNet.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
});

/** Runs `t3 thread show` against a server on `port`, and gives what it printed and how it ended. */
const show = (port: number, json: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-limbase-show-" });
    yield* persistServerRuntimeState({
      path: path.join(baseDir, "userdata", "server-runtime.json"),
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port,
      }),
    });
    using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool) =>
          tool === "t3_thread_read"
            ? Effect.succeed({
                structuredContent: {
                  thread,
                  recentRuns: [],
                  items: [],
                  nextPosition: null,
                  hasMore: false,
                },
              })
            : Effect.die(`unexpected ${tool} call`),
      }),
    );
    const stdoutBefore = (yield* TestConsole.logLines).length;
    const stderrBefore = (yield* TestConsole.errorLines).length;
    const exit = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "show",
      "thread-1",
      "--base-dir",
      baseDir,
      ...(json ? ["--json"] : []),
    ]).pipe(Effect.exit);
    return {
      exitCode: Exit.isSuccess(exit) ? 0 : 1,
      stdout: (yield* TestConsole.logLines).slice(stdoutBefore).map(String),
      stderr: (yield* TestConsole.errorLines).slice(stderrBefore).map(String),
    };
  }).pipe(Effect.scoped);

/** Shows the thread as JSON and as text, and checks both against what the base CLI prints. */
const expectShow = (
  port: number,
  expected: { readonly limbase?: unknown; readonly line?: string; readonly warning?: string },
) =>
  Effect.gen(function* () {
    const asJson = yield* show(port, true);
    const asText = yield* show(port, false);
    assert.strictEqual(asJson.exitCode, 0);
    assert.strictEqual(asText.exitCode, 0);
    assert.lengthOf(asJson.stdout, 1);
    assert.deepStrictEqual(JSON.parse(asJson.stdout[0]!), {
      thread,
      messages: [],
      error: null,
      ...(expected.limbase === undefined ? {} : { limbase: expected.limbase }),
    });
    assert.deepStrictEqual(asText.stdout, [
      ...threadLines,
      ...(expected.line === undefined ? [] : [expected.line]),
    ]);
    for (const { stderr } of [asJson, asText]) {
      assert.deepStrictEqual(stderr, expected.warning === undefined ? [] : [expected.warning]);
    }
  });

const failure = (detail: string) => ({
  limbase: { error: detail },
  line: `Limbase lookup failed: ${detail}`,
  warning: `Warning: Limbase lookup failed: ${detail}`,
});

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NetService.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
);

const showCase = <E>(
  name: string,
  body: Effect.Effect<void, E, Layer.Success<typeof testLayer> | Scope.Scope>,
) => it.effect(name, () => body.pipe(Effect.scoped, Effect.provide(testLayer)));

showCase(
  "show prints the active provider thread and its Limbase thread",
  Effect.gen(function* () {
    const { port } = yield* idsServer(json(200, ids));
    yield* expectShow(port, {
      limbase: ids,
      line: `Limbase ${ids.limbaseThreadId}  provider thread ${ids.providerThreadId}`,
    });
  }),
);

showCase(
  "show adds nothing for a thread that is not on Limbase",
  Effect.gen(function* () {
    const { port } = yield* idsServer(json(200, null));
    yield* expectShow(port, {});
  }),
);

showCase(
  "show adds nothing against an older server, which has no ids route",
  Effect.gen(function* () {
    const { port, requests } = yield* idsServer((response) => response.writeHead(404).end());
    yield* expectShow(port, {});
    assert.strictEqual(requests(), 2);
  }),
);

for (const status of [401, 403]) {
  showCase(
    `show still prints the thread when the lookup gets ${status}, and says it needs owner access`,
    Effect.gen(function* () {
      const { port } = yield* idsServer(json(status, { code: "insufficient_scope" }));
      yield* expectShow(
        port,
        failure(`The server answered ${status}. The Limbase lookup needs owner access.`),
      );
    }),
  );
}

showCase(
  "show still prints the thread when the lookup gets 503, with the server's reason",
  Effect.gen(function* () {
    const { port } = yield* idsServer(
      json(503, { error: "The ids lookup is temporarily unavailable." }),
    );
    yield* expectShow(
      port,
      failure("The server answered 503: The ids lookup is temporarily unavailable."),
    );
  }),
);

showCase(
  "show still prints the thread when the server cannot be reached for the lookup",
  Effect.gen(function* () {
    const port = yield* closedPort;
    const asJson = yield* show(port, true);
    assert.strictEqual(asJson.exitCode, 0);
    const output = JSON.parse(asJson.stdout[0]!);
    assert.deepStrictEqual(output.thread, thread);
    assert.match(
      output.limbase.error,
      new RegExp(`^Could not reach the T3 Code server at http://127\\.0\\.0\\.1:${port}\\.`),
    );
    yield* expectShow(port, failure(output.limbase.error));
  }),
);
