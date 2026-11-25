/**
 * `t3 thread export-manifest`, `limbase-bind` and `limbase-unbind` (LH-336). Each signs in to the
 * running server as its owner, for one request, and posts to the route in `LimbaseMigrationRoute`.
 * The server does the reading and the writing; nothing here opens its database.
 */
import { AuthEnvironmentMaintainScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "../cli/config.ts";
import * as ServerConfig from "../config.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { BindingResult, LIMBASE_MIGRATION_ROUTE_PREFIX, LimbaseIds } from "./LimbaseMigration.ts";

export class LimbaseMigrationCliError extends Schema.TaggedError<LimbaseMigrationCliError>()(
  "LimbaseMigrationCliError",
  { detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

const isCliError = Schema.is(LimbaseMigrationCliError);

const fail = (detail: string) => Effect.fail(new LimbaseMigrationCliError({ detail }));

/** Refusals print as one line on stderr, not as a logged stack trace. */
const reportErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) => (isCliError(error) ? Console.error(error.message) : Effect.void)),
  );

const ErrorBody = Schema.Struct({ error: Schema.String });
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));
const decodeBindingResult = Schema.decodeUnknownEffect(Schema.fromJsonString(BindingResult));

/**
 * Posts `body` to the route as the server's owner: a session that holds `environment:maintain`,
 * issued for this request and revoked after it.
 */
const sendAsOwner = Effect.fn("LimbaseMigrationCli.send")(function* (
  flags: { readonly baseDir: Option.Option<string> },
  name: "manifest" | "bind" | "unbind" | "ids",
  body: Readonly<Record<string, unknown>>,
  quietLogs = false,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs });
  const minimumLogLevel = quietLogs ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* fail(
        `No running T3 Code server uses ${config.baseDir}. Start T3 Code, then retry.`,
      );
    }
    const origin = runtimeState.value.origin;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      environmentAuth.issueSession({
        scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
        label: "t3 thread limbase cli",
      }),
      (session) =>
        environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const client = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(
      new URL(`${LIMBASE_MIGRATION_ROUTE_PREFIX}/${name}`, origin),
    ).pipe(
      HttpClientRequest.bearerToken(issued.token),
      HttpClientRequest.bodyJsonUnsafe(body),
      client.execute,
      Effect.mapError(
        (cause) =>
          new LimbaseMigrationCliError({
            detail: `Could not reach the T3 Code server at ${origin}. ${cause.message}`,
          }),
      ),
    );
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return { status: response.status, text };
  }).pipe(
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, minimumLogLevel),
    Effect.provide(
      Layer.mergeAll(
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
        FetchHttpClient.layer,
      ),
    ),
  );
});

const refusal = (status: number, text: string) =>
  fail(
    Option.match(decodeErrorBody(text), {
      onSome: (error) => error.error,
      onNone: () => `The server answered ${status}: ${text.slice(0, 500)}`,
    }),
  );

const isOk = (status: number) => status >= 200 && status < 300;

const isRouteMissingOnOlderServer = (status: number, text: string) =>
  status === 404 && Option.isNone(decodeErrorBody(text));

const postAsOwner = (
  flags: { readonly baseDir: Option.Option<string> },
  name: "manifest" | "bind" | "unbind",
  body: Readonly<Record<string, unknown>>,
) =>
  sendAsOwner(flags, name, body).pipe(
    Effect.flatMap(({ status, text }) =>
      isOk(status) ? Effect.succeed(text) : refusal(status, text),
    ),
  );

const decodeLimbaseIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.NullOr(LimbaseIds)),
);

export const readLimbaseIds = Effect.fn("LimbaseMigrationCli.readLimbaseIds")(function* (
  flags: { readonly baseDir: Option.Option<string>; readonly json: boolean },
  threadId: string,
) {
  const { status, text } = yield* sendAsOwner(flags, "ids", { threadId }, flags.json);
  if (isRouteMissingOnOlderServer(status, text)) return null;
  if (!isOk(status)) return yield* refusal(status, text);
  return yield* decodeLimbaseIds(text).pipe(
    Effect.mapError(
      () =>
        new LimbaseMigrationCliError({
          detail: "The server sent an unexpected answer. Update the t3 CLI to match the server.",
        }),
    ),
  );
});

