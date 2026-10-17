import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkMock = vi.hoisted(() => {
  const closeExecutionOrder: Array<string> = [];
  const runOperations: Array<string> = [];
  let agentCloseFailure: unknown;
  let staleRunActive = false;
  let cloudAgentMissing = false;
  const runWait = vi.fn(async () => ({
    id: "run-cursor-agent-sdk-test",
    requestId: "request-cursor-agent-sdk-test",
    status: "finished",
    result: "ok",
    model: { id: "default" },
    durationMs: 1,
  }));
  const runCancel = vi.fn(async () => {});
  const agentClose = vi.fn(() => {
    closeExecutionOrder.push("sdk:agent.close");
    if (agentCloseFailure !== undefined) {
      throw agentCloseFailure;
    }
  });
  const send = vi.fn(
    async (
      _message: unknown,
      options: { readonly onDelta?: (input: { readonly update: unknown }) => Promise<void> },
    ) => {
      runOperations.push("run.start");
      if (staleRunActive) {
        throw new Error("Agent agent-cursor-agent-sdk-test already has active run");
      }
      await options.onDelta?.({
        update: {
          type: "assistant-message-chunk",
          text: "hello",
        },
      });
      return {
        id: "run-cursor-agent-sdk-test",
        agentId: "agent-cursor-agent-sdk-test",
        wait: runWait,
        cancel: runCancel,
      };
    },
  );
  const create = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const resume = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const listRuns = vi.fn(async () => {
    runOperations.push("agent.listRuns");
    return {
      items: staleRunActive ? [{ id: "run-stale", status: "running" }] : [],
    };
  });
  const cancelRun = vi.fn(async () => {
    runOperations.push("agent.cancelRun");
    staleRunActive = false;
  });
  const get = vi.fn(async (agentId: string) => {
    if (cloudAgentMissing) {
      throw Object.assign(new Error(`Agent ${agentId} not found`), { status: 404 });
    }
    return { agentId, name: "", summary: "", lastModified: 0, runtime: "cloud" };
  });
  const getRun = vi.fn(async (runId: string, options: Record<string, unknown>) => ({
    id: runId,
    agentId: String(options.agentId),
    wait: runWait,
    cancel: runCancel,
  }));

  return {
    agentClose,
    cancelRun,
    closeExecutionOrder,
    create,
    get,
    getRun,
    listRuns,
    resume,
    runOperations,
    runCancel,
    runWait,
    send,
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure;
    },
    setStaleRunActive: (active: boolean) => {
      staleRunActive = active;
    },
    setCloudAgentMissing: (missing: boolean) => {
      cloudAgentMissing = missing;
    },
  };
});

vi.mock("./sdk.ts", () => ({
  Agent: {
    create: cursorSdkMock.create,
    resume: cursorSdkMock.resume,
    listRuns: cursorSdkMock.listRuns,
    cancelRun: cursorSdkMock.cancelRun,
    get: cursorSdkMock.get,
    getRun: cursorSdkMock.getRun,
    messages: {
      list: vi.fn(async () => []),
    },
  },
  createAgentPlatform: vi.fn(),
  SqliteLocalAgentStore: { open: vi.fn() },
}));

const layerTest = CursorAgentSdk.layer.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
      native: {
        filePath: "cursor-agent-sdk-test.log",
        write: (event: unknown) =>
          Effect.sync(() => {
            if (
              typeof event === "object" &&
              event !== null &&
              Reflect.get(Reflect.get(event, "event"), "payload")?.type === "agent.close"
            ) {
              cursorSdkMock.closeExecutionOrder.push("protocol:agent.close");
            }
          }),
        close: () => Effect.void,
      },
      canonical: undefined,
    }),
  ),
  Layer.provide(CursorSdk.layer),
  Layer.provide(NodeServices.layer),
);

