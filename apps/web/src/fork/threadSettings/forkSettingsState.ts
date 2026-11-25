import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { request } from "@t3tools/client-runtime/rpc";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  FORK_SETTINGS_WS_METHODS,
  type ProviderInstanceId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { waitForAtomValue } from "../../state/waitForAtomValue";

export const threadSettingsSignal = (
  shell: EnvironmentThreadShell | null,
  awaitingServer: boolean,
) => {
  if (shell === null) return null;
  const run = shell.latestRun;
  return JSON.stringify([
    awaitingServer,
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
    const awaitingServer = threadEnvironment.pendingThreadIdsAtom(environmentId);
    return Atom.make((get) =>
      threadSettingsSignal(get(shell), get(awaitingServer).has(input.threadId)),
    );
  },
  execute: (input, _emit, previous) => {
    const shownModel = Option.getOrUndefined(previous)?.limbaseCompaction?.model;
    return request(
      FORK_SETTINGS_WS_METHODS.getThread,
      typeof shownModel === "string" ? { ...input, shownModel } : input,
    );
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

export const limbaseHomeOf = (config: unknown) =>
  typeof config === "object" && config !== null && "limbaseHome" in config
    ? String(config.limbaseHome).trim()
    : "";

export const hasLimbaseHome = (
  settings: Pick<ServerSettings, "providerInstances"> | undefined,
  instanceId: ProviderInstanceId | null,
) => {
  const entry = instanceId === null ? undefined : settings?.providerInstances[instanceId];
  return entry?.driver === "claudeAgent" && limbaseHomeOf(entry.config) !== "";
};

const instanceOf = (shell: EnvironmentThreadShell | null) => shell?.providerInstanceId ?? null;

export function useThreadOnLimbase(environmentId: EnvironmentId, threadId: ThreadId) {
  const instanceId = useAtomValue(
    environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId)),
    instanceOf,
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return hasLimbaseHome(config?.settings, instanceId);
}

export function useRefreshAndWait(atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>) {
  const registry = useContext(RegistryContext);
  return async () => {
    const before = registry.get(atom);
    registry.refresh(atom);
    const settled = await waitForAtomValue({
      registry,
      atom,
      predicate: (result) => result !== before && !result.waiting,
      timeoutMs: 15_000,
    });
    return settled && AsyncResult.isSuccess(registry.get(atom)) ? "fresh" : "stale";
  };
}

export const refusalOf = (result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : String(failure);
};
