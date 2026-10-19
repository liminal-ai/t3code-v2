import {
  EnvironmentHttpApi,
  GROUP_CHAT_HOOK_SIGNATURE_HEADER,
  type GroupChatHookQuery,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the capped reader pauses Node's request instead of destroying it.
import * as NodeHttp from "node:http";

import type { GroupChat } from "./layer.ts";
import { GroupChatReach } from "./reach.ts";
import type { ExternalSecrets } from "./store.ts";
import { extractText } from "./transports/http.ts";
import { constantTimeEquals, verifySignature } from "./transports/webhook.ts";

const HOOK_MAX_BODY_BYTES = 1_000_000;

/** Posts a hook URL accepts: a burst of `capacity`, refilled at `perSecond`. */
export const HOOK_RATE_LIMIT = { capacity: 60, perSecond: 2 } as const;
const BUCKET_SWEEP_SIZE = 1024;

interface Bucket {
  tokens: number;
  at: number;
}

const makeRateLimiter = (limit: { readonly capacity: number; readonly perSecond: number }) => {
  const buckets = new Map<string, Bucket>();
  const refill = (bucket: Bucket, nowMs: number) => {
    bucket.tokens = Math.min(
      limit.capacity,
      bucket.tokens + ((nowMs - bucket.at) / 1000) * limit.perSecond,
    );
    bucket.at = nowMs;
  };
  return (key: string, nowMs: number): boolean => {
    if (buckets.size > BUCKET_SWEEP_SIZE) {
      for (const [other, bucket] of buckets) {
        refill(bucket, nowMs);
        if (bucket.tokens >= limit.capacity) buckets.delete(other);
      }
    }
    const bucket = buckets.get(key) ?? { tokens: limit.capacity, at: nowMs };
    refill(bucket, nowMs);
    buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
};

export type SignatureCheck = "ok" | "invalid_signature" | "signature_required";

/** A member with a secret must sign every post. Without one, unsigned posts pass only while nothing beyond this machine can reach the server. */
const checkSignature = (input: {
  readonly external: ExternalSecrets;
  readonly body: Uint8Array;
  readonly header: string | undefined;
  readonly exposed: boolean;
}): SignatureCheck => {
  if (input.external.secret !== "") {
    return verifySignature(input.external.secret, input.body, input.header)
      ? "ok"
      : "invalid_signature";
  }
  return input.exposed ? "signature_required" : "ok";
};

const json = (status: number, body: Record<string, unknown>, headers?: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers });
const refused = (status: number, error: string) => json(status, { error });
// Node flushes the answer and drops the socket on `connection: close`, so the rest of the body is never read.
const tooLarge = json(413, { error: "body_too_large" }, { connection: "close" });
const tooSlow = json(408, { error: "body_read_timeout" }, { connection: "close" });

/** How long a caller may take to finish sending a hook body. Tests shorten it. */
export class HookBodyReadTimeout extends Context.Reference<Duration.Input>(
  "t3/groupChat/hooks/HookBodyReadTimeout",
  { defaultValue: () => "30 seconds" },
) {}

/**
 * Collects Node's request body up to the cap. The platform reader destroys the request when its
 * cap trips, which takes the socket with it and the 413 can never be written; pausing the
 * request instead leaves the socket to carry the answer.
 */
const collectCapped = (
  source: NodeHttp.IncomingMessage,
  max: number,
): Effect.Effect<Uint8Array | "too_large"> =>
  Effect.callback((resume) => {
    const chunks: Array<Buffer> = [];
    let total = 0;
    const cleanup = () => {
      source.off("data", onData);
      source.off("end", onEnd);
      source.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        cleanup();
        source.pause();
        resume(Effect.succeed("too_large" as const));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resume(Effect.succeed(new Uint8Array(Buffer.concat(chunks))));
    };
    const onError = () => {
      cleanup();
      resume(Effect.succeed("too_large" as const));
    };
    source.on("data", onData);
    source.once("end", onEnd);
    source.once("error", onError);
    return Effect.sync(cleanup);
  });

const readBody = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<Uint8Array | "too_large" | "timed_out"> =>
  Effect.gen(function* () {
    const declared = Number(request.headers["content-length"] ?? "0");
    if (!Number.isFinite(declared) || declared > HOOK_MAX_BODY_BYTES) return "too_large" as const;
    const collected =
      request.source instanceof NodeHttp.IncomingMessage
        ? collectCapped(request.source, HOOK_MAX_BODY_BYTES)
        : request.arrayBuffer.pipe(
            Effect.map((buffer) => new Uint8Array(buffer)),
            Effect.provideService(
              HttpIncomingMessage.MaxBodySize,
              ByteSize.bytes(HOOK_MAX_BODY_BYTES),
            ),
            Effect.orElseSucceed(() => "too_large" as const),
          );
    // A caller holding the body open would otherwise hold the handler for Node's own 300 s.
    const body = yield* collected.pipe(
      Effect.timeoutOrElse({
        duration: yield* HookBodyReadTimeout,
        orElse: () => Effect.succeed("timed_out" as const),
      }),
    );
    if (body !== "too_large" && body !== "timed_out" && body.byteLength > HOOK_MAX_BODY_BYTES) {
      return "too_large" as const;
    }
    return body;
  });

const decoder = new TextDecoder();

export const makeLayer = (groupChat: GroupChat["Service"]) =>
  HttpApiBuilder.group(
    EnvironmentHttpApi,
    "groupChatHooks",
    Effect.fnUntraced(function* (handlers) {
      const reach = yield* GroupChatReach;
      const underLimit = makeRateLimiter(HOOK_RATE_LIMIT);

      const accept = (input: {
        readonly key: string;
        readonly external: ExternalSecrets;
        readonly request: HttpServerRequest.HttpServerRequest;
      }) =>
        Effect.gen(function* () {
          if (!underLimit(input.key, yield* Clock.currentTimeMillis)) {
            return { _tag: "refused", response: refused(429, "rate_limited") } as const;
          }
          const body = yield* readBody(input.request);
          if (body === "too_large") return { _tag: "refused", response: tooLarge } as const;
          if (body === "timed_out") return { _tag: "refused", response: tooSlow } as const;
          const signature = checkSignature({
            external: input.external,
            body,
            header: input.request.headers[GROUP_CHAT_HOOK_SIGNATURE_HEADER],
            exposed: yield* reach.exposed,
          });
          if (signature !== "ok") {
            return { _tag: "refused", response: refused(401, signature) } as const;
          }
          const text = extractText(decoder.decode(body), input.external.replyPath);
          if (text === null) {
            return {
              _tag: "refused",
              response: refused(400, `no text at "${input.external.replyPath}"`),
            } as const;
          }
          return { _tag: "text", text } as const;
        });

      const module = Effect.all([groupChat.store, groupChat.engine]).pipe(
        Effect.map(([store, engine]) => ({ store, engine })),
        Effect.catchTags({
          GroupChatUnavailable: (error) => Effect.succeed(refused(503, error.reason)),
        }),
      );

      const isResponse = (value: unknown): value is HttpServerResponse.HttpServerResponse =>
        HttpServerResponse.isHttpServerResponse(value);

      const failed = (cause: unknown) =>
        Effect.logError("group chat hook failed", { cause }).pipe(
          Effect.as(refused(500, "internal_error")),
        );

      const reply = ({
        params,
        query,
        request,
      }: {
        readonly params: { readonly deliveryId: import("@t3tools/contracts").GroupChatDeliveryId };
        readonly query: GroupChatHookQuery;
        readonly request: HttpServerRequest.HttpServerRequest;
      }) =>
        Effect.gen(function* () {
          const ready = yield* module;
          if (isResponse(ready)) return ready;
          const delivery = yield* ready.store.delivery(params.deliveryId);
          const member = delivery === null ? null : yield* ready.store.member(delivery.memberId);
          const token = delivery?.external?.callbackToken ?? null;
          if (
            delivery === null ||
            member === null ||
            member.external === null ||
            token === null ||
            !constantTimeEquals(token, query.token)
          ) {
            return refused(404, "unknown_callback");
          }
          const accepted = yield* accept({
            key: `reply:${delivery.id}`,
            external: member.external,
            request,
          });
          if (accepted._tag === "refused") return accepted.response;
          const outcome = yield* ready.engine.landReply(delivery.id, accepted.text);
          return outcome === "not_found"
            ? refused(404, "unknown_callback")
            : json(200, { ok: true });
        }).pipe(Effect.catchCause(failed));

      const inbound = ({
        params,
        query,
        request,
      }: {
        readonly params: { readonly memberId: import("@t3tools/contracts").GroupChatMemberId };
        readonly query: GroupChatHookQuery;
        readonly request: HttpServerRequest.HttpServerRequest;
      }) =>
        Effect.gen(function* () {
          const ready = yield* module;
          if (isResponse(ready)) return ready;
          const member = yield* ready.store.member(params.memberId);
          if (
            member === null ||
            member.removedAt !== null ||
            member.external === null ||
            !constantTimeEquals(member.external.inboundToken, query.token)
          ) {
            return refused(404, "unknown_inbound_url");
          }
          const accepted = yield* accept({
            key: `inbound:${member.id}`,
            external: member.external,
            request,
          });
          if (accepted._tag === "refused") return accepted.response;
          const message = yield* ready.engine.postInbound(member.id, accepted.text);
          return message === null
            ? refused(404, "unknown_inbound_url")
            : json(200, { messageId: message.id });
        }).pipe(Effect.catchCause(failed));

      return handlers.handleRaw("reply", reply).handleRaw("inbound", inbound);
    }),
  );
