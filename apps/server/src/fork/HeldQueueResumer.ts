/**
 * Upstream holds every queued run at a restart and waits for the user's Resume. This fork
 * releases a queue that only a restart held, once the thread is quiet and its last turn ended
 * well. `queueHeld` carries no reason, so the stored command id of the event that set it is the
 * one record of why, and only a `command:runtime-reconcile:` hold counts as a restart.
 */
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

export const RECONCILE_COMMAND_PREFIX = "command:runtime-reconcile:";

export class HeldQueueResumer extends Context.Service<
  HeldQueueResumer,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass over every held queue; `start` runs it once after activation. */
    readonly scan: Effect.Effect<void>;
  }
>()("t3/fork/HeldQueueResumer") {}

type HoldSource =
  | {
      readonly kind: "restart";
      readonly reconcileCommandId: CommandId;
      readonly sequence: number;
      readonly heldAt: DateTime.Utc;
    }
  | { readonly kind: "stopped" }
  | { readonly kind: "system" };

interface RestartHeld {
  readonly kind: "restart";
  readonly threadId: ThreadId;
  readonly reconcileCommandId: CommandId;
  readonly oldestHeldAt: DateTime.Utc;
}

type HeldThreadClass =
  | RestartHeld
  | { readonly kind: "stopped" | "system" | "unknown"; readonly threadId: ThreadId };

interface StreamRow {
  readonly sequence: number;
  readonly event_type: string;
  readonly command_id: string | null;
  readonly occurred_at: string;
  readonly run_id: RunId | null;
  readonly status: OrchestrationV2Run["status"] | null;
  readonly queue_held: 0 | 1 | null;
}

interface RunEventRow extends StreamRow {
  readonly event_type: "run.created" | "run.updated";
  readonly run_id: RunId;
}

interface HoldHistory {
  readonly runEvents: ReadonlyArray<RunEventRow>;
  readonly complete: boolean;
}

const FIRST_BATCH = 64;
const LARGEST_BATCH = 1024;
const STREAM_CAP = 2048;

/** Which held runs still have no event showing where their hold began. */
const holdOrigins = (heldRunIds: ReadonlyArray<RunId>) => {
  const pending = new Set(heldRunIds);
  const open = new Set<RunId>();
  return {
    get resolved() {
      return pending.size === 0;
    },
    note(row: RunEventRow) {
      if (row.event_type === "run.created") {
        open.delete(row.run_id);
        if (pending.delete(row.run_id) && row.queue_held === 1)
          for (const id of open) pending.add(id);
        return;
      }
      // Recovery holds only a run not yet held (ProviderRuntimeRecoveryService.ts
      // reconcileProjection), so its hold row is where this run's hold began.
      if (row.queue_held === 0 || row.command_id?.startsWith(RECONCILE_COMMAND_PREFIX))
        pending.delete(row.run_id);
      open.add(row.run_id);
    },
  };
};

const readHoldHistory = (threadId: ThreadId, heldRunIds: ReadonlyArray<RunId>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const origins = holdOrigins(heldRunIds);
    const runEvents: Array<RunEventRow> = [];
    let before = Number.MAX_SAFE_INTEGER;
    let read = 0;
    let limit = FIRST_BATCH;
    while (!origins.resolved && read < STREAM_CAP) {
      const batch = yield* sql<StreamRow>`
        SELECT
          sequence,
          event_type,
          command_id,
          occurred_at,
          CASE WHEN event_type IN ('run.created', 'run.updated')
            THEN json_extract(payload_json, '$.id') END AS run_id,
          CASE WHEN event_type IN ('run.created', 'run.updated')
            THEN json_extract(payload_json, '$.status') END AS status,
          CASE WHEN event_type IN ('run.created', 'run.updated')
            THEN json_extract(payload_json, '$.queueHeld') END AS queue_held
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND application_event_version = 2
          AND sequence < ${before}
        ORDER BY sequence DESC
        LIMIT ${Math.min(limit, STREAM_CAP - read)}
      `;
      if (batch.length === 0) break;
      limit = Math.min(limit * 2, LARGEST_BATCH);
      for (const row of batch) {
        before = row.sequence;
        read += 1;
        if (
          row.run_id === null ||
          (row.event_type !== "run.created" && row.event_type !== "run.updated") ||
          (row.event_type === "run.updated" && row.queue_held === null)
        )
          continue;
        const event: RunEventRow = { ...row, event_type: row.event_type, run_id: row.run_id };
        origins.note(event);
        runEvents.push(event);
      }
    }
    return { runEvents: runEvents.toReversed(), complete: origins.resolved } satisfies HoldHistory;
  }).pipe(NodeSqliteClient.readOnly);

const holdFromRow = (row: RunEventRow): HoldSource =>
  row.command_id === null
    ? { kind: "system" }
    : row.command_id.startsWith(RECONCILE_COMMAND_PREFIX)
      ? {
          kind: "restart",
          reconcileCommandId: CommandId.make(row.command_id),
          sequence: row.sequence,
          heldAt: DateTime.makeUnsafe(row.occurred_at),
        }
      : { kind: "stopped" };

