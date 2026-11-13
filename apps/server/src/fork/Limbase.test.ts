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

import * as Limbase from "./Limbase.ts";

const created: unknown[] = [];
/** The host entry of each rollback the fake service made. */
const rolledBack: unknown[] = [];

/** A fail-out the host reports, as the real host does from the hook that failed. */
let failOut: { readonly where: string; readonly what: string } | undefined;
/** Reports `failOut` where a fake SDK stream holds `"failOut"`, instead of as the host starts. */
let failOutLater = false;
let reportFailOut: () => void = () => {};
/** Settles once the caller has read a `result`, as T3 does before it sends the next prompt. */
let resultRead: Promise<void> = Promise.resolve();
let markResultRead: () => void = () => {};

vi.mock("@limbase/host-agent-sdk", async (original) => {
  const actual = await original<typeof import("@limbase/host-agent-sdk")>();
  return {
    ...actual,
    createAgentSdkHost: (options: Parameters<typeof actual.createAgentSdkHost>[0]) => {
      const report = () => {
        if (failOut !== undefined)
          options.onEvent?.({
            kind: "failOut",
            hook: "PostToolBatch",
            ms: 0,
            retriedMs: 0,
            ...failOut,
          } as never);
      };
      if (failOutLater) reportFailOut = report;
      else report();
      return actual.createAgentSdkHost(options);
    },
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
    // A thread's capture ends at its second turn, whose answer is `assistant-2`.
    threadCalls: (...args: Parameters<typeof actual.threadCalls>) => ({
      ...actual.threadCalls(...args),
      registerAlias: async () => ({}),
      open: async () => ({}),
      cursor: async () => ({ durableThrough: "claude:assistant-2:turn_end", viewRevision: 0 }),
      rollBack: async (entry: string) => {
        rolledBack.push(entry);
        return { _tag: "rolledBack", viewRevision: 1, through: "claude:assistant-1:turn_end" };
      },
    }),
  };
});

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
const fakeSdk = (messages: ReadonlyArray<SDKMessage | "failOut">) => {
  const opened: Options[] = [];
  const query = (({ options }: { options?: Options }) => {
    opened.push(options ?? {});
    return Object.assign(
      (async function* () {
        for (const message of messages) {
          if (message !== "failOut") yield message;
          else {
            await resultRead;
            reportFailOut();
          }
        }
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
  for await (const message of stream) {
    seen.push(message);
    if (message.type === "result") markResultRead();
  }
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

  it.effect(
    "fails a step that Limbase stopped with the host's reason, at a prompt and at a tool boundary",
    () =>
      Effect.gen(function* () {
        const settings = decodeSettings({ limbaseHome: yield* limbaseHome });
        const result = (text: string, terminal?: string) =>
          ({
            type: "result",
            subtype: "success",
            is_error: false,
            result: text,
            ...(terminal === undefined ? {} : { terminal_reason: terminal }),
          }) as SDKMessage;
        const reason =
          "limbase: stopped at convex: the step's records were not saved within the retry window";
        const run = (messages: ReadonlyArray<SDKMessage>) =>
          Effect.gen(function* () {
            const hosted = yield* Limbase.queryFor(
              settings,
              providerThread({ limbaseThreadId: "th_1" }),
              fakeSdk(messages).sdk,
            );
            return yield* Effect.promise(() => drain(hosted!({ prompt: prompts, options: {} })));
          });
        const failed: Partial<SDKMessage> = {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [reason],
        };
        failOut = {
          where: "convex",
          what: "the step's records were not saved within the retry window",
        };
        const atPrompt = yield* run([
          result(`Operation stopped by hook: ${reason}`),
          result("Done."),
        ]);
        const atBatch = yield* run([result("", "hook_stopped"), result("Done.")]);
        failOut = undefined;
        const ordinary = yield* run([result("", "hook_stopped")]);
        assert.deepInclude(atPrompt[0], failed);
        assert.deepEqual(atPrompt[1], result("Done."));
        assert.deepInclude(atBatch[0], failed);
        assert.deepEqual(atBatch[1], result("Done."));
        assert.deepEqual(ordinary[0], result("", "hook_stopped"));
      }),
  );

  it.effect(
    "tells the user which edit gets past a step Limbase failed in a query an edit opened",
    () =>
      Effect.gen(function* () {
        const settings = decodeSettings({ limbaseHome: yield* limbaseHome });
        const stopped = (reason: string) =>
          ({
            type: "result",
            subtype: "success",
            is_error: false,
            result: `Operation stopped by hook: ${reason}`,
          }) as SDKMessage;
        const done = {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Done.",
        } as SDKMessage;
        /** The errors of each failed `result`, for a step failed at `where` with `what`. */
        const shown = (where: string, what: string, place: boolean, ranFirst = false) =>
          Effect.gen(function* () {
            failOut = { where, what };
            failOutLater = ranFirst;
            resultRead = new Promise<void>((resolve) => (markResultRead = resolve));
            const reason = `limbase: stopped at ${where}: ${what}`;
            const hosted = yield* Limbase.queryFor(
              settings,
              providerThread({ limbaseThreadId: "th_1" }),
              fakeSdk(ranFirst ? [done, "failOut", stopped(reason)] : [stopped(reason)]).sdk,
            );
            const seen = yield* Effect.promise(() =>
              drain(
                hosted!({
                  prompt: prompts,
                  options: place ? { resume: "session-1", resumeSessionAt: "assistant-1" } : {},
                }),
              ),
            );
            failOut = undefined;
            failOutLater = false;
            return seen.flatMap((m) =>
              m.type === "result" && m.subtype !== "success" ? m.errors : [],
            );
          });
        const notOpened = "the thread did not open within the retry window";
        assert.deepEqual(yield* shown("view", "rollback refused: anchor", true), [
          "limbase: stopped at view: rollback refused: anchor. Edit an earlier message to go on.",
        ]);
        assert.deepEqual(yield* shown("view", "rollback refused: overBound", true), [
          "limbase: stopped at view: rollback refused: overBound. Edit an earlier message to go on.",
        ]);
        assert.deepEqual(yield* shown("view", "rollback refused: failed", true), [
          "limbase: stopped at view: rollback refused: failed. Edit the message again to retry.",
        ]);
        assert.deepEqual(yield* shown("capture", notOpened, true), [
          `limbase: stopped at capture: ${notOpened}. Edit the message again to retry.`,
        ]);
        // A plain query's outage, and one after a step already ran from the place, say what they did.
        assert.deepEqual(yield* shown("capture", notOpened, false), [
          `limbase: stopped at capture: ${notOpened}`,
        ]);
        assert.deepEqual(yield* shown("capture", notOpened, true, true), [
          `limbase: stopped at capture: ${notOpened}`,
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

  it.effect(
    "rolls the Limbase thread back to the place an edit pins, and the CLI never sees it",
    () =>
      Effect.gen(function* () {
        const settings = decodeSettings({ limbaseHome: yield* limbaseHome });
        const { opened, sdk } = fakeSdk([init(Limbase.TESTED_CLAUDE_CODE)]);
        const hosted = yield* Limbase.queryFor(
          settings,
          providerThread({ limbaseThreadId: "th_1" }),
          sdk,
        );
        const before = rolledBack.length;
        yield* Effect.promise(() =>
          drain(
            hosted!({
              prompt: prompts,
              options: { resume: "session-1", resumeSessionAt: "assistant-1", cwd: "/work/app" },
            }),
          ),
        );
        assert.deepEqual(rolledBack.slice(before), ["assistant-1"]);
        assert.equal(opened[0]?.resumeSessionAt, undefined);
        assert.equal(opened[0]?.resume, undefined);
      }),
  );

  it.effect("gives a reset row a new Limbase thread when the old row had one", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ limbaseHome: yield* limbaseHome });
      const before = created.length;
      const reset = yield* Limbase.threadAfterReset({
        settings,
        reset: providerThread({ limbaseThreadId: "th_1" }),
        cwd: "/work/app",
      });
      assert.equal(created.length, before + 1);
      assert.deepEqual(created.at(-1), {
        cwd: "/work/app",
        compactPolicy: { trigger: 700_000, target: 100_000 },
      });
      assert.notEqual(reset.nativeMetadata?.limbaseThreadId, "th_1");
      assert.isDefined(reset.nativeMetadata?.limbaseThreadId);
      // A thread that began before its instance had a home stays plain.
      assert.deepEqual(
        yield* Limbase.threadAfterReset({ settings, reset: providerThread(), cwd: "/work/app" }),
        {},
      );
      assert.equal(created.length, before + 1);
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

  it("finds a moved row's live process for stop, model and MCP App calls, and the stored id otherwise", () => {
    const moved = new Map([["session-1", "session-2"]]);
    const live = { nativeThreadId: "session-1", stopping: false };
    const row = (nativeId: string, limbaseThreadId?: string) =>
      ({
        ...providerThread(limbaseThreadId === undefined ? undefined : { limbaseThreadId }),
        nativeThreadRef: { driver: "claudeAgent", nativeId, strength: "strong" },
      }) as OrchestrationV2ProviderThread;
    // Two installs in one process leave the newest id under the process's first id.
    moved.set("session-1", "session-3");
    assert.equal(Limbase.liveNativeId(row("session-3", "th_1"), live, moved), "session-1");
    assert.equal(Limbase.liveNativeId(row("session-2", "th_1"), live, moved), "session-2");
    assert.equal(Limbase.liveNativeId(row("session-3"), live, moved), "session-3");
    assert.equal(Limbase.liveNativeId(row("session-3", "th_1"), null, moved), "session-3");
  });
});
