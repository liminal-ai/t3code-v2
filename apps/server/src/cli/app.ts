// @effect-diagnostics globalTimers:off -- The Node socket client owns its response deadline and clears it on every completion path.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationErrorCode,
  DesktopAppActivationResponse,
  type DesktopAppActivationFailure,
  type DesktopAppActivationPlatform,
  type DesktopAppActivationRequest,
  type DesktopAppActivationSuccess,
  type DesktopAppEnvironment,
  type DesktopAppListEnvironmentsSuccess,
  type DesktopAppPairEnvironmentSuccess,
  desktopAppActivationDeadlines,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import { redactPairingTokens, resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

// Past the desktop app's own deadlines, so the CLI hears the app's reason when one runs out.
const CLI_RESPONSE_MARGIN_MS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const isDesktopAppActivationResponse = Schema.is(DesktopAppActivationResponse);

export class DesktopAppSshUnsupportedError extends Schema.TaggedError<DesktopAppSshUnsupportedError>()(
  "DesktopAppSshUnsupportedError",
  {},
) {
  override get message(): string {
    return "`t3 app` only controls a desktop app on the same machine. It cannot run over SSH. To set up the machine you are logged into from a script, pass --allow-ssh.";
  }
}

export class DesktopAppPlatformUnsupportedError extends Schema.TaggedError<DesktopAppPlatformUnsupportedError>()(
  "DesktopAppPlatformUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `\`t3 app\` is not supported on ${this.platform}.`;
  }
}

export class DesktopAppUnreachableError extends Schema.TaggedError<DesktopAppUnreachableError>()(
  "DesktopAppUnreachableError",
  {
    candidateAddresses: Schema.Array(Schema.String),
    requestId: Schema.String,
    workspaceRoot: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not reach the T3 Code desktop app. Start or update the desktop app on this machine, then run `t3 app` again. A running T3 Code server is not enough.";
  }
}

export class DesktopAppRequestFailedError extends Schema.TaggedError<DesktopAppRequestFailedError>()(
  "DesktopAppRequestFailedError",
  {
    code: DesktopAppActivationErrorCode,
    requestId: Schema.String,
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `T3 Code could not open ${this.workspaceRoot} (${this.code}).`;
  }
}

// Keeps a reason rather than the cause, since a URL parse error carries the link as its input.
export class DesktopAppPairingUrlInvalidError extends Schema.TaggedError<DesktopAppPairingUrlInvalidError>()(
  "DesktopAppPairingUrlInvalidError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The pairing URL is not usable. ${this.reason} Pass the link from \`t3 pair\` or Settings → Connections.`;
  }
}

export class DesktopAppWorkspaceIsUrlError extends Schema.TaggedError<DesktopAppWorkspaceIsUrlError>()(
  "DesktopAppWorkspaceIsUrlError",
  {},
) {
  override get message(): string {
    return "`t3 app` opens a project directory, and that path is a URL. To pair with a server, run `t3 app pair <pairing-url>`.";
  }
}

export class DesktopAppPairFailedError extends Schema.TaggedError<DesktopAppPairFailedError>()(
  "DesktopAppPairFailedError",
  {
    code: DesktopAppActivationErrorCode,
    httpBaseUrl: Schema.String,
    requestId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Could not pair ${this.httpBaseUrl} (${this.code}): ${this.detail}${outdatedAppHint(this.code)}`;
  }
}

export class DesktopAppEnvironmentsFailedError extends Schema.TaggedError<DesktopAppEnvironmentsFailedError>()(
  "DesktopAppEnvironmentsFailedError",
  {
    code: DesktopAppActivationErrorCode,
    requestId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Could not list the desktop app's environments (${this.code}): ${this.detail}${outdatedAppHint(this.code)}`;
  }
}

// An app older than the request kind rejects it as invalid before the renderer sees it.
function outdatedAppHint(code: DesktopAppActivationErrorCode): string {
  return code === "invalid-request" ? " If the desktop app is older than this CLI, update it." : "";
}

