import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";

import type { ExternalSecrets } from "../store.ts";
import {
  extractText,
  type OutboundInput,
  post,
  renderTemplate,
  type SendFailure,
  templateVars,
} from "./http.ts";
import { signedHeaders } from "./webhook.ts";

/** A REST agent answers in the same call, so it may take a while. */
export const REST_TIMEOUT: Duration.Input = "120 seconds";

/** Posts the envelope and reads the reply out of the response at `replyPath`. */
export const deliverRest = (
  external: ExternalSecrets,
  input: OutboundInput,
): Effect.Effect<string, SendFailure, HttpClient.HttpClient> => {
  const body = renderTemplate(external.bodyTemplate, templateVars(input));
  return post({
    url: external.url,
    headers: signedHeaders(external, input, body),
    body,
    timeout: REST_TIMEOUT,
  }).pipe(
    Effect.flatMap((raw) => {
      const text = extractText(raw, external.replyPath);
      return text === null
        ? Effect.fail<SendFailure>({
            _tag: "permanent",
            reason: `reply path "${external.replyPath}" not found in the response`,
          })
        : Effect.succeed(text);
    }),
  );
};
