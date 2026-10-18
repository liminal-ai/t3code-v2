import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadWorkflow from "../../../threadWorkflow/layer.ts";
import { ThreadWorkflowService } from "../../../threadWorkflow/ThreadWorkflowService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment:thread-workflow");
const threadId = ThreadId.make("thread:workflow-mcp");
const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider:workflow",
  thread: {
    threadId,
    providerSessionId: "provider:workflow",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 0,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "workflow", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "workflow", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const activeThread = {
  deletedAt: null,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
} as OrchestrationV2AppThread;

const layerFor = (enabled: boolean, options: { readonly unreadableStore?: boolean } = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-mcp-" });
      if (options.unreadableStore === true) {
        const rootDir = path.join(baseDir, "userdata", "thread-workflows");
        yield* fileSystem.makeDirectory(rootDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(rootDir, "threads"), "a file, not a directory");
      }
      return McpHttpServer.layerThreadWorkflowToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(
          ThreadWorkflow.layer.pipe(
            Layer.provide(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThread: () => Effect.succeed(activeThread),
              }),
            ),
            Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
          ),
        ),
        Layer.provideMerge(ServerSettings.layerTest({ threadWorkflowsEnabled: enabled })),
        Layer.provide(ThreadCommandExecutor.layer),
        Layer.provide(liveThreadsLayer),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer));

const call = (name: string, args: Record<string, unknown>, capabilities = ["thread-workflow"]) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(capabilities as ReadonlyArray<McpInvocationContext.McpCapability>),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

// A declared failure comes back as `isError` with its encoded payload as JSON text.
const failure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text"
    ? (JSON.parse(text.text) as { readonly code?: string; readonly message?: string })
    : undefined;
};

const structured = (result: McpSchema.CallToolResult) =>
  result.structuredContent as Record<string, unknown> & {
    readonly note?: string;
    readonly activeInstanceId?: string | null;
    readonly instance?: {
      readonly steps: ReadonlyArray<{
        readonly id: string;
        readonly state: { readonly _tag: string };
      }>;
    } | null;
    readonly templates?: ReadonlyArray<{ readonly id: string }>;
  };

/** `tool {"json"}` as the note prints it, called exactly as printed. */
const callPrinted = (line: string) => {
  const space = line.indexOf(" ");
  return call(line.slice(0, space), JSON.parse(line.slice(space + 1)) as Record<string, unknown>);
};

