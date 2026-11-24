import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { FORK_SETTINGS_WS_METHODS } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentThreadShells } from "../../state/threads";
import { waitForAtomValue } from "../../state/waitForAtomValue";

export const threadSettingsSignal = (shell: EnvironmentThreadShell | null) => {
  if (shell === null) return null;
  const run = shell.latestRun;
  return JSON.stringify([
    shell.providerInstanceId,
    shell.modelSelection,
    shell.activeProviderThreadId,
    run?.runId ?? null,
    run !== null && (run.turnEnded === true || run.completedAt !== null),
  ]);
};

export const threadSettingsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-settings:thread",
  tag: FORK_SETTINGS_WS_METHODS.getThread,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
  refreshTrigger: ({ environmentId, input }) => {
    const shell = environmentThreadShells.threadShellAtom(
      scopeThreadRef(environmentId, input.threadId),
    );
    return Atom.make((get) => threadSettingsSignal(get(shell)));
  },
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

export function useRefreshAndWait(atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>) {
  const registry = useContext(RegistryContext);
  return async () => {
    const before = registry.get(atom);
    registry.refresh(atom);
    await waitForAtomValue({
      registry,
      atom,
      predicate: (result) => result !== before && !result.waiting,
      timeoutMs: 15_000,
    });
  };
}

export const refusalOf = (result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : String(failure);
};
