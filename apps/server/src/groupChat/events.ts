import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { authenticateMediaRequest } from "../auth/http.ts";
import type { GroupChat } from "./layer.ts";

const GROUP_CHAT_EVENTS_PATH = "/api/group-chat/events";

/** Proxies close a response that stays silent, so an idle stream still sends a comment line. */
const KEEPALIVE_INTERVAL = "20 seconds";

const keepalive = new TextEncoder().encode(": keepalive\n\n");

export const makeRouteLayer = (groupChat: GroupChat["Service"]) =>
  HttpRouter.add(
    "GET",
    GROUP_CHAT_EVENTS_PATH,
    Effect.gen(function* () {
      yield* authenticateMediaRequest(AuthOrchestrationReadScope);
      yield* groupChat.store;
      return HttpServerResponse.stream(
        Stream.tick(KEEPALIVE_INTERVAL).pipe(Stream.map(() => keepalive)),
        {
          contentType: "text/event-stream",
          // Compression would hold each comment line back until its buffer fills.
          headers: { "cache-control": "no-store, no-transform" },
        },
      );
    }),
  );