it.layer(layerFor(true))("thread workflow MCP tools", (it) => {
  it.effect(
    "drives a workflow from start to close, calling the note's printed calls as typed",
    () =>
      Effect.gen(function* () {
        const empty = structured(yield* call("thread_workflow_get", {}));
        assert.isNull(empty.activeInstanceId);
        assert.includeMembers(
          (empty.templates ?? []).map((template) => template.id),
          ["open-ended", "single-task"],
        );

        const started = yield* call("thread_workflow_start", { templateId: "open-ended" });
        assert.isFalse(started.isError);
        const note = structured(started).note ?? "";
        assert.match(note, /^<thread-workflow>/);
        const tickLine = note.split("\n").find((line) => line.startsWith("thread_workflow_tick "))!;
        const ticked = yield* callPrinted(
          tickLine
            .replace("<what you did and how you know it worked>", "stated the goal in one line")
            .replace(/<[^>]*>/, "the goal text"),
        );
        assert.isFalse(ticked.isError, JSON.stringify(ticked.content));
        assert.deepInclude(ticked.structuredContent as object, {
          progress: { total: 3, open: 2, currentPosition: 2 },
        });
        assert.match(
          (ticked.structuredContent as { next: string }).next,
          /thread_workflow_tick \{"stepId":"w1.2"/,
        );

        const afterTick = structured(yield* call("thread_workflow_get", {})).note ?? "";
        const skipLine = afterTick
          .split("\n")
          .find((line) => line.startsWith("thread_workflow_change "))!;
        assert.include(skipLine, '"stepId":"w1.2"');
        const skipped = yield* callPrinted(skipLine.replace("<why>", "already done"));
        assert.isFalse(skipped.isError, JSON.stringify(skipped.content));

        const inserted = yield* call("thread_workflow_change", {
          action: "insert",
          afterStepId: "w1.2",
          title: "Verify in the app",
          instructions: "Open the app and check.",
          reason: "the goal needs a live check",
        });
        assert.isFalse(inserted.isError, JSON.stringify(inserted.content));
        const steps = structured(inserted).instance?.steps ?? [];
        assert.deepStrictEqual(
          steps.map((step) => [step.id, step.state._tag]),
          [
            ["w1.1", "done"],
            ["w1.2", "skipped"],
            ["w1.4", "open"],
            ["w1.3", "open"],
          ],
        );

        const commented = yield* call("thread_workflow_change", {
          action: "comment",
          target: "w1",
          comment: "Continue after the idle check. Answered by the user.",
        });
        assert.isFalse(commented.isError);
        const reopened = yield* call("thread_workflow_change", {
          action: "reopen",
          target: "w1.1",
          reason: "the goal changed",
        });
        assert.isFalse(reopened.isError);

        const unfinished = yield* call("thread_workflow_close", {
          instanceId: "w1",
          outcome: "finished",
          reason: "done",
        });
        assert.strictEqual(failure(unfinished)?.code, "steps_unresolved");
        const abandoned = yield* call("thread_workflow_close", {
          instanceId: "w1",
          outcome: "abandoned",
          reason: "scope moved to another thread",
        });
        assert.isFalse(abandoned.isError);
        assert.isNull(structured(abandoned).activeInstanceId);
        const closedOne = structured(yield* call("thread_workflow_get", { instanceId: "w1" }));
        assert.strictEqual(closedOne.instance?.steps.length, 4);
      }),
  );

  it.effect("names the missing field when a change action is incomplete", () =>
    Effect.gen(function* () {
      const result = yield* call("thread_workflow_change", { action: "skip", stepId: "w1.1" });
      assert.deepInclude(failure(result), { code: "invalid_request" });
      assert.match(failure(result)?.message ?? "", /reason/);
      const noComment = yield* call("thread_workflow_tick", { stepId: "w1.1", comment: " " });
      assert.strictEqual(failure(noComment)?.code, "invalid_request");
    }),
  );

  it.effect("refuses every tool with `disabled` when the credential lacks the capability", () =>
    Effect.gen(function* () {
      for (const [name, args] of [
        ["thread_workflow_get", {}],
        ["thread_workflow_start", { templateId: "open-ended" }],
        ["thread_workflow_tick", { stepId: "w1.1", comment: "x" }],
        ["thread_workflow_change", { action: "skip", stepId: "w1.1", reason: "x" }],
        ["thread_workflow_close", { instanceId: "w1", outcome: "abandoned", reason: "x" }],
      ] as const) {
        const result = yield* call(name, args, ["orchestration"]);
        assert.strictEqual(failure(result)?.code, "disabled", name);
      }
      const server = yield* McpServer.McpServer;
      assert.includeMembers(
        server.tools.map(({ tool }) => tool.name),
        [
          "thread_workflow_get",
          "thread_workflow_start",
          "thread_workflow_tick",
          "thread_workflow_change",
          "thread_workflow_close",
        ],
      );
    }),
  );
});

it.layer(layerFor(false))("thread workflow MCP tools with the flag off", (it) => {
  it.effect("refuses a start but lets an open instance be read, ticked and closed", () =>
    Effect.gen(function* () {
      const refused = yield* call("thread_workflow_start", { templateId: "open-ended" });
      assert.strictEqual(failure(refused)?.code, "disabled");
      const service = yield* ThreadWorkflowService;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ threadWorkflowsEnabled: true });
      yield* service.apply({ _tag: "user" }, threadId, {
        _tag: "start",
        templateId: "open-ended" as never,
      });
      yield* settings.updateSettings({ threadWorkflowsEnabled: false });
      const read = structured(yield* call("thread_workflow_get", {}));
      assert.strictEqual(read.activeInstanceId, "w1");
      assert.strictEqual(read.enabled, false);
      const ticked = yield* call("thread_workflow_tick", { stepId: "w1.1", comment: "done" });
      assert.isFalse(ticked.isError);
      const closed = yield* call("thread_workflow_close", {
        instanceId: "w1",
        outcome: "abandoned",
        reason: "flag off",
      });
      assert.isFalse(closed.isError);
    }),
  );
});

it.layer(layerFor(true, { unreadableStore: true }))(
  "thread workflow MCP tools, store unreadable",
  (it) => {
    it.effect("answers store_unavailable instead of failing the server", () =>
      Effect.gen(function* () {
        for (const [name, args] of [
          ["thread_workflow_get", {}],
          ["thread_workflow_start", { templateId: "open-ended" }],
        ] as const) {
          const refused = failure(yield* call(name, args));
          assert.strictEqual(refused?.code, "store_unavailable");
          assert.match(refused?.message ?? "", /could not be loaded/);
        }
      }),
    );
  },
);
