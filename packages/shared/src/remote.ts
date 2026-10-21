import * as Schema from "effect/Schema";

const PAIRING_TOKEN_PARAM = "token";
const HOSTED_PAIRING_HOST_PARAM = "host";
const HOSTED_PAIRING_LABEL_PARAM = "label";
const SUPPORTED_REMOTE_BACKEND_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

export const readHashParams = (url: URL): URLSearchParams =>
  new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

export class RemoteBackendUrlMissingError extends Schema.TaggedError<RemoteBackendUrlMissingError>()(
  "RemoteBackendUrlMissingError",
  {},
) {
  override get message(): string {
    return "Enter a backend URL.";
  }
}

export class RemotePairingUrlInvalidError extends Schema.TaggedError<RemotePairingUrlInvalidError>()(
  "RemotePairingUrlInvalidError",
  {
    cause: Schema.optional(Schema.Defect()),
    protocol: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return "Pairing URL is invalid.";
  }
}

export class RemoteBackendUrlInvalidError extends Schema.TaggedError<RemoteBackendUrlInvalidError>()(
  "RemoteBackendUrlInvalidError",
  {
    source: Schema.Literals(["direct-host", "hosted-pairing-host"]),
    cause: Schema.optional(Schema.Defect()),
    protocol: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return "Backend URL is invalid.";
  }
}

export class RemotePairingTokenMissingError extends Schema.TaggedError<RemotePairingTokenMissingError>()(
  "RemotePairingTokenMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return "Pairing URL is missing its token.";
  }
}

export class RemotePairingCodeMissingError extends Schema.TaggedError<RemotePairingCodeMissingError>()(
  "RemotePairingCodeMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return "Enter a pairing code.";
  }
}

export const RemotePairingTargetError = Schema.Union([
  RemoteBackendUrlMissingError,
  RemotePairingUrlInvalidError,
  RemoteBackendUrlInvalidError,
  RemotePairingTokenMissingError,
  RemotePairingCodeMissingError,
]);
export type RemotePairingTargetError = typeof RemotePairingTargetError.Type;

const hasSupportedRemoteBackendProtocol = (url: URL): boolean =>
  SUPPORTED_REMOTE_BACKEND_PROTOCOLS.has(url.protocol);

const normalizeRemoteBaseUrl = (
  rawValue: string,
  source: RemoteBackendUrlInvalidError["source"],
): URL => {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new RemoteBackendUrlMissingError();
  }

  const withoutLeadingSlashes = trimmed.replace(/^\/+/, "");
  const normalizedInput = /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(withoutLeadingSlashes)
    ? withoutLeadingSlashes
    : `https://${withoutLeadingSlashes}`;
  let url: URL;
  try {
    url = new URL(normalizedInput);
  } catch (cause) {
    throw new RemoteBackendUrlInvalidError({ source, cause });
  }
  if (!hasSupportedRemoteBackendProtocol(url)) {
    throw new RemoteBackendUrlInvalidError({
      source,
      protocol: url.protocol,
    });
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
};

const toHttpBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") {
    next.protocol = "http:";
  } else if (next.protocol === "wss:") {
    next.protocol = "https:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
};

const toWsBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "http:") {
    next.protocol = "ws:";
  } else if (next.protocol === "https:") {
    next.protocol = "wss:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
};

export interface ResolvedRemotePairingTarget {
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export const getPairingTokenFromUrl = (url: URL): string | null => {
  const hashToken = readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hashToken.length > 0) {
    return hashToken;
  }

  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return searchToken.length > 0 ? searchToken : null;
};

export const stripPairingTokenFromUrl = (url: URL): URL => {
  const next = new URL(url.toString());
  const hashParams = readHashParams(next);
  if (hashParams.has(PAIRING_TOKEN_PARAM)) {
    hashParams.delete(PAIRING_TOKEN_PARAM);
    next.hash = hashParams.toString();
  }
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  return next;
};

export const setPairingTokenOnUrl = (url: URL, credential: string): URL => {
  const next = new URL(url.toString());
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  next.hash = new URLSearchParams([[PAIRING_TOKEN_PARAM, credential]]).toString();
  return next;
};

export const readHostedPairingRequest = (url: URL): HostedPairingRequest | null => {
  const host = url.searchParams.get(HOSTED_PAIRING_HOST_PARAM)?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get(HOSTED_PAIRING_LABEL_PARAM)?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  };
};

export const resolveRemotePairingTarget = (input: {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): ResolvedRemotePairingTarget => {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl.length > 0) {
    let url: URL;
    try {
      url = new URL(pairingUrl);
    } catch (cause) {
      throw new RemotePairingUrlInvalidError({ cause });
    }
    if (!hasSupportedRemoteBackendProtocol(url)) {
      throw new RemotePairingUrlInvalidError({
        protocol: url.protocol,
      });
    }
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      const hostedBackendUrl = normalizeRemoteBaseUrl(
        hostedPairingRequest.host,
        "hosted-pairing-host",
      );
      return {
        credential: hostedPairingRequest.token,
        httpBaseUrl: toHttpBaseUrl(hostedBackendUrl),
        wsBaseUrl: toWsBaseUrl(hostedBackendUrl),
      };
    }

    const credential = getPairingTokenFromUrl(url) ?? "";
    if (!credential) {
      throw new RemotePairingTokenMissingError({ host: url.host });
    }
    return {
      credential,
      httpBaseUrl: toHttpBaseUrl(url),
      wsBaseUrl: toWsBaseUrl(url),
    };
  }

  const host = input.host?.trim() ?? "";
  const pairingCode = input.pairingCode?.trim() ?? "";
  if (!host) {
    throw new RemoteBackendUrlMissingError();
  }
  const normalizedHost = normalizeRemoteBaseUrl(host, "direct-host");
  if (!pairingCode) {
    throw new RemotePairingCodeMissingError({ host: normalizedHost.host });
  }

  return {
    credential: pairingCode,
    httpBaseUrl: toHttpBaseUrl(normalizedHost),
    wsBaseUrl: toWsBaseUrl(normalizedHost),
  };
};

