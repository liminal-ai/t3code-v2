/**
 * The owner's route behind `t3 thread export-manifest`, `limbase-bind` and `limbase-unbind`. It
 * needs `environment:maintain`, which no MCP client session holds. Bind and unbind dispatch under
 * the thread's lock; the route checks first, so a refusal it can see records nothing.
 */
import {
  AuthEnvironmentMaintainScope,
  ClaudeSettings,
  CommandId,
  type OrchestrationV2InternalCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LimbaseMigration from "./LimbaseMigration.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

const NO_STORE = { "cache-control": "no-store" };
const refused = (message: string, status = 409) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status, headers: NO_STORE });
const ok = (body: unknown) => HttpServerResponse.jsonUnsafe(body, { headers: NO_STORE });

/** The caller must hold `environment:maintain`: the owner's devices and CLI, never an agent. */
const authenticateOwner = Effect.fnUntraced(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthEnvironmentMaintainScope)) {
    return yield* failEnvironmentScopeRequired(AuthEnvironmentMaintainScope);
  }
});

const JSON_MAX_BODY_BYTES = 16 * 1024;

class BadRequest extends Schema.TaggedError<BadRequest>()("LimbaseMigrationBadRequest", {
  detail: Schema.String,
}) {}
const isBadRequest = Schema.is(BadRequest);

const readBody = Effect.fn("LimbaseMigration.readBody")(function* <S extends Schema.Top>(
  schema: S,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const json = yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(JSON_MAX_BODY_BYTES)),
    Effect.mapError(() => new BadRequest({ detail: "The body is not JSON." })),
  );
  return yield* Schema.decodeEffect(schema)(json).pipe(
    Effect.mapError((error) => new BadRequest({ detail: error.message })),
  );
});

const readProjection = Effect.fn("LimbaseMigration.readProjection")(function* (threadId: ThreadId) {
  const orchestrator = yield* OrchestratorV2;
  return yield* orchestrator.getThreadRecords(
    threadId,
    ["runs", "attempts", "runtimeRequests", "providerThreads", "contextHandoffs"],
    { turnItemTypes: [] },
  );
});

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

/** The instance's settings, and its Claude settings when it is a Claude instance. */
const instanceSettings = Effect.fn("LimbaseMigration.instanceSettings")(function* (
  instanceId: string,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const all = yield* settings.getSettings;
  const entry = Object.hasOwn(all.providerInstances, instanceId)
    ? all.providerInstances[ProviderInstanceId.make(instanceId)]
    : undefined;
  return { entry, claude: Option.getOrUndefined(decodeClaudeSettings(entry?.config ?? {})) };
});

/** The Claude config folder an instance's sessions live under, as its driver resolves it. */
const claudeConfigDir = Effect.fn("LimbaseMigration.claudeConfigDir")(function* (
  instanceId: string,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  const { entry, claude } = yield* instanceSettings(instanceId);
  const homePath = claude?.homePath.trim() ?? "";
  if (homePath.length > 0) return path.resolve(expandHomePath(homePath, home));
  const instanceDir = entry?.environment?.find(
    (variable) => variable.name === "CLAUDE_CONFIG_DIR",
  )?.value;
  const inherited =
    (typeof instanceDir === "string" ? instanceDir : hostEnvironment.CLAUDE_CONFIG_DIR)?.trim() ??
    "";
  return path.resolve(inherited.length > 0 ? inherited : path.join(home, ".claude"));
});

/** `<config>/projects/<cwd slug>/<session>.jsonl`, wherever the session's project folder is. */
const findSessionFile = Effect.fn("LimbaseMigration.findSessionFile")(function* (
  configDir: string,
  sessionId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectsDir = path.join(configDir, "projects");
  const projects = yield* fileSystem
    .readDirectory(projectsDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const project of projects.toSorted()) {
    const candidate = path.join(projectsDir, project, `${sessionId}.jsonl`);
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
  }
  return null;
});

