import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION = 1 as const;

export const DesktopAppActivationPlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type DesktopAppActivationPlatform = typeof DesktopAppActivationPlatform.Type;

export const DesktopAppOpenWorkspaceRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("open-workspace"),
  workspaceRoot: TrimmedNonEmptyString,
  platform: DesktopAppActivationPlatform,
});
export type DesktopAppOpenWorkspaceRequest = typeof DesktopAppOpenWorkspaceRequest.Type;

/** Pairs the app with a server the same way pasting the link into Add environment does. */
export const DesktopAppPairEnvironmentRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("pair-environment"),
  pairingUrl: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  /** Pair again even when an environment already has this address. */
  force: Schema.Boolean,
});
export type DesktopAppPairEnvironmentRequest = typeof DesktopAppPairEnvironmentRequest.Type;

export const DesktopAppListEnvironmentsRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("list-environments"),
});
export type DesktopAppListEnvironmentsRequest = typeof DesktopAppListEnvironmentsRequest.Type;

export const DesktopAppActivationRequest = Schema.Union([
  DesktopAppOpenWorkspaceRequest,
  DesktopAppPairEnvironmentRequest,
  DesktopAppListEnvironmentsRequest,
]);
export type DesktopAppActivationRequest = typeof DesktopAppActivationRequest.Type;

export const DesktopAppActivationErrorCode = Schema.Literals([
  "invalid-request",
  "renderer-unavailable",
  "environment-unavailable",
  "platform-mismatch",
  "project-create-failed",
  "thread-open-failed",
  "pairing-rejected",
  "environment-unreachable",
  "pairing-failed",
  "request-timeout",
  "internal-error",
]);
export type DesktopAppActivationErrorCode = typeof DesktopAppActivationErrorCode.Type;

export const DesktopAppActivationSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  projectId: ProjectId,
  threadId: ThreadId,
});
export type DesktopAppActivationSuccess = typeof DesktopAppActivationSuccess.Type;

export const DesktopAppEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** local is the app's own server; remote is a paired server. */
  kind: Schema.Literals(["local", "remote", "ssh", "relay"]),
  /** The address of the environment's first route. Null for SSH and relay routes. */
  httpBaseUrl: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  connection: Schema.Literals([
    "available",
    "offline",
    "connecting",
    "reconnecting",
    "connected",
    "error",
    "unsupported",
  ]),
});
export type DesktopAppEnvironment = typeof DesktopAppEnvironment.Type;

/**
 * `route-added`: the server was already saved under another address, and this
 * one became another route to it. `already-paired`: an environment already has
 * this address, so the token was not spent.
 */
export const DesktopAppPairEnvironmentOutcome = Schema.Literals([
  "paired",
  "route-added",
  "already-paired",
]);
export type DesktopAppPairEnvironmentOutcome = typeof DesktopAppPairEnvironmentOutcome.Type;

export const DesktopAppPairEnvironmentSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  type: Schema.Literal("pair-environment"),
  outcome: DesktopAppPairEnvironmentOutcome,
  environment: DesktopAppEnvironment,
});
export type DesktopAppPairEnvironmentSuccess = typeof DesktopAppPairEnvironmentSuccess.Type;

export const DesktopAppListEnvironmentsSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  type: Schema.Literal("list-environments"),
  environments: Schema.Array(DesktopAppEnvironment),
});
export type DesktopAppListEnvironmentsSuccess = typeof DesktopAppListEnvironmentsSuccess.Type;

export const DesktopAppActivationFailure = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(false),
  code: DesktopAppActivationErrorCode,
  message: TrimmedNonEmptyString,
});
export type DesktopAppActivationFailure = typeof DesktopAppActivationFailure.Type;

export const DesktopAppActivationResponse = Schema.Union([
  DesktopAppActivationSuccess,
  DesktopAppPairEnvironmentSuccess,
  DesktopAppListEnvironmentsSuccess,
  DesktopAppActivationFailure,
]);
export type DesktopAppActivationResponse = typeof DesktopAppActivationResponse.Type;