const REDACTED_PAIRING_TOKEN = "<redacted>";
// `=`, or `=` percent-encoded once or more, as when a link is quoted inside another.
const PARAM_SEPARATOR = /=|%(?:25)*3D/gi;
// Not a tab or newline, which the URL parser drops from a link.
const PARAM_NAME_BOUNDARY = /[^\S\t\n\r]|[?#&"'<>]/;
const PARAM_VALUE_END = /[\s&#"<>]/;
// A name that decodes to `token`, after a `?`, `#` or `&` that may have been encoded with it.
const PAIRING_TOKEN_NAME = /(?:^|[?#&])token$/i;
const MAX_ENCODING_DEPTH = 4;

const percentDecodeBytes = (text: string): string =>
  text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

// URLSearchParams percent-decodes a name before it compares it, so `%74oken` is `token` too. The
// URL parser drops tabs and newlines, but text also uses them to start a line.
const namesPairingToken = (name: string): boolean => {
  let decoded = name;
  for (let depth = 0; depth <= MAX_ENCODING_DEPTH; depth += 1) {
    const lines = decoded.split(/[\t\n\r]/);
    if ([lines.join(""), lines[lines.length - 1] ?? ""].some((n) => PAIRING_TOKEN_NAME.test(n))) {
      return true;
    }
    const next = percentDecodeBytes(decoded);
    if (next === decoded) return false;
    decoded = next;
  }
  return false;
};

// Every `name=value` whose name decodes to `token`, however either one is encoded.
const redactPairingTokenParams = (text: string): string => {
  let redacted = "";
  let copiedTo = 0;
  let nameFrom = 0;
  for (const separator of text.matchAll(PARAM_SEPARATOR)) {
    const at = separator.index;
    if (at < copiedTo) continue;
    let nameStart = at;
    while (nameStart > nameFrom && !PARAM_NAME_BOUNDARY.test(text.charAt(nameStart - 1)))
      nameStart -= 1;
    const valueStart = at + separator[0].length;
    nameFrom = valueStart;
    if (!namesPairingToken(text.slice(nameStart, at))) continue;
    let valueEnd = valueStart;
    while (valueEnd < text.length && !PARAM_VALUE_END.test(text.charAt(valueEnd))) valueEnd += 1;
    if (valueEnd === valueStart) continue;
    redacted += text.slice(copiedTo, valueStart) + REDACTED_PAIRING_TOKEN;
    copiedTo = valueEnd;
    nameFrom = valueEnd;
  }
  return redacted + text.slice(copiedTo);
};

// The `token` values in a link's query and fragment, as written, before any decoding. The URL
// parser drops tabs and newlines, and URLSearchParams decodes each name before it compares it.
const pairingTokenValuesAsWritten = (link: string): ReadonlyArray<string> => {
  const hashAt = link.indexOf("#");
  const beforeHash = hashAt === -1 ? link : link.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  return [
    hashAt === -1 ? "" : link.slice(hashAt + 1),
    queryAt === -1 ? "" : beforeHash.slice(queryAt + 1),
  ]
    .flatMap((params) => params.split("&"))
    .flatMap((field) => {
      const equalsAt = field.indexOf("=");
      if (equalsAt === -1) return [];
      const name = new URLSearchParams(field.replace(/[\t\n\r]/g, "")).keys().next().value;
      return name === PAIRING_TOKEN_PARAM ? [field.slice(equalsAt + 1)] : [];
    });
};

// Each way a link's token can be quoted without its name: as the parser reads it, as written in
// the link and in the URL the parser makes of it, as a form encodes it, and each of those
// percent-encoded once or twice, or escaped in a JSON string.
const pairingTokenForms = (pairingUrl: string): ReadonlyArray<string> => {
  let url: URL;
  try {
    url = new URL(pairingUrl.trim());
  } catch {
    return [];
  }
  const token = getPairingTokenFromUrl(url);
  if (!token) return [];
  const written = [
    token,
    ...pairingTokenValuesAsWritten(pairingUrl),
    ...pairingTokenValuesAsWritten(url.href),
    new URLSearchParams([["", token]]).toString().slice(1),
  ];
  const forms = written.flatMap((form) => {
    const encodedOnce = encodeURIComponent(form);
    return [form, encodedOnce, encodeURIComponent(encodedOnce), JSON.stringify(form).slice(1, -1)];
  });
  // Longest first, so a form inside another does not break it up before it is replaced.
  return [...new Set(forms)].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
};

/**
 * Hides pairing tokens in text that can quote a pairing link, such as an error message: every
 * value of a parameter whose name decodes to `token`, raw or percent-encoded, and each form of
 * the tokens in `pairingUrls`, which an error can also quote without their names.
 */
export const redactPairingTokens = (
  text: string,
  ...pairingUrls: ReadonlyArray<string | undefined>
): string => {
  let redacted = text;
  for (const pairingUrl of pairingUrls) {
    if (pairingUrl === undefined) continue;
    for (const form of pairingTokenForms(pairingUrl)) {
      redacted = redacted.replaceAll(form, REDACTED_PAIRING_TOKEN);
    }
  }
  return redactPairingTokenParams(redacted);
};