const exportManifest = Effect.fn("LimbaseMigration.exportManifest")(function* (threadId: ThreadId) {
  const projection = yield* readProjection(threadId);
  const refusal = LimbaseMigration.exportRefusal(projection);
  if (refusal !== undefined) return refused(refusal);
  const orchestrator = yield* OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const project = yield* projects.get(projection.thread.projectId, { includeDeleted: true });
  const cwd =
    projection.thread.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot ?? null;
  const targetRunIds = new Set(projection.contextHandoffs.map((handoff) => handoff.targetRunId));
  const messageIds = projection.runs
    .filter((run) => targetRunIds.has(run.id))
    .map((run) => run.userMessageId);
  const messages =
    messageIds.length === 0
      ? []
      : (yield* orchestrator.getThreadRecords(threadId, ["messages"], {
          messageIds,
          turnItemTypes: [],
        })).messages;
  const textByMessageId = new Map(messages.map((message) => [message.id, message.text]));
  const paths = new Map<string, string | null>();
  for (const providerThread of projection.providerThreads) {
    if (!LimbaseMigration.isClaudeDriver(providerThread.driver)) continue;
    const sessionIds = new Set<string>();
    const nativeId = providerThread.nativeThreadRef?.nativeId;
    if (nativeId !== null && nativeId !== undefined) sessionIds.add(nativeId);
    for (const attempt of projection.attempts) {
      if (attempt.providerThreadId === providerThread.id && attempt.nativeThreadId !== undefined) {
        sessionIds.add(attempt.nativeThreadId);
      }
    }
    if (sessionIds.size === 0) continue;
    const configDir = yield* claudeConfigDir(providerThread.providerInstanceId);
    for (const id of sessionIds) {
      if (!paths.has(id)) paths.set(id, yield* findSessionFile(configDir, id));
    }
  }
  return ok(
    LimbaseMigration.buildManifest({
      projection,
      cwd,
      pathOf: (session) => paths.get(session.sessionId) ?? null,
      userTextOf: (run) => textByMessageId.get(run.userMessageId),
    }),
  );
});

/** The enabled Claude instances that run their threads on Limbase. */
const limbaseInstances = Effect.fn("LimbaseMigration.limbaseInstances")(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const all = yield* settings.getSettings;
  return Object.entries(all.providerInstances).flatMap(([id, entry]) => {
    if (entry.driver !== CLAUDE_DRIVER || !resolveProviderInstanceEnabled(entry)) return [];
    const claude = Option.getOrUndefined(decodeClaudeSettings(entry.config ?? {}));
    return (claude?.limbaseHome?.trim() ?? "") === "" ? [] : [ProviderInstanceId.make(id)];
  });
});

const commandId = Effect.fn("LimbaseMigration.commandId")(function* (kind: string) {
  const random = yield* SecureRandom.SecureRandom;
  return CommandId.make(`command:fork:limbase-${kind}:${yield* random.uuidV4()}`);
});

const dispatchBinding = Effect.fn("LimbaseMigration.dispatchBinding")(function* (
  command: Extract<
    OrchestrationV2InternalCommand,
    { readonly type: "thread.limbase.bind" | "thread.limbase.unbind" }
  >,
  limbaseRuns?: { readonly from: number; readonly to: number },
) {
  const orchestrator = yield* OrchestratorV2;
  const dispatched = yield* Effect.result(orchestrator.dispatch(command));
  if (Result.isFailure(dispatched)) {
    const error = dispatched.failure;
    // A refusal under the lock (a run that started after the route's own check) carries its reason.
    if (error._tag === "OrchestratorDispatchError" && typeof error.cause === "string") {
      return refused(error.cause);
    }
    return yield* error;
  }
  const { thread } = yield* orchestrator.getThreadRecords(command.threadId, [], {
    turnItemTypes: [],
  });
  return ok({
    threadId: thread.id,
    activeProviderThreadId: thread.activeProviderThreadId,
    providerInstanceId: thread.providerInstanceId,
    ...(limbaseRuns === undefined ? {} : { limbaseRuns }),
  });
});

