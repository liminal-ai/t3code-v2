import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No run reaches a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "agent-pin" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:agent-pin"),
      title: threadId,
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return orchestrator;
  });

it.layer(layerTest)("the pin an agent thread relies on", (it) => {
  it.effect("pinning wakes a snoozed thread", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("agent-pin-snoozed");
      const orchestrator = yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("agent-pin-snooze"),
        threadId,
        snoozedUntil: "2099-01-01T09:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("agent-pin-pin-snoozed"),
        threadId,
      });
      const { thread } = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(thread.pinnedAt);
      assert.isNull(thread.snoozedUntil);
    }),
  );

  it.effect("settling removes the pin and keeps the thread's tags", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("agent-pin-settled");
      const orchestrator = yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("agent-pin-pin"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.tag.set",
        commandId: CommandId.make("agent-pin-tag"),
        threadId,
        tag: "agent",
        tagged: true,
      });
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("agent-pin-settle"),
        threadId,
      });
      const { thread } = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(thread.pinnedAt);
      assert.equal(thread.settledOverride, "settled");
      assert.deepEqual(thread.tags, ["agent"]);
    }),
  );
});
