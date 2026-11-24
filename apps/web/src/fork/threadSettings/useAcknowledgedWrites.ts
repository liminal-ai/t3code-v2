import type { ForkSettingsPatch } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { refusalOf, useRefreshAndWait } from "./forkSettingsState";

const REFRESH_RETRY_MS = 2_000;

export type WriteStatus = "saving" | "retrying" | null;

export function useAcknowledgedWrites<View>(
  atom: Atom.Atom<AsyncResult.AsyncResult<View, unknown>>,
  save: (patch: ForkSettingsPatch) => Promise<AtomCommandResult<View, unknown>>,
) {
  const query = useEnvironmentQuery(atom);
  const refreshAndWait = useRefreshAndWait(atom);
  const [acknowledged, setAcknowledged] = useState<View | null>(null);
  const [status, setStatus] = useState<WriteStatus>(null);
  const mounted = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends the refresh retry loop when the owner's card unmounts
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const write = async (patch: ForkSettingsPatch) => {
    setStatus("saving");
    const result = await save(patch);
    if (result._tag !== "Success") {
      setStatus(null);
      return refusalOf(result);
    }
    setAcknowledged(result.value);
    while ((await refreshAndWait()) === "stale" && mounted.current) {
      setStatus("retrying");
      await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_MS));
    }
    setAcknowledged(null);
    setStatus(null);
    return null;
  };

  return { data: acknowledged ?? query.data, status, write };
}
