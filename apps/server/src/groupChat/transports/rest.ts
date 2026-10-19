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
import { requestSecrets, signedHeaders } from "./webhook.ts";

/** Posts the envelope and reads the reply out of the response at `replyPath`. */
export const deliverRest = (
  external: ExternalSecrets,
  input: OutboundInput,
): Effect.Effect<string, SendFailure, HttpClient.HttpClient> => {
  const body = renderTemplate(external.bodyTemplate, templateVars(input));
  const headers = signedHeaders(external, input, body);
  return post({
    url: external.url,
    headers,
    body,
    timeout: input.timeout,
    secrets: requestSecrets(external, input, headers),
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