const strictestHold = (holds: ReadonlyArray<HoldSource>): HoldSource | undefined => {
  let strictest: HoldSource | undefined;
  for (const hold of holds) {
    if (hold.kind === "system") return hold;
    if (hold.kind === "stopped") strictest = hold;
    else if (
      strictest === undefined ||
      (strictest.kind === "restart" && hold.sequence > strictest.sequence)
    )
      strictest = hold;
  }
  return strictest;
};

/** A run born held takes its held siblings' hold. With none it is a worktree hold. */
const bornHold = (siblings: ReadonlyArray<HoldSource>): HoldSource =>
  strictestHold(siblings) ?? { kind: "system" };

const classifyHeldThread = (threadId: ThreadId, history: HoldHistory): HeldThreadClass => {
  if (!history.complete) return { kind: "unknown", threadId };
  const runs = new Map<RunId, { status: OrchestrationV2Run["status"]; hold: HoldSource | null }>();
  const heldQueuedRuns = () =>
    [...runs.values()].flatMap((run) =>
      run.status === "queued" && run.hold !== null ? [run.hold] : [],
    );
  for (const row of history.runEvents) {
    const status = row.status ?? "queued";
    const held = row.queue_held === 1;
    if (row.event_type === "run.created") {
      runs.set(row.run_id, { status, hold: held ? bornHold(heldQueuedRuns()) : null });
      continue;
    }
    const prior = runs.get(row.run_id);
    const hold = !held ? null : prior?.hold != null ? prior.hold : holdFromRow(row);
    runs.set(row.run_id, { status, hold });
  }
  const holds = heldQueuedRuns();
  const hold = strictestHold(holds);
  if (hold === undefined) return { kind: "unknown", threadId };
  if (hold.kind !== "restart") return { kind: hold.kind, threadId };
  let oldest = hold;
  for (const candidate of holds)
    if (candidate.kind === "restart" && candidate.sequence < oldest.sequence) oldest = candidate;
  return {
    kind: "restart",
    threadId,
    reconcileCommandId: hold.reconcileCommandId,
    oldestHeldAt: oldest.heldAt,
  };
};

/** The hold class of one thread whose queued runs `heldRunIds` are held now. */
const classifyHeld = (threadId: ThreadId, heldRunIds: ReadonlyArray<RunId>) =>
  readHoldHistory(threadId, heldRunIds).pipe(
    Effect.map((history) => classifyHeldThread(threadId, history)),
  );

export const resumeCommandId = (input: {
  readonly threadId: ThreadId;
  readonly headRunId: RunId;
  readonly reconcileCommandId: CommandId;
}) =>
  CommandId.make(
    `command:fork-held-queue-resume:${input.threadId}:${input.headRunId}:${input.reconcileCommandId}`,
  );

/** A turn about to start or in progress. `waiting` is not one: core starts the next queued run then. */
const ACTIVE = new Set<OrchestrationV2Run["status"]>(["preparing", "starting", "running"]);

const ENDED_WELL = new Set<OrchestrationV2Run["status"]>(["completed", "waiting"]);

type Outcome =
  | "resumed"
  | "setting-off"
  | "stale"
  | "needs-user"
  | "cut"
  | "declined"
  | "stopped"
  | "failed"
  | "released"
  | "refused";

