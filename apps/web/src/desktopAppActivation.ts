import {
  ConnectionBlockedError,
  ConnectionTransientError,
  connectionCatalogDisplayUrl,
  connectionRoutes,
  type ConnectionCatalogEntry,
  type ConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type {
  DesktopAppActivationFailure,
  DesktopAppActivationResponse,
  DesktopAppEnvironment,
  DesktopAppListEnvironmentsRequest,
  DesktopAppOpenWorkspaceRequest,
  DesktopAppPairEnvironmentRequest,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectId,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isDesktopLocalConnectionTarget } from "./connection/desktopLocal";

export interface DesktopAppActivationProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export interface DesktopAppActivationTarget {
  readonly environmentId: EnvironmentId;
  readonly platform: ExecutionEnvironmentPlatformOs;
}

export interface DesktopAppActivationDependencies {
  readonly getTarget: () => DesktopAppActivationTarget | null;
  readonly findProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => DesktopAppActivationProject | null;
  readonly createProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => Promise<ProjectId>;
  readonly waitForProject: (projectRef: ScopedProjectRef) => Promise<void>;
  readonly openThread: (
    projectRef: ScopedProjectRef,
  ) => Promise<{ readonly threadId: ThreadId } | null>;
}

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return { version: 1, requestId, ok: false, code, message };
}

function desktopPlatformToEnvironmentOs(
  platform: DesktopAppOpenWorkspaceRequest["platform"],
): ExecutionEnvironmentPlatformOs {
  return platform === "win32" ? "windows" : platform;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export async function handleDesktopAppActivationRequest(
  request: DesktopAppOpenWorkspaceRequest,
  dependencies: DesktopAppActivationDependencies,
): Promise<DesktopAppActivationResponse> {
  const target = dependencies.getTarget();
  if (target === null) {
    return failure(
      request.requestId,
      "environment-unavailable",
      "The desktop app's primary local environment is not connected.",
    );
  }

  const requestPlatform = desktopPlatformToEnvironmentOs(request.platform);
  if (requestPlatform !== target.platform) {
    return failure(
      request.requestId,
      "platform-mismatch",
      `The command path is for ${requestPlatform}, but the desktop app's primary environment uses ${target.platform}. Cross-platform path mapping is not supported.`,
    );
  }

  let projectId = dependencies.findProject(target.environmentId, request.workspaceRoot)?.id ?? null;
  if (projectId === null) {
    try {
      projectId = await dependencies.createProject(target.environmentId, request.workspaceRoot);
      await dependencies.waitForProject({ environmentId: target.environmentId, projectId });
    } catch (error) {
      return failure(
        request.requestId,
        "project-create-failed",
        errorMessage(error, "T3 Code could not add the project."),
      );
    }
  }

  try {
    const opened = await dependencies.openThread({
      environmentId: target.environmentId,
      projectId,
    });
    if (opened === null) {
      return failure(
        request.requestId,
        "thread-open-failed",
        "T3 Code could not open a new thread for the project.",
      );
    }
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId,
      threadId: opened.threadId,
    };
  } catch (error) {
    return failure(
      request.requestId,
      "thread-open-failed",
      errorMessage(error, "T3 Code could not open a new thread for the project."),
    );
  }
}

export interface DesktopAppEnvironmentRecord {
  readonly environment: DesktopAppEnvironment;
  /** Every address the environment has a bearer route at, so a link to an alternate route matches too. */
  readonly httpBaseUrls: ReadonlyArray<string>;
}

function environmentKind(target: ConnectionTarget): DesktopAppEnvironment["kind"] {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      return "local";
    case "BearerConnectionTarget":
      return isDesktopLocalConnectionTarget(target) ? "local" : "remote";
    case "SshConnectionTarget":
      return "ssh";
    case "RelayConnectionTarget":
      return "relay";
  }
}

