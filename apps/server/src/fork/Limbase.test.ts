import {
  createSdkMcpServer,
  type Options,
  type query as sdkQuery,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  type OrchestrationV2ProviderThread,
  ProviderThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { rollbackFailureClientMessage } from "../orchestration-v2/CheckpointRollbackService.ts";
import { CheckpointRollbackExecutionError } from "../orchestration-v2/CheckpointRollbackService.ts";
import * as Limbase from "./Limbase.ts";

const created: unknown[] = [];

vi.mock("@limbase/host-agent-sdk", async (original) => ({
  ...(await original<typeof import("@limbase/host-agent-sdk")>()),
  // The fake service answers each call with its value, which `call` resolves to.
  connectLimbase: async () => ({
    call: async (rpc: (client: unknown) => unknown) =>
      rpc({
        CreateThread: (payload: unknown) => {
          created.push(payload);
          return { threadId: `th_${created.length}`, createdAt: 0 };
        },
      }),
    close: async () => {},
  }),
}));

const decodeSettings = Schema.decodeUnknownSync(ClaudeSettings);

const limbaseHome = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "limbase-home-" });
  yield* fileSystem.makeDirectory(path.join(home, "config"));
  yield* fileSystem.writeFileString(
    path.join(home, "config", "membase.json"),
    JSON.stringify({ socketPath: path.join(home, "run", "limbase.sock") }),
  );
  return home;
});

const providerThread = (
  nativeMetadata?: OrchestrationV2ProviderThread["nativeMetadata"],
): OrchestrationV2ProviderThread =>
  ({
    id: ProviderThreadId.make("provider-thread:limbase-test"),
    nativeThreadRef: { driver: "claudeAgent", nativeId: "session-1", strength: "strong" },
    ...(nativeMetadata === undefined ? {} : { nativeMetadata }),
  }) as OrchestrationV2ProviderThread;

/** An SDK whose query records its options and streams `messages`. */
const fakeSdk = (messages: ReadonlyArray<SDKMessage>) => {
  const opened: Options[] = [];
  const query = (({ options }: { options?: Options }) => {
    opened.push(options ?? {});
    return Object.assign(
      (async function* () {
        yield* messages;
      })(),
      { close: () => {} },
    );
  }) as unknown as typeof sdkQuery;
  return { opened, sdk: { query, createSdkMcpServer } };
};

const init = (version: string) =>
  ({
    type: "system",
    subtype: "init",
    session_id: "session-1",
    claude_code_version: version,
  }) as SDKMessage;

const drain = async (stream: AsyncIterable<SDKMessage>) => {
  const seen: SDKMessage[] = [];
  for await (const message of stream) seen.push(message);
  return seen;
};

const prompts = (async function* () {})();

