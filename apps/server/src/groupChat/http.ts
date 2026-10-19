import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import type { GroupChat } from "./layer.ts";

const internal = (cause: unknown) => failEnvironmentInternal("internal_error", cause);

export const makeLayer = (groupChat: GroupChat["Service"]) =>
  HttpApiBuilder.group(EnvironmentHttpApi, "groupChat", (handlers) =>
    Effect.succeed(
      handlers
        .handle(
          "snapshot",
          Effect.fn("environment.groupChat.snapshot")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const engine = yield* groupChat.engine;
            return yield* engine.snapshot.pipe(Effect.catch(internal));
          }),
        )
        .handle(
          "group",
          Effect.fn("environment.groupChat.group")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const engine = yield* groupChat.engine;
            return yield* engine.groupPage(args.params.groupId, args.query).pipe(
              Effect.catchTags({
                SqlError: internal,
                SchemaError: internal,
              }),
            );
          }),
        )
        .handle(
          "delivery",
          Effect.fn("environment.groupChat.delivery")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const engine = yield* groupChat.engine;
            return yield* engine.delivery(args.params.deliveryId).pipe(
              Effect.catchTags({
                SqlError: internal,
                SchemaError: internal,
              }),
            );
          }),
        )
        .handle(
          "dispatch",
          Effect.fn("environment.groupChat.dispatch")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
            const engine = yield* groupChat.engine;
            return yield* engine.dispatch(args.payload).pipe(
              Effect.catchTags({
                SqlError: internal,
                SchemaError: internal,
                GroupChatPortReadError: internal,
              }),
            );
          }),
        ),
    ),
  );
