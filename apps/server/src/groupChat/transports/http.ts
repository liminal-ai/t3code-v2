import type { GroupChatDeliveryId, GroupChatMember } from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { shorten } from "../envelope.ts";

/** External agents are outside the operator's control, so what they say is stored whole up to this. */
export const UNTRUSTED_MAX_CHARS = 1_000_000;

export const capUntrusted = (text: string): string =>
  text.length > UNTRUSTED_MAX_CHARS ? shorten(text, UNTRUSTED_MAX_CHARS) : text;

/** Fills `{{name}}` placeholders. A quoted placeholder becomes a JSON string; a bare one inside a string literal becomes escaped string content. */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template
    .replace(/"\{\{(\w+)\}\}"/g, (whole, name: string) =>
      name in vars ? JSON.stringify(vars[name]) : whole,
    )
    .replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
      name in vars ? JSON.stringify(vars[name]).slice(1, -1) : whole,
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
export const post = (input: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeout: Duration.Input;
}): Effect.Effect<string, SendFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(input.url).pipe(
          HttpClientRequest.setHeaders(input.headers),
          HttpClientRequest.bodyText(input.body, "application/json"),
        ),
      )
      .pipe(
        Effect.timeout(input.timeout),
        Effect.mapError((error): SendFailure => ({
          _tag: "transient",
          reason:
            error._tag === "TimeoutError"
              ? `no answer within ${String(input.timeout)}`
              : error.message,
        })),
      );
    const length = Number(response.headers["content-length"] ?? "0");
    if (Number.isFinite(length) && length > UNTRUSTED_MAX_CHARS * 4) {
      return yield* Effect.fail<SendFailure>({
        _tag: "permanent",
        reason: `HTTP ${response.status}: the response body is larger than ${UNTRUSTED_MAX_CHARS * 4} bytes`,
      });
    }
    const text = yield* response.text.pipe(
      Effect.mapError((error): SendFailure => ({ _tag: "transient", reason: error.message })),
    );
    const status = response.status;
    const message = `HTTP ${status}: ${excerpt(text)}`;
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
  });

export interface OutboundInput {
  readonly member: GroupChatMember;
  readonly groupTitle: string;
  readonly deliveryId: GroupChatDeliveryId;
  readonly envelope: string;
  /** Requests sent for this delivery so far, this one included. */
  readonly attempt: number;
  readonly callbackUrl: string;
  readonly inboundUrl: string;
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