const tally = (keys: ReadonlyArray<string>) => {
  const counts: Record<string, number> = {};
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const settings = yield* ServerSettings.ServerSettingsService;

  const heldRuns = sql<{ readonly thread_id: ThreadId; readonly run_id: RunId }>`
    SELECT thread_id, json_extract(payload_json, '$.id') AS run_id
    FROM orchestration_v2_projection_runs
    WHERE status = 'queued' AND json_extract(payload_json, '$.queueHeld') IS 1
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.map((rows) => {
      const byThread = new Map<ThreadId, Array<RunId>>();
      for (const row of rows) {
        const runIds = byThread.get(row.thread_id);
        if (runIds === undefined) byThread.set(row.thread_id, [row.run_id]);
        else runIds.push(row.run_id);
      }
      return byThread;
    }),
  );

  const pendingContinuation = (threadId: ThreadId) =>
    sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId}
        AND effect_type = 'provider-runtime.continue'
        AND status IN ('pending', 'running')
      LIMIT 1
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => rows[0]?.effect_id),
    );

  const quiet = (threadId: ThreadId) =>
    Effect.gen(function* () {
      while (true) {
        const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
        const pending = yield* pendingContinuation(threadId);
        if (pending !== undefined) {
          yield* outbox.awaitSettled(pending);
          continue;
        }
        const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
        if (!runs.some((run) => ACTIVE.has(run.status))) return runs;
        yield* orchestrator
          .streamStoredEventsFrom({ threadId, afterSequence, eventType: "run.updated" })
          .pipe(Stream.take(1), Stream.runDrain);
      }
    });

  const parkedForUser = (shell: OrchestrationV2ThreadShell, now: DateTime.Utc) =>
    shell.archivedAt !== null ||
    shell.settledAt !== null ||
    shell.settledOverride === "settled" ||
    (shell.snoozedUntil != null && DateTime.isGreaterThan(shell.snoozedUntil, now)) ||
    shell.pendingRuntimeRequest !== null;

  const secretOrStopAfterHold = (held: RestartHeld) =>
    projections
      .getThreadRecords(held.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request", "run_interrupt_request"],
      })
      .pipe(
        NodeSqliteClient.readOnly,
        Effect.map(({ turnItems }) =>
          turnItems.some((item) =>
            item.type === "secret_request"
              ? item.secretStatus === "pending"
              : DateTime.isGreaterThanOrEqualTo(item.updatedAt, held.oldestHeldAt),
          ),
        ),
      );

  const admit = (held: RestartHeld): Effect.Effect<Outcome | RestartHeld> =>
    Effect.gen(function* () {
      const shell = yield* projections.getThreadShell(held.threadId);
      if (shell === null || shell.deletedAt !== null) return "needs-user" as const;
      const current = yield* settings.getSettings;
      if (
        !resolveProjectSettings(current, shell.projectId).settings.continueThreadsAfterServerUpdate
      )
        return "setting-off" as const;
      // Upstream EffectOutbox.ts EffectOutboxV2Shape.pruneSettled can erase core's refusal
      // of a continuation after SETTLED_EFFECT_RETENTION.
      if (
        DateTime.isGreaterThanOrEqualTo(
          yield* DateTime.now,
          DateTime.addDuration(held.oldestHeldAt, EffectOutbox.SETTLED_EFFECT_RETENTION),
        )
      )
        return "stale" as const;
      return held;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("held queue not admitted", { threadId: held.threadId, cause }).pipe(
          Effect.as("refused" as const),
        ),
      ),
    );

  const decide = (held: RestartHeld, runs: ReadonlyArray<OrchestrationV2Run>) =>
    Effect.gen(function* () {
      const { threadId } = held;
      const shell = yield* projections.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) return "needs-user";
      if (parkedForUser(shell, yield* DateTime.now) || (yield* secretOrStopAfterHold(held)))
        return "needs-user";
      const last = latestExecutedRun(runs);
      if (last !== null && !ENDED_WELL.has(last.status))
        return last.status === "cancelled"
          ? "cut"
          : last.status === "interrupted"
            ? "stopped"
            : "failed";
      // Core writes this effect for a run it meant to continue. With nothing continuing the run,
      // core declined when the effect ran, as it does past its chain cap.
      if (
        last !== null &&
        Option.isSome(yield* outbox.get(`effect:restart-continuation:${last.id}`))
      )
        return "declined";
      const queued = runs
        .filter((run) => run.status === "queued")
        .sort(
          (left, right) =>
            (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
        );
      const head = queued[0];
      if (head === undefined || !queued.some((run) => run.queueHeld === true)) return "released";
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: resumeCommandId({
          threadId,
          headRunId: head.id,
          reconcileCommandId: held.reconcileCommandId,
        }),
        threadId,
      });
      return "resumed" as Outcome;
    });

  const release = (held: RestartHeld) =>
    Effect.gen(function* () {
      const from = yield* Clock.currentTimeMillis;
      const runs = yield* quiet(held.threadId);
      const waitedMs = (yield* Clock.currentTimeMillis) - from;
      const outcome = yield* decide(held, runs);
      yield* Effect.logInfo("held queue release", { threadId: held.threadId, outcome, waitedMs });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("held queue not resumed", { threadId: held.threadId, cause }),
      ),
    );

  const scan = Effect.gen(function* () {
    const from = yield* Clock.currentTimeMillis;
    yield* Effect.logInfo("held queue scan started");
    const held = yield* heldRuns;
    const classes = yield* Effect.forEach(held, ([threadId, runIds]) =>
      classifyHeld(threadId, runIds).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    );
    yield* Effect.logInfo("held queues classified", {
      threads: held.size,
      ...tally(classes.map((held) => held.kind)),
      ms: (yield* Clock.currentTimeMillis) - from,
    });
    const admitted = yield* Effect.forEach(
      classes.flatMap((held) => (held.kind === "restart" ? [held] : [])),
      admit,
    );
    const releases = admitted.flatMap((entry) => (typeof entry === "string" ? [] : [entry]));
    yield* Effect.logInfo("held queue scan ended", {
      threads: held.size,
      ...tally(classes.map((held) => held.kind)),
      ...tally(admitted.flatMap((entry) => (typeof entry === "string" ? [entry] : []))),
      releasing: releases.length,
      ms: (yield* Clock.currentTimeMillis) - from,
    });
    yield* Effect.forEach(releases, release, { concurrency: "unbounded", discard: true });
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("held queue scan failed", { cause })));

  const start: HeldQueueResumer["Service"]["start"] = () => forkParked(scan);

  return HeldQueueResumer.of({ start, scan });
});

export const layer = Layer.effect(HeldQueueResumer, make);

export const layerStart = Layer.effectDiscard(
  Effect.flatMap(HeldQueueResumer, (resumer) => resumer.start()),
).pipe(
  Layer.provide(layer),
  Layer.provide(ProjectionStore.layer),
  Layer.provide(EffectOutbox.layer),
);
