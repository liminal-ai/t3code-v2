// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import {
  GROUP_CHAT_HOOK_INBOUND_PATH,
  GROUP_CHAT_HOOK_REPLY_PATH,
  GROUP_CHAT_HOOK_SIGNATURE_HEADER,
  type GroupChatDeliveryId,
  type GroupChatMemberId,
} from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";

import type { ExternalSecrets } from "../store.ts";
import {
  idHeaders,
  type OutboundInput,
  post,
  renderTemplate,
  type SendFailure,
  templateVars,
} from "./http.ts";

export const WEBHOOK_POST_TIMEOUT: Duration.Input = "30 seconds";

export const sign = (secret: string, raw: Uint8Array | string): string =>
  `sha256=${NodeCrypto.createHmac("sha256", secret).update(raw).digest("hex")}`;

/** Compares two strings without leaking their length or where they differ through timing. */
export const constantTimeEquals = (a: string, b: string): boolean => {
  const digestA = NodeCrypto.createHash("sha256").update(a).digest();
  const digestB = NodeCrypto.createHash("sha256").update(b).digest();
  return NodeCrypto.timingSafeEqual(digestA, digestB);
};

export const verifySignature = (
  secret: string,
  raw: Uint8Array | string,
  header: string | undefined,
): boolean => header !== undefined && constantTimeEquals(sign(secret, raw), header.trim());

export const replyUrl = (origin: string, deliveryId: GroupChatDeliveryId, token: string) =>
  `${origin}${GROUP_CHAT_HOOK_REPLY_PATH.replace(":deliveryId", encodeURIComponent(deliveryId))}?token=${encodeURIComponent(token)}`;

export const inboundUrl = (origin: string, memberId: GroupChatMemberId, token: string) =>
  `${origin}${GROUP_CHAT_HOOK_INBOUND_PATH.replace(":memberId", encodeURIComponent(memberId))}?token=${encodeURIComponent(token)}`;

export const signedHeaders = (
  external: ExternalSecrets,
  input: OutboundInput,
  body: string,
): Record<string, string> => ({
  ...external.headers,
  ...idHeaders(input),
  ...(external.secret === ""
    ? {}
    : { [GROUP_CHAT_HOOK_SIGNATURE_HEADER]: sign(external.secret, body) }),
});

/** Posts the envelope and expects only an acknowledgement; the reply comes back through the callback URL. */
export const deliverWebhook = (
  external: ExternalSecrets,
  input: OutboundInput,
): Effect.Effect<void, SendFailure, HttpClient.HttpClient> => {
  const body = renderTemplate(external.bodyTemplate, templateVars(input));
  return post({
    url: external.url,
    headers: { ...signedHeaders(external, input, body), "x-reply-to": input.callbackUrl },
    body,
    timeout: WEBHOOK_POST_TIMEOUT,
  });
};