function isDesktopPlatform(platform: NodeJS.Platform): platform is DesktopAppActivationPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

interface DesktopAppSuccessByType {
  readonly "open-workspace": DesktopAppActivationSuccess;
  readonly "pair-environment": DesktopAppPairEnvironmentSuccess;
  readonly "list-environments": DesktopAppListEnvironmentsSuccess;
}

type DesktopAppResponseFor<Request extends DesktopAppActivationRequest> =
  | DesktopAppSuccessByType[Request["type"]]
  | DesktopAppActivationFailure;

function responseType(response: DesktopAppActivationResponse & { readonly ok: true }) {
  return "type" in response ? response.type : "open-workspace";
}

function cliResponseTimeoutMs(request: DesktopAppActivationRequest): number {
  const { waitMs, runMs } = desktopAppActivationDeadlines(request.type);
  return waitMs + runMs + CLI_RESPONSE_MARGIN_MS;
}

function sendDesktopAppActivationRequest<Request extends DesktopAppActivationRequest>(input: {
  readonly address: string;
  readonly fallbackAddress?: string;
  readonly request: Request;
}): Promise<DesktopAppResponseFor<Request>> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(input.address);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let connected = false;

    const finish = (
      result:
        | { readonly type: "success"; readonly response: DesktopAppResponseFor<Request> }
        | { readonly type: "failure"; readonly error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (result.type === "success") resolve(result.response);
      else reject(result.error);
    };

    const timeout = setTimeout(() => {
      finish({
        type: "failure",
        error: new Error("The desktop app did not respond in time."),
      });
    }, cliResponseTimeoutMs(input.request));

    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(input.request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish({ type: "failure", error: new Error("The desktop app response is too large.") });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish({
          type: "failure",
          error: new Error("The desktop app response is not valid JSON."),
        });
        return;
      }
      if (!isDesktopAppActivationResponse(parsed)) {
        finish({ type: "failure", error: new Error("The desktop app response is invalid.") });
        return;
      }
      if (parsed.ok && responseType(parsed) !== input.request.type) {
        finish({ type: "failure", error: new Error("The desktop app response is invalid.") });
        return;
      }
      if (parsed.requestId !== input.request.requestId) {
        finish({
          type: "failure",
          error: new Error("The desktop app response did not match this request."),
        });
        return;
      }
      // The type check above makes this the success shape for this request.
      finish({ type: "success", response: parsed as DesktopAppResponseFor<Request> });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (
        !settled &&
        !connected &&
        input.fallbackAddress !== undefined &&
        (error.code === "ENOENT" || error.code === "ECONNREFUSED")
      ) {
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        resolve(
          sendDesktopAppActivationRequest({
            address: input.fallbackAddress,
            request: input.request,
          }),
        );
        return;
      }
      finish({ type: "failure", error });
    });
    socket.once("end", () => {
      finish({ type: "failure", error: new Error("The desktop app closed the connection.") });
    });
  });
}

