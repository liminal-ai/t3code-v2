import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as CommandPolicy from "../../orchestration-v2/CommandPolicy.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "../ProviderOrchestrationAdapterInfrastructure.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { ClaudeDriver, makeClaudeDriver, type ClaudeQuerySeamInput } from "./ClaudeDriver.ts";

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
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const createInstance = (driver: typeof ClaudeDriver) =>
  driver.create({
    instanceId: ProviderInstanceId.make("claude_seam"),
    displayName: undefined,
    environment: [{ name: "T3_CLAUDE_SEAM_TEST", value: "instance", sensitive: false }],
    enabled: true,
    config: decodeClaudeSettings({ binaryPath: "~/bin/claude" }),
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

describe("ClaudeDriver query seam", () => {
  it.effect("keeps stock Claude on native forks and rollback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance(ClaudeDriver);
        const capabilities = yield* instance.orchestrationAdapter.getCapabilities();

        assert.deepEqual(yield* policyOutcomes(capabilities), {
          fork: "native_fork",
          rollback: "allowed",
        });
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("hands a kind's seam this instance's environment, home and config", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seamInputs: Array<ClaudeQuerySeamInput> = [];
        const driver = makeClaudeDriver({
          querySeam: (input) => {
            seamInputs.push(input);
            return {
              forkRefusal: "This kind of Claude thread can't be forked.",
              canRollback: false,
            };
          },
        });
        const instance = yield* createInstance(driver);
        const capabilities = yield* instance.orchestrationAdapter.getCapabilities();
        const { baseDir } = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const homeDirectory = yield* HostProcess.HomeDirectory;

        assert.equal(seamInputs.length, 1);
        assert.equal(seamInputs[0]!.baseDir, baseDir);
        assert.equal(seamInputs[0]!.environment.T3_CLAUDE_SEAM_TEST, "instance");
        assert.equal(seamInputs[0]!.config.binaryPath, path.join(homeDirectory, "bin", "claude"));
        assert.deepEqual(yield* policyOutcomes(capabilities), {
          fork: "portable_context",
          rollback: "refused",
        });
      }),
    ).pipe(Effect.provide(layerTest)),
  );
});
