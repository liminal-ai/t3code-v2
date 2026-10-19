import { GroupChatUnavailable } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as Events from "./events.ts";
import * as Http from "./http.ts";
import * as Store from "./store.ts";

/**
 * Group chat as the server sees it. Whether it runs is decided once at boot, and a module that
 * cannot run answers every request with why instead of stopping the server.
 */
export class GroupChat extends Context.Service<
  GroupChat,
  { readonly store: Effect.Effect<Store.GroupChatStore, GroupChatUnavailable> }
>()("t3/groupChat/layer/GroupChat") {}

const off = (reason: GroupChatUnavailable["reason"]) =>
  GroupChat.of({ store: Effect.fail(new GroupChatUnavailable({ reason })) });

const make = Effect.gen(function* () {
  const disabled = yield* Config.String("T3CODE_GROUP_CHAT").pipe(
    Config.option,
    Effect.map(Option.exists((value) => value.trim().toLowerCase() === "off")),
    Effect.orElseSucceed(() => false),
  );
  if (disabled) {
    yield* Effect.log("group chat is turned off by T3CODE_GROUP_CHAT=off");
    return off("disabled");
  }

  const { stateDir } = yield* ServerConfig.ServerConfig;
  const file = Store.storeFile(yield* Path.Path, stateDir);
  const startedAt = yield* Clock.currentTimeMillis;
  yield* Effect.log("group chat store opening", { file });
  const opened = yield* Effect.exit(Store.open(file));
  if (Exit.isFailure(opened)) {
    if (Cause.hasInterrupts(opened.cause)) return yield* Effect.interrupt;
    yield* Effect.logError("group chat is unavailable: its store could not be opened", {
      file,
      cause: opened.cause,
    });
    return off("store_unavailable");
  }
  yield* Effect.log("group chat store opened", {
    file,
    durationMs: (yield* Clock.currentTimeMillis) - startedAt,
  });
  return GroupChat.of({ store: Effect.succeed(opened.value) });
});

export const layer = Layer.effect(GroupChat, make);

const withModule = <A, E, R>(build: (groupChat: GroupChat["Service"]) => Layer.Layer<A, E, R>) =>
  Layer.unwrap(Effect.map(Effect.service(GroupChat), build)).pipe(Layer.provide(layer));

export const layerHttpApi = withModule(Http.makeLayer);

export const routeLayer = withModule(Events.makeRouteLayer);

/** Opens the module at boot rather than on the first request. */
export const layerEngineStart = Layer.effectDiscard(Effect.service(GroupChat)).pipe(
  Layer.provide(layer),
);
