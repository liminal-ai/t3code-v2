import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  ProviderInstanceId,
  ThreadId,
  type ProviderInstanceEnvironment,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as CommandPolicy from "../../orchestration-v2/CommandPolicy.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "../ProviderOrchestrationAdapterInfrastructure.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { ClaudeProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const layerTest = ProviderOrchestrationAdapterInfrastructure.layer.pipe(
  Layer.provideMerge(ProviderHostLive.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), { prefix: "claude-driver-test" }),
      ServerSettings.layerTest(),
      Layer.mock(ServerSecretStore.ServerSecretStore)({}),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
        ),
      ),
      ProviderLatestVersions.layer,
      McpProviderSessions.layer,
      ModelManifest.layerTest,
      ResetCreditCoordinator.layerTest,
      PortScanner.layerTest,
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const CLAUDE_HOME = "/home/test/.claude-work";

const createInstance = (
  config: Record<string, unknown> = {},
  environment: ProviderInstanceEnvironment = [],
) =>
  ClaudeDriver.create({
    instanceId: ProviderInstanceId.make("claude_seam"),
    displayName: undefined,
    environment,
    enabled: true,
    config: decodeClaudeSettings({ binaryPath: "~/bin/claude", ...config }),
  });

const lhcConfig = (lhcCompactTrigger: string, lhcCompactTarget: string) => ({
  homePath: CLAUDE_HOME,
  contextEngine: "claude-lhc",
  lhcCompactTrigger,
  lhcCompactTarget,
  autoCompactWindow: "300000",
});

const lhcTemplate = (compact: { readonly trigger: number; readonly target: number } | null) => ({
  engine: "claude-lhc" as const,
  continuationKey: `claude-lhc:home:${CLAUDE_HOME}`,
  claudeHome: CLAUDE_HOME,
  compact,
  nativeContinuation: "required" as const,
  compaction: "provider" as const,
});

const policyOutcomes = (capabilities: OrchestrationV2ProviderCapabilities) =>
  Effect.gen(function* () {
    const policy = yield* CommandPolicy.CommandPolicyV2;
    const input = {
      commandId: CommandId.make("command-claude-seam"),
      threadId: ThreadId.make("thread-claude-seam"),
      providerInstanceId: ProviderInstanceId.make("claude_seam"),
      capabilities,
    };
    const fork = yield* policy.decideForkExecution({
      ...input,
      sameProvider: true,
      hasStrongNativeSource: true,
      sourceRunStatus: "completed",
      fromSpecificTurn: true,
    });
    const rollback = yield* policy.ensureRollback(input).pipe(
      Effect.as("allowed" as const),
      Effect.orElseSucceed(() => "refused" as const),
    );
    return { fork, rollback };
  }).pipe(Effect.provide(CommandPolicy.layer));

describe("ClaudeDriver", () => {
  it.effect("keeps stock Claude on native forks and rollback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance();
        const capabilities = yield* instance.orchestrationAdapter.getCapabilities();

        assert.deepEqual(yield* policyOutcomes(capabilities), {
          fork: "native_fork",
          rollback: "allowed",
        });
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("builds a stock row with the home key, stock capabilities and no template", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance({ homePath: CLAUDE_HOME });

        assert.strictEqual(
          instance.continuationIdentity.continuationKey,
          `claude:home:${CLAUDE_HOME}`,
        );
        assert.isUndefined(instance.engineBinding);
        assert.deepEqual(
          yield* instance.orchestrationAdapter.getCapabilities(),
          ClaudeProviderCapabilitiesV2,
        );
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("builds an LHC row with its key, its capabilities and its template", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance(lhcConfig("700000", "140000"));
        const capabilities = yield* instance.orchestrationAdapter.getCapabilities();
        const snapshot = yield* instance.snapshot.refresh;

        assert.strictEqual(
          instance.continuationIdentity.continuationKey,
          `claude-lhc:home:${CLAUDE_HOME}`,
        );
        assert.strictEqual(snapshot.continuation?.groupKey, `claude-lhc:home:${CLAUDE_HOME}`);
        assert.deepEqual(instance.engineBinding, lhcTemplate({ trigger: 700000, target: 140000 }));
        assert.isFalse(capabilities.turns.supportsActiveSteering);
        assert.deepEqual(yield* policyOutcomes(capabilities), {
          fork: "native_fork",
          rollback: "allowed",
        });
        assert.notInclude(snapshot.message ?? "", "LHC");
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "keeps an incomplete LHC row on its key with an error status that names the fields",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* createInstance(lhcConfig("", ""));
          const snapshot = yield* instance.snapshot.refresh;

          assert.strictEqual(
            instance.continuationIdentity.continuationKey,
            `claude-lhc:home:${CLAUDE_HOME}`,
          );
          assert.deepEqual(instance.engineBinding, lhcTemplate(null));
          assert.strictEqual(snapshot.status, "error");
          assert.strictEqual(
            snapshot.message,
            "Set LHC compact trigger and LHC compact target to run LHC threads.",
          );
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps an LHC row with no runtime on its key with an error status", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance(lhcConfig("40000", "20000"), [
          { name: "CLAUDE_LHC_NODE", value: "/missing/node", sensitive: false },
          { name: "CLAUDE_LHC_SIDECAR", value: "/missing/sidecar.js", sensitive: false },
        ]);
        const snapshot = yield* instance.snapshot.refresh;

        assert.deepEqual(instance.engineBinding, lhcTemplate({ trigger: 40000, target: 20000 }));
        assert.strictEqual(snapshot.status, "error");
        assert.strictEqual(snapshot.message, "Node for claude-lhc not found at /missing/node.");
      }),
    ).pipe(Effect.provide(layerTest)),
  );
});