const threadArgument = Argument.String("thread").pipe(Argument.withDescription("Thread id."));
const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);

const exportManifestCommand = Command.make("export-manifest", {
  ...projectLocationFlags,
  thread: threadArgument,
  out: Flag.String("out").pipe(
    Flag.withDescription(
      "Write the manifest to this new file instead of stdout. Refuses an existing file.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Print what `limbase migrate` needs to copy a thread: its native sessions and their files, the runs each holds, its handoffs and its last run. Refuses while a run is active or queued; changes nothing.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const manifest = yield* postAsOwner(flags, "manifest", { threadId: flags.thread.trim() });
      if (Option.isNone(flags.out)) return yield* Console.log(manifest);
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const out = path.resolve(flags.out.value);
      yield* fileSystem
        .writeFileString(out, `${manifest}\n`, { flag: "wx", mode: 0o600 })
        .pipe(
          Effect.mapError(
            (cause) =>
              new LimbaseMigrationCliError({ detail: `Could not write ${out}: ${cause.message}` }),
          ),
        );
      yield* Console.error(`Wrote ${out}`);
    }).pipe(reportErrors),
  ),
);

const printBinding = Effect.fn("LimbaseMigrationCli.printBinding")(function* (
  text: string,
  json: boolean,
  verb: string,
) {
  if (json) return yield* Console.log(text);
  const result = yield* decodeBindingResult(text).pipe(
    Effect.mapError(
      () =>
        new LimbaseMigrationCliError({
          detail: "The server sent an unexpected answer. Update the t3 CLI to match the server.",
        }),
    ),
  );
  yield* Console.log(
    `${verb} ${result.threadId}: provider thread ${result.activeProviderThreadId ?? "(none)"} on ${result.providerInstanceId}.`,
  );
  if (result.limbaseRuns !== undefined) {
    const { from, to } = result.limbaseRuns;
    yield* Console.error(
      `Run${from === to ? ` ${from}` : `s ${from}-${to}`} ran on Limbase. The original session has not seen ${from === to ? "it" : "them"}.`,
    );
  }
});

const limbaseBindCommand = Command.make("limbase-bind", {
  ...projectLocationFlags,
  thread: threadArgument,
  limbaseThreadId: Flag.String("limbase-thread-id").pipe(
    Flag.withDescription("The Limbase thread the migration imported into."),
  ),
  sessionId: Flag.String("session-id").pipe(
    Flag.withDescription(
      "A new Claude session id. The Limbase host writes this session's file at the first prompt.",
    ),
  ),
  ifLastRun: Flag.Int("if-last-run").pipe(
    Flag.withDescription(
      "The manifest's lastRunOrdinal. Refuses if the thread ran again since the export.",
    ),
  ),
  ifHistory: Flag.String("if-history").pipe(
    Flag.withDescription(
      "The manifest's historyDigest. Refuses if a run was edited or rolled back since the export.",
    ),
  ),
  provider: Flag.String("provider").pipe(
    Flag.withDescription(
      "The Limbase instance to run on. Needed only when more than one Claude instance has a Limbase home.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Run a thread on its migrated copy in Limbase: adds a provider thread on the Limbase instance and makes it the active one. The original Claude session and its row stay as they are.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (flags.ifLastRun < 1) return yield* fail("--if-last-run must be 1 or more.");
      const text = yield* postAsOwner(flags, "bind", {
        threadId: flags.thread.trim(),
        limbaseThreadId: flags.limbaseThreadId,
        sessionId: flags.sessionId,
        ifLastRun: flags.ifLastRun,
        ifHistory: flags.ifHistory,
        ...(Option.isSome(flags.provider) ? { providerInstanceId: flags.provider.value } : {}),
      });
      yield* printBinding(text, flags.json, "Bound");
    }).pipe(reportErrors),
  ),
);

const limbaseUnbindCommand = Command.make("limbase-unbind", {
  ...projectLocationFlags,
  thread: threadArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Run a bound thread on the Claude session it had before `limbase-bind` again.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const text = yield* postAsOwner(flags, "unbind", { threadId: flags.thread.trim() });
      yield* printBinding(text, flags.json, "Unbound");
    }).pipe(reportErrors),
  ),
);

export const limbaseMigrationCommands = [
  exportManifestCommand,
  limbaseBindCommand,
  limbaseUnbindCommand,
] as const;
