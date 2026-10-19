import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "@t3tools/client-runtime/rpc";
import type { GroupChatGroup, GroupChatUnavailableReason } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentSession } from "../state/session";

export type GroupChatSnapshotState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly groups: ReadonlyArray<GroupChatGroup> }
  | { readonly status: "unavailable"; readonly reason: GroupChatUnavailableReason }
  | { readonly status: "failed"; readonly message: string };

const SNAPSHOT_TIMEOUT_MS = 15_000;

const fetchSnapshot = (prepared: PreparedConnection) =>
  Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiGroupClient(prepared.httpBaseUrl, "groupChat");
    const authorization = prepared.httpAuthorization;
    if (authorization?._tag === "Dpop") {
      return { status: "failed", message: "Group chat is only available on this server." } as const;
    }
    const request = client
      .snapshot({
        headers: authorization === null ? {} : { authorization: `Bearer ${authorization.token}` },
      })
      .pipe(
        Effect.map((snapshot): GroupChatSnapshotState => ({ status: "ready", ...snapshot })),
        Effect.catchTags({
          GroupChatUnavailable: (error) =>
            Effect.succeed<GroupChatSnapshotState>({ status: "unavailable", reason: error.reason }),
        }),
      );
    return yield* executeEnvironmentHttpRequest(
      makeEnvironmentHttpApiUrlBuilder(prepared.httpBaseUrl).groupChat.snapshot(),
      SNAPSHOT_TIMEOUT_MS,
      authorization === null
        ? request.pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }),
          )
        : request,
    );
  });

export const groupChatSnapshotAtom = connectionAtomRuntime.atom((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return Effect.never;
  const prepared = Option.getOrNull(
    get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  if (prepared === null) return Effect.never;
  return fetchSnapshot(prepared);
});

export function refreshGroupChatSnapshot(): void {
  appAtomRegistry.refresh(groupChatSnapshotAtom);
}

export function useGroupChatSnapshot(): GroupChatSnapshotState {
  const result = useAtomValue(groupChatSnapshotAtom);
  if (AsyncResult.isSuccess(result)) return result.value;
  if (AsyncResult.isFailure(result)) {
    return { status: "failed", message: "Group chat could not reach this server." };
  }
  return { status: "loading" };
}