it.layer(NodeServices.layer)("Limbase", (it) => {
  it.effect("leaves a thread on a plain instance untouched", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({});
      const before = created.length;
      assert.deepEqual(
        yield* Limbase.ensureThread({ settings, existing: undefined, title: "t", cwd: "/w" }),
        {},
      );
      assert.equal(yield* Limbase.queryFor(settings, providerThread()), undefined);
      assert.equal(created.length, before);
    }),
  );

  it.effect("gives a thread one Limbase thread with the compact policy, and keeps it", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ limbaseHome: yield* limbaseHome });
      const before = created.length;
      const first = yield* Limbase.ensureThread({
        settings,
        existing: providerThread(),
        title: "Fix the build",
        cwd: "/work/app",
      });
      assert.equal(created.length, before + 1);
      assert.deepEqual(created.at(-1), {
        title: "Fix the build",
        cwd: "/work/app",
        compactPolicy: { trigger: 700_000, target: 100_000 },
      });
      const limbaseThreadId = first.nativeMetadata?.limbaseThreadId;
      assert.isDefined(limbaseThreadId);
      // A fresh native session on the same row, as upstream's resume fallback makes, keeps it.
      const again = yield* Limbase.ensureThread({
        settings,
        existing: providerThread(first.nativeMetadata),
        title: "Fix the build",
        cwd: "/work/app",
      });
      assert.equal(again.nativeMetadata?.limbaseThreadId, limbaseThreadId);
      assert.equal(created.length, before + 1);
    }),
  );

  it.effect("fails with the home it could not read", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ limbaseHome: "/nonexistent/limbase-home" });
      const error = yield* Effect.flip(
        Limbase.ensureThread({ settings, existing: undefined, title: undefined, cwd: null }),
      );
      assert.equal(
        error.message,
        "Limbase: could not reach the Limbase home /nonexistent/limbase-home",
      );
    }),
  );

  it.effect("runs a Limbase thread's query through the host, with the SDK's compaction off", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ limbaseHome: yield* limbaseHome });
      const { opened, sdk } = fakeSdk([init(Limbase.TESTED_CLAUDE_CODE)]);
      const hosted = yield* Limbase.queryFor(
        settings,
        providerThread({ limbaseThreadId: "th_1" }),
        sdk,
      );
      assert.isDefined(hosted);
      const seen = yield* Effect.promise(() =>
        drain(
          hosted!({
            prompt: prompts,
            options: {
              sessionId: "session-1",
              env: { PATH: "/bin" },
              settings: { showThinkingSummaries: true },
              mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
            },
          }),
        ),
      );
      assert.deepEqual(
        seen.map((message) => message.type),
        ["system"],
      );
      const options = opened[0]!;
      assert.equal(options.sessionId, "session-1");
      assert.equal(options.env?.DISABLE_COMPACT, "1");
      assert.deepEqual(options.settings, {
        showThinkingSummaries: true,
        autoCompactEnabled: false,
      });
      assert.deepEqual(Object.keys(options.mcpServers ?? {}).toSorted(), ["limbase", "t3-code"]);
      assert.includeMembers(Object.keys(options.hooks ?? {}), [
        "PostToolBatch",
        "UserPromptSubmit",
        "PreCompact",
      ]);
    }),
  );

  it.effect("warns when the CLI is not the version the host is tested on", () => {
    const warnings: unknown[] = [];
    const logger = Logger.make(({ message, logLevel }) => {
      if (logLevel === "Warn") warnings.push(message);
    });
    return Effect.gen(function* () {
      const settings = decodeSettings({ limbaseHome: yield* limbaseHome });
      const { sdk } = fakeSdk([init("2.0.0")]);
      const hosted = yield* Limbase.queryFor(
        settings,
        providerThread({ limbaseThreadId: "th_1" }),
        sdk,
      );
      yield* Effect.promise(() => drain(hosted!({ prompt: prompts, options: {} })));
      yield* Effect.yieldNow;
      assert.deepEqual(warnings, [
        ["limbase.claude-code-version", { running: "2.0.0", tested: Limbase.TESTED_CLAUDE_CODE }],
      ]);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("tells the user why Edit from here is refused on a Limbase thread", () =>
    Effect.gen(function* () {
      const refusal = yield* Effect.flip(
        Limbase.refuse(providerThread({ limbaseThreadId: "th_1" }), "rollback"),
      );
      const message = rollbackFailureClientMessage(
        new CheckpointRollbackExecutionError({
          reason: "unexpected-failure",
          threadId: "thread-1" as never,
          providerThreadId: providerThread().id,
          checkpointId: "checkpoint-1" as never,
          cause: { _tag: "ProviderAdapterRollbackThreadError", cause: refusal },
        }),
      );
      assert.equal(message, "Edit from here does not work on a Limbase thread yet.");
      yield* Limbase.refuse(providerThread(), "rollback");
    }),
  );

  it("sends a turn after an install to the live process, and leaves other turns alone", () => {
    const limbase = { providerThread: { ...providerThread({ limbaseThreadId: "th_1" }) } };
    limbase.providerThread = {
      ...limbase.providerThread,
      nativeThreadRef: { driver: "claudeAgent", nativeId: "session-2", strength: "strong" },
    } as OrchestrationV2ProviderThread;
    const moved = new Map([["session-1", "session-2"]]);
    const live = { nativeThreadId: "session-1", stopping: false };
    assert.equal(
      Limbase.onLiveSession(limbase, live, moved).providerThread.nativeThreadRef?.nativeId,
      "session-1",
    );
    assert.equal(Limbase.onLiveSession(limbase, { ...live, stopping: true }, moved), limbase);
    assert.equal(Limbase.onLiveSession(limbase, null, moved), limbase);
    const plain = { providerThread: { ...limbase.providerThread, nativeMetadata: null } };
    assert.equal(Limbase.onLiveSession(plain, live, moved), plain);
  });
});
