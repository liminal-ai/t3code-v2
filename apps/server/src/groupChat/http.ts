import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  GroupChatUnavailable,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import type { GroupChat } from "./layer.ts";

const notReady = new GroupChatUnavailable({ reason: "not_ready" });

export const makeLayer = (groupChat: GroupChat["Service"]) =>
  HttpApiBuilder.group(EnvironmentHttpApi, "groupChat", (handlers) =>
    Effect.succeed(
      handlers
        .handle(
          "snapshot",
          Effect.fn("environment.groupChat.snapshot")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const store = yield* groupChat.store;
            const groups = yield* store.groups.pipe(
              Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
            );
            return { groups };
          }),
        )
        .handle(
          "group",
          Effect.fn("environment.groupChat.group")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            yield* groupChat.store;
            return yield* notReady;
          }),
        )
        .handle(
          "dispatch",
          Effect.fn("environment.groupChat.dispatch")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
            yield* groupChat.store;
            return yield* notReady;
          }),
        ),
    ),
  );
