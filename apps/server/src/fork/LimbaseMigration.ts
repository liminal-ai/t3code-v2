// @effect-diagnostics nodeBuiltinImport:off - a pure module; hashing needs no service.
/**
 * Moves a Claude thread onto its migrated copy in Limbase and back (LH-336): the manifest
 * `limbase migrate` copies from, and the bind and unbind plans. Neither writes the original row.
 * A bound row's `limbaseMigratedThroughRunOrdinal` counts as runs it has seen and begins its history.
 */
import * as NodeCrypto from "node:crypto";

import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  latestProviderTurnForAttempt,
  PositiveInt,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderThreadId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/** The owner's route; the CLI posts here and `LimbaseMigrationRoute` answers. */
export const LIMBASE_MIGRATION_ROUTE_PREFIX = "/api/fork/limbase-migration";

export const ManifestRequest = Schema.Struct({ threadId: ThreadId });
export const BindRequest = Schema.Struct({
  threadId: ThreadId,
  limbaseThreadId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  ifLastRun: PositiveInt,
  /** The manifest's `historyDigest`. */
  ifHistory: TrimmedNonEmptyString,
  /** The Limbase instance; needed only when more than one qualifies. */
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export const UnbindRequest = Schema.Struct({ threadId: ThreadId });

/** What bind and unbind answer: the thread's active provider thread and instance afterwards. */
export const BindingResult = Schema.Struct({
  threadId: ThreadId,
  activeProviderThreadId: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.String,
  /** On unbind: the runs made on Limbase, which the original session has not seen. */
  limbaseRuns: Schema.optional(Schema.Struct({ from: PositiveInt, to: PositiveInt })),
});

export const LimbaseIdsRequest = Schema.Struct({ threadId: ThreadId });

export const LimbaseIds = Schema.Struct({
  providerThreadId: Schema.String,
  limbaseThreadId: Schema.String,
});
export type LimbaseIds = typeof LimbaseIds.Type;

export const limbaseIds = (projection: {
  readonly thread: Pick<OrchestrationV2AppThread, "activeProviderThreadId">;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "nativeMetadata">
  >;
}): LimbaseIds | null => {
  const active = projection.providerThreads.find(
    (row) => row.id === projection.thread.activeProviderThreadId,
  );
  const limbaseThreadId = active?.nativeMetadata?.limbaseThreadId;
  return active === undefined || limbaseThreadId === undefined
    ? null
    : { providerThreadId: active.id, limbaseThreadId };
};

type MigrationMetadata = Pick<OrchestrationV2ProviderThread, "nativeMetadata">;

/** The last run a migration copied into this row's Limbase thread, or undefined for any other row. */
export const migratedThroughRunOrdinal = (providerThread: MigrationMetadata): number | undefined =>
  providerThread.nativeMetadata?.limbaseMigratedThroughRunOrdinal;

/**
 * The ordinal the row's history starts at: its first run, or for a migrated row that has none yet,
 * the run after the last one the migration copied.
 */
export const historyStartOrdinal = (
  providerThread: MigrationMetadata & Pick<OrchestrationV2ProviderThread, "firstRunOrdinal">,
): number | null => {
  if (providerThread.firstRunOrdinal !== null) return providerThread.firstRunOrdinal;
  const migrated = migratedThroughRunOrdinal(providerThread);
  return migrated === undefined ? null : migrated + 1;
};

/** The highest run ordinal on the thread, whatever its status; 0 for a thread with no runs. */
const lastRunOrdinal = (runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal">>): number =>
  runs.reduce((last, run) => Math.max(last, run.ordinal), 0);

const SETTLED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

/** A run that is not settled (queued, starting, running or waiting) or a question still open. */
const hasWorkInProgress = (projection: {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>;
  readonly runtimeRequests: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "status">>;
}) =>
  projection.runs.some((run) => !SETTLED_RUN_STATUSES.has(run.status)) ||
  projection.runtimeRequests.some((request) => request.status === "pending");

const WORK_IN_PROGRESS =
  "has a run in progress or queued, or a question waiting for an answer. Let it finish, then export again.";

export interface MigrationProjection {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
}

/** Why the thread cannot be exported now, or undefined when it can. */
export const exportRefusal = (projection: MigrationProjection): string | undefined => {
  if (projection.thread.deletedAt !== null) return `Thread ${projection.thread.id} is deleted.`;
  if (hasWorkInProgress(projection)) return `Thread ${projection.thread.id} ${WORK_IN_PROGRESS}`;
  return undefined;
};

/** The thread with another provider thread active, on that row's instance, keeping the model. */
const pointedAt = (
  thread: OrchestrationV2AppThread,
  providerThread: Pick<OrchestrationV2ProviderThread, "id" | "providerInstanceId">,
  now: OrchestrationV2AppThread["updatedAt"],
): OrchestrationV2AppThread => ({
  ...thread,
  activeProviderThreadId: providerThread.id,
  providerInstanceId: providerThread.providerInstanceId,
  modelSelection: { ...thread.modelSelection, instanceId: providerThread.providerInstanceId },
  updatedAt: now,
});

export interface BindPlan {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly thread: OrchestrationV2AppThread;
}

/**
 * The new provider thread a bind adds, and the thread pointed at it. Refused, with the reason, when
 * the thread has work in progress, when a run was added since the export, or when the active row
 * is not a plain Claude session.
 */
export const planBind = (input: {
  readonly projection: MigrationProjection;
  readonly command: Extract<
    OrchestrationV2InternalCommand,
    { readonly type: "thread.limbase.bind" }
  >;
  /** The id core derives for a Claude row whose native session is `command.sessionId`. */
  readonly providerThreadId: ProviderThreadId;
  readonly now: OrchestrationV2AppThread["updatedAt"];
}): Result.Result<BindPlan, string> => {
  const { projection, command } = input;
  const thread = projection.thread;
  const refused = exportRefusal(projection);
  if (refused !== undefined) return Result.fail(refused);
  const last = lastRunOrdinal(projection.runs);
  if (last !== command.ifLastRun) {
    return Result.fail(
      `Thread ${thread.id} has run ${last} as its last run, not ${command.ifLastRun}, so it changed after the export. Export and migrate it again.`,
    );
  }
  if (historyDigest(projection.runs) !== command.ifHistory) {
    return Result.fail(
      `Thread ${thread.id}'s runs changed after the export, as an edit or rollback does. Export and migrate it again.`,
    );
  }
  const active = projection.providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  if (active === undefined) {
    return Result.fail(`Thread ${thread.id} has no active provider thread to move from.`);
  }
  if (active.nativeMetadata?.limbaseMigratedFromProviderThreadId !== undefined) {
    return Result.fail(
      `Thread ${thread.id} is already bound to Limbase thread ${active.nativeMetadata.limbaseThreadId}. Unbind it first.`,
    );
  }
  if (active.driver !== CLAUDE_DRIVER) {
    return Result.fail(`Thread ${thread.id} runs on ${active.driver}, not Claude.`);
  }
  if (projection.providerThreads.some((candidate) => candidate.id === input.providerThreadId)) {
    return Result.fail(
      `Thread ${thread.id} already has a provider thread for session ${command.sessionId}. Import into a new session.`,
    );
  }
  const providerThread: OrchestrationV2ProviderThread = {
    id: input.providerThreadId,
    driver: CLAUDE_DRIVER,
    providerInstanceId: command.providerInstanceId,
    providerSessionId: null,
    appThreadId: thread.id,
    ownerNodeId: null,
    nativeThreadRef: { driver: CLAUDE_DRIVER, nativeId: command.sessionId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: {
      limbaseThreadId: command.limbaseThreadId,
      limbaseMigratedThroughRunOrdinal: command.ifLastRun,
      limbaseMigratedFromProviderThreadId: active.id,
      ...(active.nativeMetadata?.title === undefined ? {} : { title: active.nativeMetadata.title }),
    },
    goal: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return Result.succeed({ providerThread, thread: pointedAt(thread, providerThread, input.now) });
};

export interface UnbindPlan {
  readonly thread: OrchestrationV2AppThread;
  /** The runs made on the Limbase row, which the original session has not seen. */
  readonly limbaseRuns: { readonly from: number; readonly to: number } | undefined;
}

/** The thread pointed back at the row a bind replaced. Refused when it is not bound or is busy. */
export const planUnbind = (input: {
  readonly projection: MigrationProjection;
  readonly now: OrchestrationV2AppThread["updatedAt"];
}): Result.Result<UnbindPlan, string> => {
  const { projection } = input;
  const thread = projection.thread;
  if (thread.deletedAt !== null) return Result.fail(`Thread ${thread.id} is deleted.`);
  if (hasWorkInProgress(projection)) {
    return Result.fail(
      `Thread ${thread.id} has a run in progress or queued, or a question waiting for an answer. Let it finish, then unbind.`,
    );
  }
  const active = projection.providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  const originalId = active?.nativeMetadata?.limbaseMigratedFromProviderThreadId;
  if (originalId === undefined) {
    return Result.fail(`Thread ${thread.id} is not bound to a Limbase thread.`);
  }
  const original = projection.providerThreads.find((candidate) => candidate.id === originalId);
  if (original === undefined) {
    return Result.fail(`Thread ${thread.id} no longer has provider thread ${originalId}.`);
  }
  const limbaseRuns = projection.runs
    .filter((run) => run.providerThreadId === active?.id)
    .map((run) => run.ordinal)
    .toSorted((left, right) => left - right);
  return Result.succeed({
    thread: pointedAt(thread, original, input.now),
    limbaseRuns:
      limbaseRuns.length === 0 ? undefined : { from: limbaseRuns[0]!, to: limbaseRuns.at(-1)! },
  });
};

const ManifestSession = Schema.Struct({
  sessionId: Schema.String,
  driver: Schema.String,
  providerInstanceId: Schema.String,
  providerThreadIds: Schema.Array(Schema.String),
  /** The session's file on disk; null when it was not found or is not a Claude session. */
  path: Schema.NullOr(Schema.String),
  limbaseThreadId: Schema.optional(Schema.String),
  runRange: Schema.Struct({ first: Schema.Number, last: Schema.Number }),
  runOrdinals: Schema.Array(Schema.Number),
  /** The session's first run started a new provider conversation. */
  freshContext: Schema.optional(Schema.Literal(true)),
});

const ManifestHandoff = Schema.Struct({
  runOrdinal: Schema.Number,
  strategy: Schema.String,
  status: Schema.String,
  coveredRunOrdinals: Schema.Struct({ from: Schema.Number, to: Schema.Number }),
  deliveryStatus: Schema.NullOr(Schema.String),
  /** SHA-256 of the user's own text in the run the handoff was delivered with. */
  cleanUserTextSha256: Schema.NullOr(Schema.String),
});

/** One attempt of a run, in the order they started. A steering restart starts a second one. */
const ManifestAttempt = Schema.Struct({
  attemptOrdinal: Schema.Number,
  status: Schema.String,
  /** The native session the attempt's prompt went to; null when it never reached one. */
  sessionId: Schema.NullOr(Schema.String),
  /**
   * The `uuid` of the last root (non-subagent) assistant line this attempt, not the run, wrote to
   * `sessionId`'s file. Walking `parentUuid` back from it reaches the attempt's own prompt line.
   * Null when the attempt wrote no assistant line, or is not on a Claude session.
   */
  lastRootAssistantUuid: Schema.NullOr(Schema.String),
});

const ManifestRun = Schema.Struct({
  ordinal: Schema.Number,
  /** completed, failed, interrupted, cancelled or rolled_back: an export needs every run settled. */
  status: Schema.String,
  /** On a failed run: the provider failure's class, such as `usage_limit`, and its code. */
  failureClass: Schema.optional(Schema.String),
  failureCode: Schema.optional(Schema.String),
  attempts: Schema.Array(ManifestAttempt),
});

/** The manifest `t3 thread export-manifest` prints. Later fields are optional, so older ones read. */
export const ThreadManifest = Schema.Struct({
  formatVersion: Schema.Literal(1),
  threadId: Schema.String,
  title: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  modelSelection: Schema.Struct({
    instanceId: Schema.String,
    model: Schema.String,
    options: Schema.optional(Schema.Unknown),
  }),
  providerInstanceId: Schema.String,
  activeProviderThreadId: Schema.NullOr(Schema.String),
  lastRunOrdinal: Schema.Number,
  /** Changes when a run is added or changes status, as a rollback does; bind compares it. */
  historyDigest: Schema.String,
  sessions: Schema.Array(ManifestSession),
  handoffs: Schema.Array(ManifestHandoff),
  /** Every run in ordinal order, with how it ended and its attempts. */
  runs: Schema.optional(Schema.Array(ManifestRun)),
});
export type ThreadManifest = typeof ThreadManifest.Type;

/** A run whose prompt reached a provider and is still part of the thread's history. */
const reachedProvider = (run: OrchestrationV2Run) =>
  run.status === "completed" ||
  run.status === "failed" ||
  run.status === "interrupted" ||
  (run.status === "cancelled" && run.startedAt !== null);

export const sha256Hex = (text: string) =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

/** Every run's ordinal and status, hashed: a rollback flips runs to `rolled_back` without a new run. */
export const historyDigest = (
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status">>,
) =>
  sha256Hex(
    runs
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .map((run) => `${run.ordinal}:${run.status}`)
      .join(","),
  );

/**
 * The thread's native sessions in the order their runs began, with the runs each holds, and the
 * handoffs T3 delivered. `pathOf` locates a Claude session's file; `userTextOf` reads the clean
 * text of a run's user message.
 */
export const buildManifest = (input: {
  readonly projection: MigrationProjection & {
    readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
    readonly contextHandoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
    /** The thread's `error` items, which hold each failed run's provider failure. */
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  };
  readonly cwd: string | null;
  readonly pathOf: (session: {
    readonly sessionId: string;
    readonly driver: string;
    readonly providerInstanceId: string;
  }) => string | null;
  readonly userTextOf: (run: OrchestrationV2Run) => string | undefined;
}): ThreadManifest => {
  const { projection } = input;
  const providerThreads = new Map(projection.providerThreads.map((row) => [row.id, row]));
  const attempts = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  const sessions = new Map<
    string,
    { row: OrchestrationV2ProviderThread; rowIds: Set<string>; runs: Array<OrchestrationV2Run> }
  >();
  const runs = projection.runs.toSorted((left, right) => left.ordinal - right.ordinal);
  for (const run of runs) {
    if (!reachedProvider(run) || run.providerThreadId === null) continue;
    const row = providerThreads.get(run.providerThreadId);
    if (row === undefined) continue;
    const attempt = run.activeAttemptId === null ? undefined : attempts.get(run.activeAttemptId);
    const sessionId = attempt?.nativeThreadId ?? row.nativeThreadRef?.nativeId ?? null;
    if (sessionId === null) continue;
    const session = sessions.get(sessionId) ?? { row, rowIds: new Set<string>(), runs: [] };
    session.rowIds.add(row.id);
    session.runs.push(run);
    sessions.set(sessionId, session);
  }
  const byRunId = new Map(runs.map((run) => [run.id, run]));
  return {
    formatVersion: 1,
    threadId: projection.thread.id,
    title: projection.thread.title,
    cwd: input.cwd,
    modelSelection: projection.thread.modelSelection,
    providerInstanceId: projection.thread.providerInstanceId,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    lastRunOrdinal: lastRunOrdinal(projection.runs),
    historyDigest: historyDigest(projection.runs),
    sessions: [...sessions].map(([sessionId, { row, rowIds, runs: sessionRuns }]) => {
      const ordinals = sessionRuns.map((run) => run.ordinal);
      return {
        sessionId,
        driver: row.driver,
        providerInstanceId: row.providerInstanceId,
        providerThreadIds: [...rowIds],
        path: input.pathOf({
          sessionId,
          driver: row.driver,
          providerInstanceId: row.providerInstanceId,
        }),
        ...(row.nativeMetadata?.limbaseThreadId === undefined
          ? {}
          : { limbaseThreadId: row.nativeMetadata.limbaseThreadId }),
        runRange: { first: ordinals[0]!, last: ordinals.at(-1)! },
        runOrdinals: ordinals,
        ...(sessionRuns[0]!.freshContext === true ? { freshContext: true as const } : {}),
      };
    }),
    handoffs: projection.contextHandoffs
      .flatMap((handoff) => {
        const run = byRunId.get(handoff.targetRunId);
        if (run === undefined) return [];
        const text = input.userTextOf(run);
        return [
          {
            runOrdinal: run.ordinal,
            strategy: handoff.strategy,
            status: handoff.status,
            coveredRunOrdinals: handoff.coveredRunOrdinals,
            deliveryStatus: handoff.delivery?.status ?? null,
            cleanUserTextSha256: text === undefined ? null : sha256Hex(text),
          },
        ];
      })
      .toSorted((left, right) => left.runOrdinal - right.runOrdinal),
    runs: runs.map((run) => {
      const failure = latestRootProviderFailure(run, projection.turnItems);
      return {
        ordinal: run.ordinal,
        status: run.status,
        ...(failure === null ? {} : { failureClass: failure.class }),
        ...(failure?.code === null || failure?.code === undefined
          ? {}
          : { failureCode: failure.code }),
        attempts: projection.attempts
          .filter((attempt) => attempt.runId === run.id)
          .toSorted((left, right) => left.attemptOrdinal - right.attemptOrdinal)
          .map((attempt) => {
            const row = providerThreads.get(attempt.providerThreadId);
            const sessionId = attempt.nativeThreadId ?? row?.nativeThreadRef?.nativeId ?? null;
            const cursor = latestProviderTurnForAttempt(projection.providerTurns, attempt.id)
              ?.nativeTurnRef?.nativeId;
            return {
              attemptOrdinal: attempt.attemptOrdinal,
              status: attempt.status,
              sessionId,
              // The adapter keeps `turn:<attempt>` until a root assistant line arrives.
              lastRootAssistantUuid:
                row !== undefined &&
                isClaudeDriver(row.driver) &&
                sessionId !== null &&
                cursor !== undefined &&
                cursor !== null &&
                UUID.test(cursor)
                  ? cursor
                  : null,
            };
          }),
      };
    }),
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isClaudeDriver = (driver: string) => driver === CLAUDE_DRIVER;
