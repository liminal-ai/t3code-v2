import { AuthOrchestrationReadScope, GroupChatStreamEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { authenticateMediaRequest } from "../auth/http.ts";
import type { GroupChat } from "./layer.ts";

const GROUP_CHAT_EVENTS_PATH = "/api/group-chat/events";

/** Proxies close a response that stays silent, so an idle stream still sends a comment line. */
const KEEPALIVE_INTERVAL = "20 seconds";

const encoder = new TextEncoder();
const keepalive = encoder.encode(": keepalive\n\n");
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(GroupChatStreamEvent));

/** One SSE frame per changed row, with the sequence as the event id. Never a whole snapshot. */
const frame = (event: GroupChatStreamEvent) =>
  encoder.encode(`id: ${event.seq}\ndata: ${encodeEvent(event)}\n\n`);

export const makeRouteLayer = (groupChat: GroupChat["Service"]) =>
  HttpRouter.add(
    "GET",
    GROUP_CHAT_EVENTS_PATH,
    Effect.gen(function* () {
      yield* authenticateMediaRequest(AuthOrchestrationReadScope);
      const engine = yield* groupChat.engine;
      return HttpServerResponse.stream(
        Stream.merge(
          Stream.tick(KEEPALIVE_INTERVAL).pipe(Stream.map(() => keepalive)),
          engine.events.pipe(Stream.map(frame)),
        ),
        {
          contentType: "text/event-stream",
          // Compression would hold each frame back until its buffer fills.
          headers: { "cache-control": "no-store, no-transform" },
        },
      );
    }),
  );
