import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "../startupAccess.ts";

export class GroupChatReach extends Context.Service<
  GroupChatReach,
  {
    /** True on a non-loopback `--host`, or while the environment is linked to T3 Connect. */
    readonly exposed: Effect.Effect<boolean>;
    /** The origin the server knows itself by, used in hook URLs when a member sets none. */
    readonly origin: string;
  }
>()("t3/groupChat/reach/GroupChatReach") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const loopback = isLoopbackHost(config.host);
  const host =
    loopback || isWildcardHost(config.host) ? "127.0.0.1" : formatHostForUrl(config.host!);
  // Read on every post, so unsigned posts are refused the moment T3 Connect is linked.
  const linkedOrUnreadable = secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.map(Option.isSome),
    Effect.orElseSucceed(() => true),
  );
  return GroupChatReach.of({
    exposed: loopback ? linkedOrUnreadable : Effect.succeed(true),
    origin: `http://${host}:${config.port}`,
  });
});

export const layer = Layer.effect(GroupChatReach, make).pipe(
  Layer.provide(ServerSecretStore.layer),
);

export const layerFixed = (input: { readonly exposed: boolean; readonly origin: string }) =>
  Layer.succeed(GroupChatReach, {
    exposed: Effect.succeed(input.exposed),
    origin: input.origin,
  });
