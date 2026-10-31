import {
  engineBindingsAgree,
  type OrchestrationV2EngineBinding,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

/** An instance's binding before it names the instance. Every new LHC row on the instance starts from it. */
export type ClaudeEngineBindingTemplate = Omit<OrchestrationV2EngineBinding, "providerInstanceId">;

/** The engine a provider row's native session runs on. Null means stock Claude. */
export function rowEngineBinding(
  row: OrchestrationV2ProviderThread,
): OrchestrationV2EngineBinding | null {
  return row.nativeMetadata?.engineBinding ?? null;
}

/** A new row's metadata from the thread's seed, which applies only to the instance it names. */
export function stampEngineBinding(
  seed: OrchestrationV2EngineBinding | undefined,
  instanceId: ProviderInstanceId,
): { readonly nativeMetadata?: OrchestrationV2ProviderThreadNativeMetadata } {
  return seed?.providerInstanceId === instanceId ? { nativeMetadata: { engineBinding: seed } } : {};
}

/**
 * `nativeMetadata` for a row built from `source`, such as a fork or a thread-start reset. The new
 * row keeps the source's binding, so it keeps the source's pair after the instance's defaults change.
 */
export function copyEngineBinding(
  source: OrchestrationV2ProviderThread,
  nativeMetadata: OrchestrationV2ProviderThreadNativeMetadata = {},
): { readonly nativeMetadata?: OrchestrationV2ProviderThreadNativeMetadata } {
  const engineBinding = rowEngineBinding(source);
  const merged = engineBinding === null ? nativeMetadata : { ...nativeMetadata, engineBinding };
  return Object.keys(merged).length === 0 ? {} : { nativeMetadata: merged };
}

/** Fails when `row` would continue on an engine or Claude home other than its instance's. */
export function checkClaudeEngineBinding(
  row: OrchestrationV2ProviderThread,
  template: ClaudeEngineBindingTemplate | undefined,
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