const bind = Effect.fn("LimbaseMigration.bind")(function* (
  body: typeof LimbaseMigration.BindRequest.Type,
) {
  const instances = yield* limbaseInstances();
  if (body.providerInstanceId !== undefined && !instances.includes(body.providerInstanceId)) {
    return refused(
      `${body.providerInstanceId} is not an enabled Claude instance with a Limbase home. Limbase instances: ${instances.join(", ") || "none"}.`,
    );
  }
  const providerInstanceId = body.providerInstanceId ?? instances[0];
  if (
    providerInstanceId === undefined ||
    (body.providerInstanceId === undefined && instances.length > 1)
  ) {
    return refused(
      instances.length === 0
        ? "No enabled Claude instance has a Limbase home, so there is nothing to bind to."
        : `More than one Claude instance has a Limbase home (${instances.join(", ")}). Pass --provider.`,
    );
  }
  const command = {
    type: "thread.limbase.bind" as const,
    commandId: yield* commandId("bind"),
    threadId: body.threadId,
    providerInstanceId,
    limbaseThreadId: body.limbaseThreadId,
    sessionId: body.sessionId,
    ifLastRun: body.ifLastRun,
  };
  const plan = LimbaseMigration.planBind({
    projection: yield* readProjection(body.threadId),
    command,
    providerThreadId: IdAllocator.derive.providerThread({
      driver: CLAUDE_DRIVER,
      nativeThreadId: body.sessionId,
    }),
    now: yield* DateTime.now,
  });
  if (Result.isFailure(plan)) return refused(plan.failure);
  return yield* dispatchBinding(command);
});

const unbind = Effect.fn("LimbaseMigration.unbind")(function* (
  body: typeof LimbaseMigration.UnbindRequest.Type,
) {
  const plan = LimbaseMigration.planUnbind({
    projection: yield* readProjection(body.threadId),
    now: yield* DateTime.now,
  });
  if (Result.isFailure(plan)) return refused(plan.failure);
  return yield* dispatchBinding(
    {
      type: "thread.limbase.unbind",
      commandId: yield* commandId("unbind"),
      threadId: body.threadId,
    },
    plan.success.limbaseRuns,
  );
});

const isThreadNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "cause" in error &&
  typeof error.cause === "object" &&
  error.cause !== null &&
  "_tag" in error.cause &&
  error.cause._tag === "ProjectionStoreThreadNotFoundError";

/** Answers a failure: auth errors as the environment API does, a bad body 400, the rest 500. */
const failureResponse = Effect.fn("LimbaseMigration.failureResponse")(function* (error: unknown) {
  if (HttpServerRespondable.isRespondable(error))
    return yield* HttpServerRespondable.toResponse(error);
  if (isBadRequest(error)) return refused(error.detail, 400);
  if (isThreadNotFound(error)) return refused("No thread has that id.", 404);
  return yield* failEnvironmentInternal("internal_error", error).pipe(
    Effect.catch((internal) => HttpServerRespondable.toResponse(internal)),
  );
});

const manifestRoute = HttpRouter.add(
  "POST",
  `${LimbaseMigration.LIMBASE_MIGRATION_ROUTE_PREFIX}/manifest`,
  authenticateOwner().pipe(
    Effect.andThen(readBody(LimbaseMigration.ManifestRequest)),
    Effect.flatMap((body) => exportManifest(body.threadId)),
    Effect.catch(failureResponse),
  ),
);

const bindRoute = HttpRouter.add(
  "POST",
  `${LimbaseMigration.LIMBASE_MIGRATION_ROUTE_PREFIX}/bind`,
  authenticateOwner().pipe(
    Effect.andThen(readBody(LimbaseMigration.BindRequest)),
    Effect.flatMap(bind),
    Effect.catch(failureResponse),
  ),
);

const unbindRoute = HttpRouter.add(
  "POST",
  `${LimbaseMigration.LIMBASE_MIGRATION_ROUTE_PREFIX}/unbind`,
  authenticateOwner().pipe(
    Effect.andThen(readBody(LimbaseMigration.UnbindRequest)),
    Effect.flatMap(unbind),
    Effect.catch(failureResponse),
  ),
);

export const layer = Layer.mergeAll(manifestRoute, bindRoute, unbindRoute);
