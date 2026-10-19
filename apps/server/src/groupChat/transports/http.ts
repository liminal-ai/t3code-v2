import type { GroupChatDeliveryId, GroupChatMember } from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientResponse,
  HttpClientRequest,
} from "effect/http";

import { shorten } from "../envelope.ts";

const UNTRUSTED_MAX_CHARS = 1_000_000;
/** Room for a capped reply in any UTF-8 encoding. */
const RESPONSE_MAX_BYTES = UNTRUSTED_MAX_CHARS * 4;

export const capUntrusted = (text: string): string =>
  text.length > UNTRUSTED_MAX_CHARS ? shorten(text, UNTRUSTED_MAX_CHARS) : text;

/** Fills `{{name}}` placeholders. A quoted placeholder becomes a JSON string; a bare one inside a string literal becomes escaped string content. */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  // One pass over the template, so a placeholder inside a value stays the value's own text.
  return template.replace(
    /"\{\{(\w+)\}\}"|\{\{(\w+)\}\}/g,
    (whole, quoted: string | undefined, bare: string | undefined) => {
      const name = quoted ?? bare!;
      if (!(name in vars)) return whole;
      const json = JSON.stringify(vars[name]);
      return quoted !== undefined ? json : json.slice(1, -1);
    },
  );
}

/** Reads a dotted path such as `reply` or `choices.0.message.content`. */
export function readPath(value: unknown, path: string): unknown {
  if (!path.trim()) return value;
  return path
    .split(".")
    .reduce<unknown>(
      (cur, key) => (cur == null ? undefined : (cur as Record<string, unknown>)[key]),
      value,
    );
}

/** The text an agent's JSON carries at `replyPath`, or the whole body when it is plain text. */
export function extractText(raw: string, replyPath: string): string | null {
  let json: unknown = raw;
  try {
    json = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof json === "string") return json;
  const found = readPath(json, replyPath) ?? readPath(json, "text");
  if (found == null) return null;
  return typeof found === "string" ? found : JSON.stringify(found);
}

export type SendFailure =
  /** The agent looked at the request and refused it, or answered without a reply. Only Retry sends again. */
  | { readonly _tag: "permanent"; readonly reason: string }
  /** The outcome is unknown or the agent asked for a retry. The resend carries the same Idempotency-Key. */
  | { readonly _tag: "transient"; readonly reason: string };

const excerpt = (text: string) => text.slice(0, 200);

/**
 * 4xx means the agent refused the request, except 408 and 429, which ask for a retry. 5xx, a
 * network error and a timeout leave the outcome unknown.
 */
const tooLarge = (status: number): SendFailure => ({
  _tag: "permanent",
  reason: `HTTP ${status}: the response body is larger than ${RESPONSE_MAX_BYTES} bytes`,
});

/** Reads the body as it streams and stops at the cap, so a body with no declared length cannot grow without bound. */
const readCapped = (
  response: HttpClientResponse.HttpClientResponse,
  redact: (text: string) => string,
): Effect.Effect<string, SendFailure> =>
  response.stream.pipe(
    Stream.mapError((error): SendFailure => ({ _tag: "transient", reason: redact(error.message) })),
    Stream.runFoldEffect(
      (): { chunks: Array<Uint8Array>; total: number } => ({ chunks: [], total: 0 }),
      (acc, chunk): Effect.Effect<{ chunks: Array<Uint8Array>; total: number }, SendFailure> =>
        acc.total + chunk.byteLength > RESPONSE_MAX_BYTES
          ? Effect.fail(tooLarge(response.status))
          : Effect.succeed({ chunks: [...acc.chunks, chunk], total: acc.total + chunk.byteLength }),
    ),
    Effect.map(({ chunks }) => new TextDecoder().decode(Buffer.concat(chunks))),
  );

/** The timeout covers the whole exchange, body included, since headers can arrive long before the body ends. */
/** Replaces every secret the request carried, so an agent that echoes the request cannot put a token into a stored error. */
const redactSecrets = (text: string, secrets: ReadonlyArray<string>): string =>
  secrets.reduce(
    (redacted, secret) => (secret === "" ? redacted : redacted.split(secret).join("<redacted>")),
    text,
  );