const appEnvironment = Config.all({
  t3Home: Config.String("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  sshConnection: Config.String("SSH_CONNECTION").pipe(Config.option),
  sshTty: Config.String("SSH_TTY").pipe(Config.option),
  allowSsh: Config.String("T3_APP_ALLOW_SSH").pipe(
    Config.option,
    Config.map((value) => Option.isSome(value) && value.value.trim() === "1"),
  ),
});

const allowSshFlag = Flag.Boolean("allow-ssh").pipe(
  Flag.withDescription(
    "Run under SSH anyway (or set T3_APP_ALLOW_SSH=1). The control socket is local, so this only reaches a desktop app on the machine you are logged into. Use it for scripted setup of that machine.",
  ),
  Flag.withDefault(false),
);

interface DesktopAppConnectionFlags {
  readonly baseDir: Option.Option<string>;
  readonly allowSsh: boolean;
}

/** Checks that this process may control a desktop app and finds its control socket. */
const resolveDesktopAppConnection = Effect.fn("cli.app.resolveConnection")(function* (
  flags: DesktopAppConnectionFlags,
) {
  const environment = yield* appEnvironment;
  const hostPlatform = yield* HostProcess.Platform;
  if (
    !flags.allowSsh &&
    !environment.allowSsh &&
    (Option.isSome(environment.sshConnection) || Option.isSome(environment.sshTty))
  ) {
    return yield* new DesktopAppSshUnsupportedError({});
  }
  if (!isDesktopPlatform(hostPlatform)) {
    return yield* new DesktopAppPlatformUnsupportedError({ platform: hostPlatform });
  }

  const path = yield* Path.Path;
  const configuredBaseDir = Option.getOrUndefined(flags.baseDir) ?? environment.t3Home;
  const baseDir = yield* resolveBaseDir(configuredBaseDir);
  const allowDevFallback = Option.isNone(flags.baseDir) && !environment.t3Home?.trim();
  const userId = yield* HostProcess.UserId;
  const resolveAddress = (stateSubdirectory: "userdata" | "dev") =>
    resolveDesktopAppControlAddress({
      stateDir: path.join(baseDir, stateSubdirectory),
      platform: hostPlatform,
      tempDir: NodeOS.tmpdir(),
      userId,
      joinPath: path.join,
    }).address;
  const address = resolveAddress("userdata");
  const fallbackAddress = allowDevFallback ? resolveAddress("dev") : undefined;
  const crypto = yield* Crypto.Crypto;
  const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);

  const send = <Request extends DesktopAppActivationRequest>(
    request: Request,
    options: { readonly workspaceRoot?: string } = {},
  ) =>
    Effect.tryPromise({
      try: () =>
        sendDesktopAppActivationRequest({
          address,
          ...(fallbackAddress === undefined ? {} : { fallbackAddress }),
          request,
        }),
      catch: (cause) =>
        new DesktopAppUnreachableError({
          candidateAddresses:
            fallbackAddress === undefined ? [address] : [address, fallbackAddress],
          requestId: request.requestId,
          ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
          cause,
        }),
    });

  return { hostPlatform, requestId, send };
});

