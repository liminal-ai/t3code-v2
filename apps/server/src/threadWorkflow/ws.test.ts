import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ThreadId,
  WS_METHODS,
  clientRpcRequiredScopes,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadWorkflow from "./layer.ts";
import { handlers } from "./ws.ts";

const threadId = ThreadId.make("thread-ws");
const activeThread = {
  deletedAt: null,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
} as OrchestrationV2AppThread;

const layerTest = Layer.unwrap(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-ws-" });
    return ThreadWorkflow.layer.pipe(
      Layer.provide(ThreadCommandExecutor.layer),
      Layer.provide(ServerSettings.layerTest({ threadWorkflowsEnabled: true })),
      Layer.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.succeed(activeThread),
        }),
      ),
      Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
    );
  }),
).pipe(Layer.provide(NodeServices.layer));

it("guards the pane's write with operate scope and its reads with read scope", () => {
  assert.strictEqual(
    requiredScopeForRpcMethod(WS_METHODS.threadWorkflowApply),
    AuthOrchestrationOperateScope,
  );
  assert.deepStrictEqual(clientRpcRequiredScopes(WS_METHODS.threadWorkflowApply, undefined), [
    AuthOrchestrationOperateScope,
  ]);
  for (const method of [
    WS_METHODS.threadWorkflowSubscribe,
    WS_METHODS.threadWorkflowGet,
    WS_METHODS.threadWorkflowTemplates,
    WS_METHODS.threadWorkflowAttention,
  ]) {
    assert.strictEqual(requiredScopeForRpcMethod(method), AuthOrchestrationReadScope);
    assert.deepStrictEqual(clientRpcRequiredScopes(method, undefined), []);
  }
});

it.layer(layerTest)("thread workflow RPC handlers", (it) => {
  it.effect("applies as the user from the client session and streams the change", () =>
    Effect.gen(function* () {
      const rpc = yield* handlers("client-session-7");
      const seen = yield* Queue.unbounded<number>();
      yield* rpc[WS_METHODS.threadWorkflowSubscribe]({ threadId }).pipe(
        Stream.runForEach((state) => Queue.offer(seen, state.view.revision)),
        Effect.forkScoped,
      );
      assert.strictEqual(yield* Queue.take(seen), 0);

      const applied = yield* rpc[WS_METHODS.threadWorkflowApply]({
        threadId,
        request: { _tag: "start", templateId: "single-task" as never },
        requestId: "pane-1",
        expectedRevision: 0,
      });
      assert.isTrue(applied.changed);
      assert.strictEqual(yield* Queue.take(seen), 1);

      const stale = yield* rpc[WS_METHODS.threadWorkflowApply]({
        threadId,
        request: { _tag: "tick", stepId: "w1.1" as never },
        requestId: "pane-2",
        expectedRevision: 0,
      }).pipe(Effect.flip);
      assert.strictEqual(stale.code, "revision_conflict");

      const instance = yield* rpc[WS_METHODS.threadWorkflowGet]({
        threadId,
        instanceId: "w1" as never,
      });
      assert.deepStrictEqual(instance.started.by, {
        _tag: "user",
        clientSessionId: "client-session-7",
      });
      assert.strictEqual(instance.history.length, 1);
      const missing = yield* rpc[WS_METHODS.threadWorkflowGet]({
        threadId,
        instanceId: "w9" as never,
      }).pipe(Effect.flip);
      assert.strictEqual(missing.code, "unknown_instance");
      assert.isTrue((yield* rpc[WS_METHODS.threadWorkflowTemplates]()).length >= 3);
    }),
  );

  it.effect("streams which threads need the user, for every thread at once", () =>
    Effect.gen(function* () {
      const rpc = yield* handlers("client-session-8");
      const other = ThreadId.make("thread-ws-other");
      yield* rpc[WS_METHODS.threadWorkflowApply]({
        threadId: other,
        request: { _tag: "start", templateId: "single-task" as never },
        requestId: "other-1",
        expectedRevision: 0,
      });
      const seen = yield* Queue.unbounded<ReadonlyArray<string>>();
      yield* rpc[WS_METHODS.threadWorkflowAttention]().pipe(
        Stream.runForEach((entries) =>
          Queue.offer(
            seen,
            entries.map(
              (entry) => `${entry.threadId}:${entry.openQuestions}:${entry.latestQuestionId}`,
            ),
          ),
        ),
        Effect.forkScoped,
      );
      assert.deepStrictEqual(yield* Queue.take(seen), []);
      const revision = (yield* rpc[WS_METHODS.threadWorkflowApply]({
        threadId: other,
        request: { _tag: "ask", title: "Which base branch?" },
        requestId: "other-2",
        expectedRevision: 1,
      })).view.revision;
      assert.deepStrictEqual(yield* Queue.take(seen), [`${other}:1:w1.q1`]);
      yield* rpc[WS_METHODS.threadWorkflowApply]({
        threadId: other,
        request: { _tag: "answer", questionId: "w1.q1" as never, answer: "main" },
        requestId: "other-3",
        expectedRevision: revision,
      });
      assert.deepStrictEqual(yield* Queue.take(seen), []);
    }),
  );
});
