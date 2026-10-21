import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "./runtime";

export const environmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);

/** Reads the registry itself, which a registration has updated by the time it returns. */
export const readEnvironmentCatalogEntries = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:read-catalog-entries",
  execute: (_input: void) =>
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.flatMap((registry) => SubscriptionRef.get(registry.entries)),
    ),
});