export function desktopAppEnvironmentRecord(
  entry: ConnectionCatalogEntry,
  connection: DesktopAppEnvironment["connection"],
): DesktopAppEnvironmentRecord {
  const target = entry.target;
  const kind = environmentKind(target);
  const httpBaseUrls = connectionRoutes(entry).flatMap((route) => {
    if (route.target._tag === "PrimaryConnectionTarget") return [route.target.httpBaseUrl];
    return Option.isSome(route.profile) && route.profile.value._tag === "BearerConnectionProfile"
      ? [route.profile.value.httpBaseUrl]
      : [];
  });
  return {
    environment: {
      environmentId: target.environmentId,
      label: target.label,
      kind,
      httpBaseUrl: kind === "ssh" || kind === "relay" ? null : connectionCatalogDisplayUrl(entry),
      enabled: entry.enabled,
      connection,
    },
    httpBaseUrls,
  };
}

export interface DesktopAppEnvironmentDependencies {
  /** Reads the saved environments as they are now, including a registration that just finished. */
  readonly readEnvironments: () => Promise<ReadonlyArray<DesktopAppEnvironmentRecord>>;
  /** The same pairing as a link pasted into Add environment. Resolves to the saved environment's id. */
  readonly pairEnvironment: (input: {
    readonly pairingUrl: string;
    readonly label?: string;
  }) => Promise<EnvironmentId>;
}

const isConnectionBlockedError = Schema.is(ConnectionBlockedError);
const isConnectionTransientError = Schema.is(ConnectionTransientError);

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function pairingFailure(
  requestId: string,
  httpBaseUrl: string,
  error: unknown,
): DesktopAppActivationFailure {
  if (isConnectionBlockedError(error) && error.reason === "authentication") {
    return failure(
      requestId,
      "pairing-rejected",
      `${httpBaseUrl} rejected the pairing token. It may have expired or been used already, so create a new link and try again.`,
    );
  }
  if (isConnectionTransientError(error)) {
    return failure(
      requestId,
      "environment-unreachable",
      `T3 Code could not reach ${httpBaseUrl}: ${errorMessage(error, error.reason)}`,
    );
  }
  return failure(
    requestId,
    "pairing-failed",
    errorMessage(error, `T3 Code could not pair ${httpBaseUrl}.`),
  );
}

export async function handleDesktopAppPairRequest(
  request: DesktopAppPairEnvironmentRequest,
  dependencies: DesktopAppEnvironmentDependencies,
): Promise<DesktopAppActivationResponse> {
  let httpBaseUrl: string;
  try {
    httpBaseUrl = resolveRemotePairingTarget({ pairingUrl: request.pairingUrl }).httpBaseUrl;
  } catch (error) {
    return failure(
      request.requestId,
      "invalid-request",
      errorMessage(error, "The pairing URL is invalid."),
    );
  }

  const before = await dependencies.readEnvironments();
  const existing = before.find((record) =>
    record.httpBaseUrls.some((url) => sameOrigin(url, httpBaseUrl)),
  );
  // Checked before pairing, so the one-time token stays unspent.
  if (existing !== undefined && !request.force) {
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      type: "pair-environment",
      outcome: "already-paired",
      environment: existing.environment,
    };
  }

  let environmentId: EnvironmentId;
  try {
    environmentId = await dependencies.pairEnvironment({
      pairingUrl: request.pairingUrl,
      ...(request.label === undefined ? {} : { label: request.label }),
    });
  } catch (error) {
    return pairingFailure(request.requestId, httpBaseUrl, error);
  }

  const saved = (await dependencies.readEnvironments()).find(
    (record) => record.environment.environmentId === environmentId,
  );
  if (saved === undefined) {
    return failure(
      request.requestId,
      "pairing-failed",
      `T3 Code paired ${httpBaseUrl} but did not save environment ${environmentId}.`,
    );
  }
  const savedBefore = before.some((record) => record.environment.environmentId === environmentId);
  return {
    version: 1,
    requestId: request.requestId,
    ok: true,
    type: "pair-environment",
    outcome:
      savedBefore && existing?.environment.environmentId !== environmentId
        ? "route-added"
        : "paired",
    environment: saved.environment,
  };
}

export async function handleDesktopAppListEnvironmentsRequest(
  request: DesktopAppListEnvironmentsRequest,
  dependencies: Pick<DesktopAppEnvironmentDependencies, "readEnvironments">,
): Promise<DesktopAppActivationResponse> {
  try {
    const records = await dependencies.readEnvironments();
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      type: "list-environments",
      environments: records.map((record) => record.environment),
    };
  } catch (error) {
    return failure(
      request.requestId,
      "internal-error",
      errorMessage(error, "T3 Code could not read its environments."),
    );
  }
}