/** The token in a hook URL's query, or the URL's whole query when the operator put a key there. */
export const queryValues = (url: string): ReadonlyArray<string> => {
  try {
    const parsed = new URL(url);
    return [...parsed.searchParams.values(), parsed.search.slice(1)];
  } catch {
    return [];
  }
};

export const post = (input: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeout: Duration.Input;
  /** Everything a failure message must not repeat: header values, tokens, the signing secret. */
  readonly secrets: ReadonlyArray<string>;
}): Effect.Effect<string, SendFailure, HttpClient.HttpClient> =>
  // The client tracer records the request URL and headers as span attributes, and this request
  // carries the callback URL's token, the member's own headers and whatever the operator put in
  // the agent's URL, so nothing about the exchange reaches a span.
  Effect.withTracerEnabled(false)(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const redact = (text: string) => redactSecrets(text, input.secrets);
      const { status, text } = yield* Effect.gen(function* () {
        // A redirect would resend the envelope, the member's headers and the callback URL to
        // whatever the endpoint named, so the request never follows one.
        const response = yield* client
          .execute(
            HttpClientRequest.post(input.url).pipe(
              HttpClientRequest.setHeaders(input.headers),
              HttpClientRequest.bodyText(input.body, "application/json"),
            ),
          )
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Effect.mapError((error): SendFailure => ({
              _tag: "transient",
              reason: redact(error.message),
            })),
          );
        if (response.status >= 300 && response.status < 400) {
          return yield* Effect.fail<SendFailure>({
            _tag: "permanent",
            reason: `HTTP ${response.status}: the endpoint redirects, and a redirect is never followed; point the member at the final URL`,
          });
        }
        const length = Number(response.headers["content-length"] ?? "0");
        if (Number.isFinite(length) && length > RESPONSE_MAX_BYTES) {
          return yield* Effect.fail(tooLarge(response.status));
        }
        return { status: response.status, text: yield* readCapped(response, redact) };
      }).pipe(
        Effect.timeoutOrElse({
          duration: input.timeout,
          orElse: () =>
            Effect.fail<SendFailure>({
              _tag: "transient",
              reason: `no answer within ${String(input.timeout)}`,
            }),
        }),
      );
      const message = `HTTP ${status}: ${redact(excerpt(text))}`;
      if (status === 408 || status === 429) {
        return yield* Effect.fail<SendFailure>({ _tag: "transient", reason: message });
      }
      if (status >= 400 && status < 500) {
        return yield* Effect.fail<SendFailure>({ _tag: "permanent", reason: message });
      }
      if (status < 200 || status >= 300) {
        return yield* Effect.fail<SendFailure>({ _tag: "transient", reason: message });
      }
      return text;
    }),
  );

export interface OutboundInput {
  readonly member: GroupChatMember;
  readonly groupTitle: string;
  readonly deliveryId: GroupChatDeliveryId;
  readonly envelope: string;
  /** Requests sent for this delivery so far, this one included. */
  readonly attempt: number;
  readonly callbackUrl: string;
  readonly inboundUrl: string;
  readonly timeout: Duration.Input;
}

export const templateVars = (input: OutboundInput): Record<string, string> => ({
  envelope: input.envelope,
  groupId: input.member.groupId,
  groupTitle: input.groupTitle,
  handle: input.member.handle,
  memberId: input.member.id,
  deliveryId: input.deliveryId,
  idempotencyKey: input.deliveryId,
  callbackUrl: input.callbackUrl,
  inboundUrl: input.inboundUrl,
});

/**
 * One key per delivery for life. A resend after a restart, a lost response and the operator's
 * Retry all carry it, so the agent can drop a duplicate or choose to redo it.
 */
export const idHeaders = (input: OutboundInput): Record<string, string> => ({
  "idempotency-key": input.deliveryId,
  "x-gchat-attempt": String(input.attempt),
  "x-gchat-delivery": input.deliveryId,
});
