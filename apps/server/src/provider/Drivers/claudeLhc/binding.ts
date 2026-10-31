import {
  engineBindingsAgree,
  type OrchestrationV2EngineBinding,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { ProviderEngineBindingTemplate } from "@t3tools/provider-core/server/driver";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

export function rowEngineBinding(
  row: OrchestrationV2ProviderThread,
): OrchestrationV2EngineBinding | null {
  return row.nativeMetadata?.engineBinding ?? null;
}

export function stampEngineBinding(
  seed: OrchestrationV2EngineBinding | undefined,
  instanceId: ProviderInstanceId,
): { readonly nativeMetadata?: OrchestrationV2ProviderThreadNativeMetadata } {
  return seed?.providerInstanceId === instanceId ? { nativeMetadata: { engineBinding: seed } } : {};
}

export function copyEngineBinding(
  source: OrchestrationV2ProviderThread,
  nativeMetadata: OrchestrationV2ProviderThreadNativeMetadata = {},
): { readonly nativeMetadata?: OrchestrationV2ProviderThreadNativeMetadata } {
  const engineBinding = rowEngineBinding(source);
  const merged = engineBinding === null ? nativeMetadata : { ...nativeMetadata, engineBinding };
  return Object.keys(merged).length === 0 ? {} : { nativeMetadata: merged };
}

export function checkClaudeEngineBinding(
  row: OrchestrationV2ProviderThread,
  template: ProviderEngineBindingTemplate | undefined,
  instanceId: ProviderInstanceId,
): Effect.Effect<void, ProviderAdapter.ProviderAdapterContinuationMismatchError> {
  const binding = rowEngineBinding(row);
  return engineBindingsAgree(binding, template)
    ? Effect.void
    : Effect.fail(
        new ProviderAdapter.ProviderAdapterContinuationMismatchError({
          driver: row.driver,
          providerThreadId: row.id,
          providerInstanceId: instanceId,
          rowContinuationKey: binding?.continuationKey ?? null,
          instanceContinuationKey: template?.continuationKey ?? null,
        }),
      );
}
