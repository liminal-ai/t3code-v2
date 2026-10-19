import { useAtomValue } from "@effect/atom-react";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentSession } from "../state/session";
import { refreshGroupChatSnapshot } from "./api";

const GROUP_CHAT_BASE_PATH = "/api/group-chat";
const RECONNECT_DELAY_MS = 5_000;

const eventsAccessAtom = connectionAtomRuntime
  .atom((get) => {
    const environmentId = get(primaryEnvironmentIdAtom);
    if (environmentId === null) return Effect.never;
    const prepared = Option.getOrNull(
      get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    if (prepared === null) return Effect.never;
    return resolveDeviceHubAccess({ prepared, hubBasePath: GROUP_CHAT_BASE_PATH });
  })
  .pipe(Atom.withLabel("group-chat-events-access"));

const reconnectWithFreshTicket = () => appAtomRegistry.refresh(eventsAccessAtom);

const openEventSource = (access: DeviceHubAccess, onMessage: () => void, onError: () => void) => {
  const source = new EventSource(withDeviceHubQuery(`${access.httpBase}/events`, access), {
    withCredentials: access.credentials,
  });
  source.addEventListener("message", onMessage);
  source.addEventListener("error", onError);
  return () => source.close();
};

export function useGroupChatEvents(enabled: boolean): void {
  const result = useAtomValue(eventsAccessAtom);
  const access = AsyncResult.isSuccess(result) ? result.value : null;
  useEffect(() => {
    if (!enabled || access === null) return;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const close = openEventSource(access, refreshGroupChatSnapshot, () => {
      close();
      reconnect = setTimeout(reconnectWithFreshTicket, RECONNECT_DELAY_MS);
    });
    return () => {
      close();
      clearTimeout(reconnect);
    };
  }, [enabled, access]);
}
