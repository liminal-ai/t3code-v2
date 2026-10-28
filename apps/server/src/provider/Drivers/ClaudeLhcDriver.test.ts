// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeLhcSettings,
  CommandId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as CommandPolicy from "../../orchestration-v2/CommandPolicy.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "../ProviderOrchestrationAdapterInfrastructure.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";
import { ClaudeLhcDriver, claudeLhcContinuationGroupKey } from "./ClaudeLhcDriver.ts";
import sidecarPin from "../../../../../lhc/sidecar.json" with { type: "json" };

const layerTest = ProviderOrchestrationAdapterInfrastructure.layer.pipe(
  Layer.provideMerge(ProviderHostLive.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), { prefix: "claude-lhc-driver-test" }),
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

/** The pinned package staged as a source build is, with its compiled entry under dist/. */
function stagePinnedSidecar(): string {
  const packageDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-lhc-pinned-"));
  NodeFS.mkdirSync(NodePath.join(packageDir, "dist"));
  NodeFS.writeFileSync(
    NodePath.join(packageDir, "package.json"),
    JSON.stringify({ name: sidecarPin.package, version: sidecarPin.version }),
  );
  const entry = NodePath.join(packageDir, "dist", "sidecar.js");
  NodeFS.writeFileSync(entry, "");
  return entry;
}

const createInstance = (environment: ProviderInstanceEnvironment) =>
  ClaudeLhcDriver.create({
    instanceId: ProviderInstanceId.make("claude-lhc"),
    displayName: undefined,
    environment,
    enabled: true,
    config: Schema.decodeSync(ClaudeLhcSettings)({}),
  });

const policyOutcomes = (capabilities: OrchestrationV2ProviderCapabilities) =>
  Effect.gen(function* () {
    const policy = yield* CommandPolicy.CommandPolicyV2;
    const input = {
      commandId: CommandId.make("command-claude-lhc"),
      threadId: ThreadId.make("thread-claude-lhc"),
      providerInstanceId: ProviderInstanceId.make("claude-lhc"),
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

describe("ClaudeLhcDriver", () => {
  it("registers its own kind beside stock Claude, with LHC's settings and windows", () => {
    assert.equal(ClaudeLhcDriver.driverKind, "claude-lhc");
    assert.equal(ClaudeLhcDriver.metadata.displayName, "Claude LHC");
    assert.equal(ClaudeLhcDriver.configSchema, ClaudeLhcSettings);
    assert.equal(ClaudeDriver.driverKind, "claudeAgent");
    const kinds: ReadonlyArray<string> = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
    assert.include(kinds, "claude-lhc");
    assert.equal(new Set(kinds).size, kinds.length);
    const { autoCompactWindow, lhcLowerBound, idleCompaction } = ClaudeLhcDriver.defaultConfig();
    assert.deepEqual(
      { autoCompactWindow, lhcLowerBound, idleCompaction },
      { autoCompactWindow: "700000", lhcLowerBound: "120000", idleCompaction: "off" },
    );
  });

  it("never shares a continuation group with a stock instance on the same Claude home", () => {
    assert.equal(
      claudeLhcContinuationGroupKey("claude:home:/home/lee/.claude"),
      "claude-lhc:home:/home/lee/.claude",
    );
  });

  it.effect(
    "reports why it cannot run when the sidecar is not configured, and offers no turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* createInstance([]);
          const snapshot = yield* instance.snapshot.getSnapshot;
          const capabilities = yield* instance.orchestrationAdapter.getCapabilities();

          assert.equal(instance.driverKind, "claude-lhc");
          assert.equal(snapshot.driver, "claude-lhc");
          assert.equal(snapshot.availability, "unavailable");
          assert.equal(snapshot.installed, false);
          assert.match(snapshot.unavailableReason ?? "", /Set CLAUDE_LHC_NODE/);
          assert.deepEqual(yield* policyOutcomes(capabilities), {
            fork: "portable_context",
            rollback: "refused",
          });
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect("refuses native forks and allows rollback once the pinned sidecar is staged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* createInstance([
          { name: "CLAUDE_LHC_NODE", value: process.execPath, sensitive: false },
          { name: "CLAUDE_LHC_SIDECAR", value: stagePinnedSidecar(), sensitive: false },
        ]);
        const snapshot = yield* instance.snapshot.getSnapshot;
        const capabilities = yield* instance.orchestrationAdapter.getCapabilities();

        assert.notEqual(snapshot.availability, "unavailable");
        assert.match(instance.continuationIdentity.continuationKey, /^claude-lhc:/);
        assert.deepEqual(yield* policyOutcomes(capabilities), {
          fork: "portable_context",
          rollback: "allowed",
        });
      }),
    ).pipe(Effect.provide(layerTest)),
  );
});
