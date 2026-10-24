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
import { WAITS_FOR_USER } from "../../../threadWorkflow/turnNote.ts";
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
        readonly title: string;
        readonly state: { readonly _tag: string };
      }>;
    } | null;
    readonly templates?: ReadonlyArray<{ readonly id: string }>;
  };

/** The whole workflow as `get` returns it, since mutations no longer carry it. */
const stepsOf = (view: ReturnType<typeof structured>) =>
  (view.instance?.steps ?? []).map((step) => [step.id, step.title, step.state._tag]);

/** `tool {"json"}` as the note prints it, called exactly as printed. */
const callPrinted = (line: string) => {
  const space = line.indexOf(" ");
  return call(line.slice(0, space), JSON.parse(line.slice(space + 1)) as Record<string, unknown>);
};

const stage = (title: string) => ({ title, instructions: `Do ${title.toLowerCase()}.` });

it.layer(layerFor(true))("thread workflow MCP tools", (it) => {
  it.effect("writes the plan in one start call and answers every mutation with a short ack", () =>
    Effect.gen(function* () {
      const empty = structured(yield* call("thread_workflow_get", {}));
      assert.isNull(empty.activeInstanceId);
      assert.includeMembers(
        (empty.templates ?? []).map((template) => template.id),
        ["open-ended", "single-task"],
      );

      const started = yield* call("thread_workflow_start", {
        templateId: "open-ended",
        title: "Slice 1",
        steps: [stage("Groundwork"), stage("Scope"), { ...stage("Build"), waitsForUser: true }],
      });
      assert.isFalse(started.isError, JSON.stringify(started.content));
      assert.deepStrictEqual(Object.keys(started.structuredContent as object).toSorted(), [
        "currentStep",
        "instanceId",
        "next",
        "progress",
        "revision",
      ]);
      assert.deepInclude(started.structuredContent as object, {
        instanceId: "w1",
        progress: { total: 4, open: 4, currentPosition: 1 },
        currentStep: {
          id: "w1.2",
          title: "Groundwork",
          instructions: "Do groundwork.",
          waitsForUser: false,
        },
      });
      const planned = structured(yield* call("thread_workflow_get", {}));
      assert.deepStrictEqual(stepsOf(planned), [
        ["w1.2", "Groundwork", "open"],
        ["w1.3", "Scope", "open"],
        ["w1.4", "Build", "open"],
        ["w1.1", "Confirm done with the user", "open"],
      ]);
      const note = planned.note ?? "";
      assert.match(note, /step 1 of 4: Groundwork/);
      const tickLine = note.split("\n").find((line) => line.startsWith("thread_workflow_tick "))!;
      const ticked = yield* callPrinted(
        tickLine.replace("<what you did and how you know it worked>", "repo and judge set up"),
      );
      assert.isFalse(ticked.isError, JSON.stringify(ticked.content));
      assert.deepInclude(ticked.structuredContent as object, {
        progress: { total: 4, open: 3, currentPosition: 2 },
      });
      assert.match(
        (ticked.structuredContent as { next: string }).next,
        /thread_workflow_tick \{"stepId":"w1.3"/,
      );

      const skipped = yield* call("thread_workflow_change", {
        action: "skip",
        stepId: "w1.3",
        reason: "already scoped",
      });
      assert.isFalse(skipped.isError, JSON.stringify(skipped.content));
      assert.deepInclude(skipped.structuredContent as object, {
        instanceId: "w1",
        progress: { total: 4, open: 2, currentPosition: 3 },
        currentStep: { id: "w1.4", title: "Build", instructions: "Do build.", waitsForUser: true },
      });
      assert.isTrue(
        (skipped.structuredContent as { next: string }).next.startsWith(
          `${WAITS_FOR_USER} thread_workflow_tick {"stepId":"w1.4"`,
        ),
      );
      assert.notProperty(skipped.structuredContent as object, "instance");

      const inserted = yield* call("thread_workflow_change", {
        action: "insert",
        afterStepId: "w1.4",
        title: "Verify in the app",
        instructions: "Open the app and check.",
        reason: "the goal needs a live check",
      });
      assert.isFalse(inserted.isError, JSON.stringify(inserted.content));
      assert.deepStrictEqual(
        stepsOf(structured(yield* call("thread_workflow_get", {}))).map(([id]) => id),
        ["w1.2", "w1.3", "w1.4", "w1.5", "w1.1"],
      );

      const reopened = yield* call("thread_workflow_change", {
        action: "reopen",
        target: "w1.2",
        reason: "the goal changed",
      });
      assert.isFalse(reopened.isError);
      assert.deepInclude(reopened.structuredContent as object, {
        currentStep: {
          id: "w1.2",
          title: "Groundwork",
          instructions: "Do groundwork.",
          waitsForUser: false,
        },
      });
      assert.notInclude((reopened.structuredContent as { next: string }).next, WAITS_FOR_USER);

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
      assert.deepInclude(abandoned.structuredContent as object, {
        instanceId: "w1",
        next: "thread_workflow_get {}",
      });
      const after = structured(yield* call("thread_workflow_get", {}));
      assert.isNull(after.activeInstanceId);
      const closedOne = structured(yield* call("thread_workflow_get", { instanceId: "w1" }));
      assert.strictEqual(closedOne.instance?.steps.length, 5);
    }),
  );

  it.effect("refuses a plan over the step cap before writing anything", () =>
    Effect.gen(function* () {
      const refused = yield* call("thread_workflow_start", {
        templateId: "open-ended",
        steps: Array.from({ length: 8 }, (_, index) => stage(`Stage ${index + 1}`)),
      });
      assert.strictEqual(failure(refused)?.code, "invalid_request");
      assert.match(failure(refused)?.message ?? "", /at most 8 steps/);
      assert.isNull(structured(yield* call("thread_workflow_get", {})).activeInstanceId);

      const fits = yield* call("thread_workflow_start", {
        templateId: "open-ended",
        steps: Array.from({ length: 7 }, (_, index) => stage(`Stage ${index + 1}`)),
      });
      assert.isFalse(fits.isError, JSON.stringify(fits.content));
      assert.deepInclude(fits.structuredContent as object, {
        progress: { total: 8, open: 8, currentPosition: 1 },
      });
      const ninth = yield* call("thread_workflow_change", {
        action: "insert",
        title: "One more",
        instructions: "More.",
        reason: "found more work",
      });
      assert.strictEqual(failure(ninth)?.code, "too_many_steps");
      assert.match(failure(ninth)?.message ?? "", /"action":"comment"/);

      const samePlanAgain = yield* call("thread_workflow_start", {
        templateId: "open-ended",
        steps: [stage("Different")],
      });
      assert.strictEqual(failure(samePlanAgain)?.code, "instance_open");
      yield* call("thread_workflow_close", {
        instanceId: "w2",
        outcome: "abandoned",
        reason: "test over",
      });
    }),
  );

  it.effect("replays a planned start under the same request id without doubling the plan", () =>
    Effect.gen(function* () {
      const args = {
        templateId: "open-ended",
        steps: [stage("One"), stage("Two")],
        requestId: "plan-1",
      };
      const first = yield* call("thread_workflow_start", args);
      assert.isFalse(first.isError, JSON.stringify(first.content));
      const again = yield* call("thread_workflow_start", args);
      assert.isFalse(again.isError, JSON.stringify(again.content));
      assert.deepStrictEqual(again.structuredContent, first.structuredContent);
      assert.deepStrictEqual(
        stepsOf(structured(yield* call("thread_workflow_get", {}))).map(([, title]) => title),
        ["One", "Two", "Confirm done with the user"],
      );
    }),
  );

  it.effect("acks the instance a replayed start created, not the one open now", () =>
    Effect.gen(function* () {
      const open = structured(yield* call("thread_workflow_get", {})).activeInstanceId!;
      yield* call("thread_workflow_close", { instanceId: open, outcome: "abandoned", reason: "x" });
      const plannedAgain = yield* call("thread_workflow_start", {
        templateId: "open-ended",
        steps: [stage("One"), stage("Two")],
        requestId: "plan-1",
      });
      assert.isFalse(plannedAgain.isError, JSON.stringify(plannedAgain.content));
      assert.deepInclude(plannedAgain.structuredContent as object, {
        instanceId: open,
        next: "thread_workflow_get {}",
      });

      const plainArgs = { templateId: "open-ended", title: "Plain", requestId: "plain-1" };
      const plain = yield* call("thread_workflow_start", plainArgs);
      assert.isFalse(plain.isError, JSON.stringify(plain.content));
      const plainAck = plain.structuredContent as {
        readonly instanceId: string;
        readonly currentStep: { readonly id: string; readonly waitsForUser: boolean };
        readonly next: string;
      };
      assert.isTrue(plainAck.currentStep.waitsForUser);
      assert.isTrue(plainAck.next.startsWith(`${WAITS_FOR_USER} thread_workflow_tick `));
      yield* call("thread_workflow_close", {
        instanceId: plainAck.instanceId,
        outcome: "abandoned",
        reason: "x",
      });
      const other = yield* call("thread_workflow_start", {
        templateId: "open-ended",
        title: "Other",
      });
      const otherId = (other.structuredContent as { readonly instanceId: string }).instanceId;
      assert.notStrictEqual(otherId, plainAck.instanceId);

      const plainAgain = yield* call("thread_workflow_start", plainArgs);
      assert.isFalse(plainAgain.isError, JSON.stringify(plainAgain.content));
      assert.deepInclude(plainAgain.structuredContent as object, {
        instanceId: plainAck.instanceId,
        next: "thread_workflow_get {}",
      });
      yield* call("thread_workflow_close", {
        instanceId: otherId,
        outcome: "abandoned",
        reason: "x",
      });
    }),
  );

  it.effect("acks the reopened instance an unanchored insert went into, not a later start", () =>
    Effect.gen(function* () {
      const startClosed = (title: string) =>
        Effect.gen(function* () {
          const result = yield* call("thread_workflow_start", { templateId: "open-ended", title });
          const { instanceId } = result.structuredContent as { readonly instanceId: string };
          yield* call("thread_workflow_close", { instanceId, outcome: "abandoned", reason: "x" });
          return instanceId;
        });
      const reopenedId = yield* startClosed("Reopened later");
      const laterId = yield* startClosed("Started later");
      const reopened = yield* call("thread_workflow_change", {
        action: "reopen",
        target: reopenedId,
        reason: "more to do",
      });
      assert.isFalse(reopened.isError, JSON.stringify(reopened.content));

      const insertArgs = {
        action: "insert",
        title: "Late step",
        instructions: "Do it.",
        reason: "found more work",
        requestId: "insert-after-reopen",
      };
      const first = yield* call("thread_workflow_change", insertArgs);
      assert.isFalse(first.isError, JSON.stringify(first.content));
      assert.strictEqual(
        (first.structuredContent as { readonly instanceId: string }).instanceId,
        reopenedId,
      );
      const again = yield* call("thread_workflow_change", insertArgs);
      assert.strictEqual(
        (again.structuredContent as { readonly instanceId: string }).instanceId,
        reopenedId,
      );
      assert.notStrictEqual(reopenedId, laterId);
      yield* call("thread_workflow_close", {
        instanceId: reopenedId,
        outcome: "abandoned",
        reason: "x",
      });
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