describe("CursorAgentSdkRunner", () => {
  it.effect("leaves a resumed agent alone when its next send succeeds", () =>
    Effect.gen(function* () {
      cursorSdkMock.runOperations.length = 0;
      cursorSdkMock.setStaleRunActive(false);

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "resume",
        agentId: "agent-cursor-agent-sdk-test",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-normal-resume-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-normal-resume-test",
        ),
      });
      const run = yield* session.send({ message: "continue" });
      yield* run.wait;

      assert.deepStrictEqual(cursorSdkMock.runOperations, ["run.start"]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("retries a resumed send after cancelling its abandoned local run", () =>
    Effect.gen(function* () {
      cursorSdkMock.runOperations.length = 0;
      cursorSdkMock.listRuns.mockClear();
      cursorSdkMock.cancelRun.mockClear();
      cursorSdkMock.setStaleRunActive(true);

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "resume",
        agentId: "agent-cursor-agent-sdk-test",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-stale-run-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-stale-run-test",
        ),
      });
      assert.deepStrictEqual(cursorSdkMock.runOperations, []);
      const run = yield* session.send({ message: "continue" });
      yield* run.wait;

      assert.deepStrictEqual(cursorSdkMock.runOperations, [
        "run.start",
        "agent.listRuns",
        "agent.cancelRun",
        "run.start",
      ]);
      assert.deepStrictEqual(cursorSdkMock.listRuns.mock.calls[0], [
        "agent-cursor-agent-sdk-test",
        { runtime: "local", cwd: process.cwd(), limit: 1 },
      ]);
      assert.deepStrictEqual(cursorSdkMock.cancelRun.mock.calls[0], [
        "run-stale",
        {
          runtime: "local",
          cwd: process.cwd(),
        },
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("logs agent.close before invoking the Cursor SDK", () =>
    Effect.gen(function* () {
      cursorSdkMock.agentClose.mockClear();
      cursorSdkMock.closeExecutionOrder.length = 0;
      cursorSdkMock.setAgentCloseFailure(undefined);

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: {
          model: { id: "default" },
          mode: "agent",
          local: {
            cwd: process.cwd(),
          },
        },
        threadId: ThreadId.make("thread-cursor-agent-sdk-close-order-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-close-order-test",
        ),
      });

      cursorSdkMock.closeExecutionOrder.length = 0;
      yield* session.close;

      assert.deepStrictEqual(cursorSdkMock.closeExecutionOrder, [
        "protocol:agent.close",
        "sdk:agent.close",
      ]);
      assert.equal(cursorSdkMock.agentClose.mock.calls.length, 1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("logs agent.close even when the Cursor SDK close fails", () =>
    Effect.gen(function* () {
      cursorSdkMock.agentClose.mockClear();
      cursorSdkMock.closeExecutionOrder.length = 0;
      const closeFailure = new Error("agent close failed");
      cursorSdkMock.setAgentCloseFailure(closeFailure);

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: {
          model: { id: "default" },
          mode: "agent",
          local: {
            cwd: process.cwd(),
          },
        },
        threadId: ThreadId.make("thread-cursor-agent-sdk-close-failure-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-close-failure-test",
        ),
      });

      cursorSdkMock.closeExecutionOrder.length = 0;
      const error = yield* Effect.flip(session.close);

      assert.instanceOf(error, CursorAgentSdk.CursorAgentSdkRunnerError);
      assert.equal(error.method, "agent.close");
      assert.strictEqual(error.cause, closeFailure);
      assert.deepStrictEqual(cursorSdkMock.closeExecutionOrder, [
        "protocol:agent.close",
        "sdk:agent.close",
      ]);
      assert.equal(cursorSdkMock.agentClose.mock.calls.length, 1);
      cursorSdkMock.setAgentCloseFailure(undefined);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("surfaces interaction callback failures through run.wait", () =>
    Effect.gen(function* () {
      cursorSdkMock.create.mockClear();
      cursorSdkMock.runWait.mockClear();
      cursorSdkMock.send.mockClear();

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: {
          model: { id: "default" },
          mode: "agent",
          local: {
            cwd: process.cwd(),
            autoReview: false,
            sandboxOptions: { enabled: false },
            enableAgentRetries: true,
          },
        },
        threadId: ThreadId.make("thread-cursor-agent-sdk-test"),
        providerSessionId: ProviderSessionId.make("provider-session-cursor-agent-sdk-test"),
      });

      const callbackFailure = new Error("delta callback failed");
      const run = yield* session.send({
        message: "hello",
        onDelta: () => Effect.fail(callbackFailure),
      });

      const error = yield* Effect.flip(run.wait);

      assert.instanceOf(error, CursorAgentSdk.CursorAgentSdkRunnerError);
      assert.equal(error.method, "run.wait");
      assert.strictEqual(error.cause, callbackFailure);
      assert.equal(cursorSdkMock.create.mock.calls.length, 1);
      assert.equal(cursorSdkMock.send.mock.calls.length, 1);
      assert.equal(cursorSdkMock.runWait.mock.calls.length, 1);
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("CursorAgentSdkRunner cloud", () => {
  const cloudOptions = {
    model: { id: "default" },
    mode: "agent" as const,
    apiKey: "cloud-key",
    cloud: { repos: [{ url: "https://github.com/liminal-ai/t3code-v2", startingRef: "main" }] },
  };
  const openCloud = (operation: "create" | "resume", name: string) =>
    Effect.gen(function* () {
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      return yield* runner.open({
        operation,
        ...(operation === "resume" ? { agentId: "agent-cursor-agent-sdk-test" } : {}),
        options: cloudOptions,
        threadId: ThreadId.make(`thread-${name}`),
        providerSessionId: ProviderSessionId.make(`provider-session-${name}`),
      });
    });
  const resetMocks = () => {
    cursorSdkMock.runOperations.length = 0;
    for (const mock of [
      cursorSdkMock.create,
      cursorSdkMock.resume,
      cursorSdkMock.get,
      cursorSdkMock.getRun,
      cursorSdkMock.listRuns,
      cursorSdkMock.cancelRun,
      cursorSdkMock.runCancel,
    ]) {
      mock.mockClear();
    }
    cursorSdkMock.setStaleRunActive(false);
    cursorSdkMock.setCloudAgentMissing(false);
  };

  it.effect("asks Cursor to cancel a cloud run by id and leaves its stream open", () =>
    Effect.gen(function* () {
      resetMocks();
      const session = yield* openCloud("create", "cloud-cancel");
      const run = yield* session.send({ message: "work" });

      yield* run.cancel;

      assert.deepStrictEqual(cursorSdkMock.cancelRun.mock.calls, [
        [
          "run-cursor-agent-sdk-test",
          { runtime: "cloud", agentId: "agent-cursor-agent-sdk-test", apiKey: "cloud-key" },
        ],
      ]);
      assert.equal(cursorSdkMock.runCancel.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("starts a cloud agent Cursor has no record of under its recorded id", () =>
    Effect.gen(function* () {
      resetMocks();
      cursorSdkMock.setCloudAgentMissing(true);

      yield* openCloud("resume", "cloud-first-turn");

      assert.deepStrictEqual(cursorSdkMock.get.mock.calls, [
        ["agent-cursor-agent-sdk-test", { apiKey: "cloud-key" }],
      ]);
      assert.deepStrictEqual(cursorSdkMock.create.mock.calls, [
        [{ ...cloudOptions, agentId: "agent-cursor-agent-sdk-test" }],
      ]);
      assert.equal(cursorSdkMock.resume.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("resumes a cloud agent Cursor knows", () =>
    Effect.gen(function* () {
      resetMocks();

      yield* openCloud("resume", "cloud-resume");

      assert.equal(cursorSdkMock.create.mock.calls.length, 0);
      assert.deepStrictEqual(cursorSdkMock.resume.mock.calls, [
        ["agent-cursor-agent-sdk-test", cloudOptions],
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("never cancels the run of a busy cloud agent", () =>
    Effect.gen(function* () {
      resetMocks();
      cursorSdkMock.setStaleRunActive(true);
      const session = yield* openCloud("resume", "cloud-busy");

      const error = yield* Effect.flip(session.send({ message: "continue" }));

      assert.equal(error.method, "run.start");
      assert.deepStrictEqual(cursorSdkMock.runOperations, ["run.start"]);
      cursorSdkMock.setStaleRunActive(false);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps a local agent on the local resume and cancel calls", () =>
    Effect.gen(function* () {
      resetMocks();
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const localOptions = {
        model: { id: "default" },
        mode: "agent" as const,
        local: { cwd: process.cwd() },
      };
      const session = yield* runner.open({
        operation: "resume",
        agentId: "agent-cursor-agent-sdk-test",
        options: localOptions,
        threadId: ThreadId.make("thread-local-unchanged"),
        providerSessionId: ProviderSessionId.make("provider-session-local-unchanged"),
      });
      const run = yield* session.send({ message: "work" });

      yield* run.cancel;

      assert.deepStrictEqual(cursorSdkMock.resume.mock.calls, [
        ["agent-cursor-agent-sdk-test", localOptions],
      ]);
      assert.equal(cursorSdkMock.get.mock.calls.length, 0);
      assert.equal(cursorSdkMock.create.mock.calls.length, 0);
      assert.equal(cursorSdkMock.runCancel.mock.calls.length, 1);
      assert.equal(cursorSdkMock.cancelRun.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("follows an existing cloud run without sending a message", () =>
    Effect.gen(function* () {
      resetMocks();
      const session = yield* openCloud("resume", "cloud-attach");

      const run = yield* session.attach("run-still-going");
      const result = yield* run.wait;

      assert.deepStrictEqual(cursorSdkMock.getRun.mock.calls, [
        [
          "run-still-going",
          { runtime: "cloud", agentId: "agent-cursor-agent-sdk-test", apiKey: "cloud-key" },
        ],
      ]);
      assert.equal(run.runId, "run-still-going");
      assert.equal(result.status, "finished");
      assert.deepStrictEqual(cursorSdkMock.runOperations, []);
    }).pipe(Effect.provide(layerTest)),
  );
});
