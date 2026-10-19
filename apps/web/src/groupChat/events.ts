import { useAtomValue } from "@effect/atom-react";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import { GroupChatStreamEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentSession } from "../state/session";
import { applyStreamEvent, streamClosed, streamOpened } from "./store";

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

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(GroupChatStreamEvent));

const openEventSource = (access: DeviceHubAccess, onOpen: () => void, onError: () => void) => {
  const source = new EventSource(withDeviceHubQuery(`${access.httpBase}/events`, access), {
    withCredentials: access.credentials,
  });
  source.addEventListener("open", onOpen);
  source.addEventListener("message", (event) => {
    let decoded: GroupChatStreamEvent;
    try {
      decoded = decodeEvent(String(event.data));
    } catch {
      return;
    }
    applyStreamEvent(decoded);
  });
  source.addEventListener("error", onError);
  return () => source.close();
};

export function useGroupChatEvents(enabled: boolean): void {
  const result = useAtomValue(eventsAccessAtom);
  const access = AsyncResult.isSuccess(result) ? result.value : null;
  // The stream has no replay, so whatever was committed between a read and the open, or while
  // the stream was down, is read again on every open.
  useEffect(() => {
    if (!enabled || access === null) return;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const close = openEventSource(access, streamOpened, () => {
      close();
      streamClosed();
      reconnect = setTimeout(reconnectWithFreshTicket, RECONNECT_DELAY_MS);
    });
    return () => {
      close();
      streamClosed();
      clearTimeout(reconnect);
    };
  }, [enabled, access]);
}
