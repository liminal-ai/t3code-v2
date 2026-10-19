import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
  RemoteEnvironmentAuthFetchError,
} from "@t3tools/client-runtime/rpc";
import { GroupChatNotFound } from "@t3tools/contracts";
import type {
  GroupChatCommand,
  GroupChatCommandError,
  GroupChatDelivery,
  GroupChatDeliveryId,
  GroupChatDispatchResult,
  GroupChatGroup,
  GroupChatGroupId,
  GroupChatGroupPage,
  GroupChatGroupQuery,
  GroupChatMember,
  GroupChatUnavailable,
  GroupChatUnavailableReason,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { toastManager } from "../components/ui/toast";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentSession } from "../state/session";

export type GroupChatSnapshotState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly groups: ReadonlyArray<GroupChatGroup>;
      readonly members: ReadonlyArray<GroupChatMember>;
    }
  | { readonly status: "unavailable"; readonly reason: GroupChatUnavailableReason }
  | { readonly status: "failed"; readonly message: string };

const SNAPSHOT_TIMEOUT_MS = 15_000;
const SNAPSHOT_RETRY_DELAY_MS = 5_000;

const notServedByT3 = {
  status: "failed",
  message: "Group chat works only on the T3 server that serves this page.",
} as const satisfies GroupChatSnapshotState;

const fetchSnapshot = (prepared: PreparedConnection) =>
  Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiGroupClient(prepared.httpBaseUrl, "groupChat");
    const authorization = prepared.httpAuthorization;
    if (authorization?._tag === "Dpop") return notServedByT3;
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

const groupChatSnapshotAtom = connectionAtomRuntime.atom((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return get(environmentCatalog.catalogValueAtom).isReady
      ? Effect.succeed(notServedByT3)
      : Effect.never;
  }
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
  // The event stream opens only once a snapshot is ready, so nothing else
  // would refetch after a transient failure while the connection stays up.
  const retryDue = AsyncResult.isFailure(result) && !result.waiting;
  useEffect(() => {
    if (!retryDue) return;
    const retry = setTimeout(refreshGroupChatSnapshot, SNAPSHOT_RETRY_DELAY_MS);
    return () => clearTimeout(retry);
  }, [retryDue]);
  if (AsyncResult.isSuccess(result)) return result.value;
  if (AsyncResult.isFailure(result)) {
    return { status: "failed", message: "Group chat could not reach this server." };
  }
  return { status: "loading" };
}

type GroupChatClient = Effect.Success<
  ReturnType<typeof makeEnvironmentHttpApiGroupClient<"groupChat">>
>;
type BearerHeaders = { readonly authorization?: string };

export class GroupChatRequestError extends Error {
  override readonly name = "GroupChatRequestError";
  readonly notFound: boolean;
  constructor(message: string, notFound = false) {
    super(message);
    this.notFound = notFound;
  }
}

const isGroupChatNotFound = Schema.is(GroupChatNotFound);

const isNotFound = (cause: unknown) =>
  cause instanceof RemoteEnvironmentAuthFetchError && isGroupChatNotFound(cause.cause);

const REQUEST_TIMEOUT_MS = 30_000;

const describeFailure = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tagged = cause as { readonly _tag: string; readonly message?: unknown };
    switch (tagged._tag) {
      case "GroupChatUnavailable":
      case "GroupChatNotFound":
      case "GroupChatInvalid":
      case "GroupChatRefused":
      case "GroupChatThreadRefused":
        return typeof tagged.message === "string" ? tagged.message : tagged._tag;
      case "EnvironmentScopeRequiredError":
        return "This session may not operate group chat on this server.";
      case "RemoteEnvironmentAuthTimeoutError":
        return "The server did not answer in time.";
    }
  }
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  return "Group chat could not reach this server.";
};

const groupChatRequest = <A, E>(
  path: (urls: ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>["groupChat"]) => string,
  call: (
    client: GroupChatClient,
    headers: BearerHeaders,
  ) => Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> => {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  const prepared =
    environmentId === null
      ? null
      : Option.getOrNull(
          appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
        );
  if (prepared === null || prepared.httpAuthorization?._tag === "Dpop") {
    return Promise.reject(new GroupChatRequestError(notServedByT3.message));
  }
  const authorization = prepared.httpAuthorization;
  const request = Effect.flatMap(
    makeEnvironmentHttpApiGroupClient(prepared.httpBaseUrl, "groupChat"),
    (client) =>
      call(
        client,
        authorization === null ? {} : { authorization: `Bearer ${authorization.token}` },
      ),
  );
  return runtime
    .runPromise(
      executeEnvironmentHttpRequest(
        path(makeEnvironmentHttpApiUrlBuilder(prepared.httpBaseUrl).groupChat),
        REQUEST_TIMEOUT_MS,
        authorization === null
          ? request.pipe(
              Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }),
            )
          : request,
      ),
    )
    .catch((cause: unknown) => {
      throw new GroupChatRequestError(describeFailure(cause), isNotFound(cause));
    });
};

export const fetchGroupPage = (
  groupId: GroupChatGroupId,
  query: GroupChatGroupQuery,
): Promise<GroupChatGroupPage> =>
  groupChatRequest(
    (urls) => urls.group({ params: { groupId }, query }),
    (client, headers) => client.group({ params: { groupId }, query, headers }),
  );

export const fetchDelivery = (deliveryId: GroupChatDeliveryId): Promise<GroupChatDelivery> =>
  groupChatRequest(
    (urls) => urls.delivery({ params: { deliveryId } }),
    (client, headers) => client.delivery({ params: { deliveryId }, headers }),
  );

export const dispatchGroupChat = (command: GroupChatCommand): Promise<GroupChatDispatchResult> =>
  groupChatRequest(
    (urls) => urls.dispatch(),
    (client, headers) => (client.dispatch as DispatchCall)({ payload: command, headers }),
  );

/** `client.dispatch` is typed per command; this is its shape for the whole union. */
type DispatchCall = (input: {
  readonly payload: GroupChatCommand;
  readonly headers: BearerHeaders;
}) => Effect.Effect<
  GroupChatDispatchResult,
  GroupChatCommandError | GroupChatUnavailable | Error,
  HttpClient.HttpClient
>;

export async function attempt<A>(run: () => Promise<A>): Promise<A | undefined> {
  try {
    return await run();
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Group chat",
      description: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
