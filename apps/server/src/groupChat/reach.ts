import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "../startupAccess.ts";

/** The link marker is a file read, so a flood of hook posts shares one answer. */
const LINK_STATE_TTL = "10 seconds";

/**
 * How far the server can be reached. External members' hook URLs are capability URLs, so once
 * anything beyond this machine can reach them, every post must also be signed.
 */
export class GroupChatReach extends Context.Service<
  GroupChatReach,
  {
    /** True on a non-loopback `--host`, or while the environment is linked to T3 Connect. */
    readonly exposed: Effect.Effect<boolean>;
    /** The origin the server knows itself by, used in hook URLs when a member sets none. */
    readonly origin: string;
  }
>()("t3/groupChat/reach/GroupChatReach") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const loopback = isLoopbackHost(config.host);
  const host =
    loopback || isWildcardHost(config.host) ? "127.0.0.1" : formatHostForUrl(config.host!);
  // The same marker T3 Connect's own link state reads: linked means the relay forwards to us.
  const linked = yield* secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.map(Option.isSome),
    // An unreadable marker counts as linked, so a fault never turns signatures off.
    Effect.orElseSucceed(() => true),
    Effect.cachedWithTTL(LINK_STATE_TTL),
  );
  return GroupChatReach.of({
    exposed: loopback ? linked : Effect.succeed(true),
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