const runAppCommand = Effect.fn("cli.app")(function* (
  flags: DesktopAppConnectionFlags & {
    readonly workspaceRoot: Option.Option<string>;
  },
) {
  // A pairing link here would be saved as a project path, with its token.
  if (Option.exists(flags.workspaceRoot, (root) => /^[a-z][a-z0-9+.-]*:\/\//i.test(root.trim()))) {
    return yield* new DesktopAppWorkspaceIsUrlError({});
  }
  const { hostPlatform, requestId, send } = yield* resolveDesktopAppConnection(flags);
  const path = yield* Path.Path;
  const rawWorkspaceRoot =
    Option.getOrUndefined(flags.workspaceRoot) ?? (yield* HostProcess.WorkingDirectory);
  const workspaceRoot = path.resolve(yield* expandHomePath(rawWorkspaceRoot));
  const request: DesktopAppActivationRequest = {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    type: "open-workspace",
    workspaceRoot,
    platform: hostPlatform,
  };

  const response = yield* send(request, { workspaceRoot });
  if (!response.ok) {
    return yield* new DesktopAppRequestFailedError({
      code: response.code,
      requestId: response.requestId,
      workspaceRoot,
      cause: response,
    });
  }

  yield* Console.log(`Opened ${workspaceRoot} in T3 Code.`);
});

function describeEnvironment(environment: DesktopAppEnvironment): string {
  return `${environment.label} (${environment.environmentId})`;
}

const runAppPairCommand = Effect.fn("cli.app.pair")(function* (
  flags: DesktopAppConnectionFlags & {
    readonly pairingUrl: string;
    readonly label: Option.Option<string>;
    readonly force: boolean;
  },
) {
  // Checked here too, so a mistyped link never reaches the app.
  const target = yield* Effect.try({
    try: () => resolveRemotePairingTarget({ pairingUrl: flags.pairingUrl }),
    catch: (cause) =>
      new DesktopAppPairingUrlInvalidError({
        reason: redactPairingTokens(
          cause instanceof Error ? cause.message : "It could not be read.",
          flags.pairingUrl,
        ),
      }),
  });
  const label = Option.getOrUndefined(flags.label)?.trim();
  const { requestId, send } = yield* resolveDesktopAppConnection(flags);
  const response = yield* send({
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    type: "pair-environment",
    pairingUrl: flags.pairingUrl.trim(),
    ...(label ? { label } : {}),
    force: flags.force,
  });
  if (!response.ok) {
    return yield* new DesktopAppPairFailedError({
      code: response.code,
      httpBaseUrl: target.httpBaseUrl,
      requestId: response.requestId,
      // The app redacts its own messages. This catches any it misses.
      detail: redactPairingTokens(response.message, flags.pairingUrl),
    });
  }

  const environment = response.environment;
  switch (response.outcome) {
    case "paired":
      yield* Console.log(
        `Paired ${describeEnvironment(environment)} at ${environment.httpBaseUrl ?? target.httpBaseUrl}.`,
      );
      return;
    case "route-added":
      yield* Console.log(
        `Added ${target.httpBaseUrl} as another route to ${describeEnvironment(environment)}.`,
      );
      return;
    case "already-paired":
      yield* Console.log(
        `Already paired: ${describeEnvironment(environment)} at ${environment.httpBaseUrl ?? target.httpBaseUrl}. Pass --force to pair again.`,
      );
      return;
  }
});

function formatDesktopAppEnvironments(
  environments: ReadonlyArray<DesktopAppEnvironment>,
  options: { readonly json: boolean },
): string {
  if (options.json) return JSON.stringify(environments, null, 2);
  if (environments.length === 0) return "The desktop app has no environments.";
  const rows = [
    ["ENVIRONMENT ID", "LABEL", "KIND", "CONNECTION", "URL"],
    ...environments.map((environment) => [
      environment.environmentId,
      environment.label,
      environment.kind,
      environment.enabled ? environment.connection : "disabled",
      environment.httpBaseUrl ?? "-",
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
        .join("  "),
    )
    .join("\n");
}

const runAppEnvironmentsCommand = Effect.fn("cli.app.environments")(function* (
  flags: DesktopAppConnectionFlags & { readonly json: boolean },
) {
  const { requestId, send } = yield* resolveDesktopAppConnection(flags);
  const response = yield* send({
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    type: "list-environments",
  });
  if (!response.ok) {
    return yield* new DesktopAppEnvironmentsFailedError({
      code: response.code,
      requestId: response.requestId,
      detail: response.message,
    });
  }
  yield* Console.log(formatDesktopAppEnvironments(response.environments, { json: flags.json }));
});

const appPairCommand = Command.make("pair", {
  baseDir: baseDirFlag,
  allowSsh: allowSshFlag,
  pairingUrl: Argument.String("pairing-url").pipe(
    Argument.withDescription("A pairing link from `t3 pair` or Settings → Connections."),
  ),
  label: Flag.String("label").pipe(
    Flag.withDescription("Name to save the environment under. Default: the server's own label."),
    Flag.optional,
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDescription(
      "Pair again even when the app already has an environment at this address.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Pair the running T3 Code desktop app with a server, the same way pasting the link into Add environment does.",
  ),
  Command.withHandler(runAppPairCommand),
);

const appEnvironmentsCommand = Command.make("environments", {
  baseDir: baseDirFlag,
  allowSsh: allowSshFlag,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit JSON instead of a table."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("List the environments the running T3 Code desktop app has saved."),
  Command.withHandler(runAppEnvironmentsCommand),
);

export const appCommand = Command.make("app", {
  baseDir: baseDirFlag,
  allowSsh: allowSshFlag,
  workspaceRoot: Argument.String("path").pipe(
    Argument.withDescription("Project directory. Default: current directory."),
    Argument.optional,
  ),
}).pipe(
  Command.withDescription("Open a project in the running T3 Code desktop app."),
  Command.withHandler(runAppCommand),
  Command.withSubcommands([appPairCommand, appEnvironmentsCommand]),
);
