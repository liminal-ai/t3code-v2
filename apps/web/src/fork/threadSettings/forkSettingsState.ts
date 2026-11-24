import { FORK_SETTINGS_WS_METHODS } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";

export const threadSettingsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-settings:thread",
  tag: FORK_SETTINGS_WS_METHODS.getThread,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
});

export const setThreadSettings = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:fork-settings:set-thread",
  tag: FORK_SETTINGS_WS_METHODS.setThread,
});

export const instanceSettingsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-settings:instance",
  tag: FORK_SETTINGS_WS_METHODS.getInstance,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
});

export const setInstanceSettings = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:fork-settings:set-instance",
  tag: FORK_SETTINGS_WS_METHODS.setInstance,
});

/** What a refused save says, or null for a save that went through or was cancelled. */
export const refusalOf = (result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : String(failure);
};
