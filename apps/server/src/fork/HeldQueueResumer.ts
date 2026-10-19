/**
 * Upstream holds every queued run at a restart and waits for the user's Resume. This fork
 * releases a queue that only a restart held, once the cut turn's continuation is admitted.
 * `queueHeld` carries no reason, so the stored command id of the event that set it is the one
 * record of why, and only a `command:runtime-reconcile:` hold counts as a restart.
 */
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
  readonly heldAt: DateTime.Utc;
  /** Runs the thread's latest reconcile pass cancelled or noted cancelled work on. */
  readonly touchedRunIds: ReadonlyArray<RunId>;
}

type HeldThreadClass =
  | RestartHeld
  | { readonly kind: "stopped" | "system" | "unknown"; readonly threadId: ThreadId };

interface RunEventRow {
  readonly sequence: number;
  readonly event_type: "run.created" | "run.updated" | "run.background-work-cancelled";
  readonly command_id: string | null;
  readonly occurred_at: string;
  readonly run_id: RunId;
  readonly status: OrchestrationV2Run["status"] | null;
  readonly queue_held: 0 | 1 | null;
}

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

const classifyHeldThread = (
  threadId: ThreadId,
  rows: ReadonlyArray<RunEventRow>,
): HeldThreadClass => {
  const runs = new Map<RunId, { status: OrchestrationV2Run["status"]; hold: HoldSource | null }>();
  const heldQueuedRuns = () =>
    [...runs.values()].flatMap((run) =>
      run.status === "queued" && run.hold !== null ? [run.hold] : [],
    );
  let latestPass: { readonly commandId: string; readonly touched: Array<RunId> } | undefined;
  const touchedBy = (row: RunEventRow) => {
    if (row.command_id === null || !row.command_id.startsWith(RECONCILE_COMMAND_PREFIX)) return;
    if (latestPass?.commandId !== row.command_id)
      latestPass = { commandId: row.command_id, touched: [] };
    latestPass.touched.push(row.run_id);
  };
  for (const row of rows) {
    if (row.event_type === "run.background-work-cancelled") {
      touchedBy(row);
      continue;
    }
    const status = row.status ?? "queued";
    const held = row.queue_held === 1;
    if (row.event_type === "run.created") {
      runs.set(row.run_id, { status, hold: held ? bornHold(heldQueuedRuns()) : null });
      continue;
    }
    const prior = runs.get(row.run_id);
    const hold = !held ? null : prior?.hold != null ? prior.hold : holdFromRow(row);
    runs.set(row.run_id, { status, hold });
    if (status === "cancelled" && prior?.status !== "cancelled") touchedBy(row);
  }
  const hold = strictestHold(heldQueuedRuns());
  if (hold === undefined) return { kind: "unknown", threadId };
  if (hold.kind !== "restart") return { kind: hold.kind, threadId };
  return {
    kind: "restart",
    threadId,
    reconcileCommandId: hold.reconcileCommandId,
    heldAt: hold.heldAt,
    touchedRunIds: latestPass?.touched ?? [],
  };
};

export const resumeCommandId = (input: {
  readonly threadId: ThreadId;
  readonly headRunId: RunId;
  readonly reconcileCommandId: CommandId;
}) =>
  CommandId.make(
    `command:fork-held-queue-resume:${input.threadId}:${input.headRunId}:${input.reconcileCommandId}`,
  );

/** `queue.resume` starts the queue with no failed run to re-hold it behind, so these refuse. */
const ENDED_WITHOUT_COMPLETING = new Set<OrchestrationV2Run["status"]>([
  "failed",
  "cancelled",
  "rolled_back",
]);

const IN_FLIGHT = new Set<OrchestrationV2Run["status"]>(["starting", "running"]);

type Outcome =
  | "resumed"
  | "setting-off"
  | "declined"
  | "stopped-since-hold"
  | "needs-user"
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

  const heldThreadIds = sql<{ readonly thread_id: ThreadId }>`
    SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
    WHERE status = 'queued' AND json_extract(payload_json, '$.queueHeld') IS 1
  `.pipe(Effect.map((rows) => rows.map((row) => row.thread_id)));

  // A reorder copies `queueHeld: true` forward under the user's command, so the walk reads
  // every flagged row in order and takes the flip, not the latest row. Reconcile rows come
  // too, because the latest pass's cancels say which run its continuation is for.
  const runEventRows = (threadId: ThreadId) => sql<RunEventRow>`
    SELECT
      sequence,
      event_type,
      command_id,
      occurred_at,
      COALESCE(json_extract(payload_json, '$.id'), json_extract(payload_json, '$.runId')) AS run_id,
      json_extract(payload_json, '$.status') AS status,
      json_extract(payload_json, '$.queueHeld') AS queue_held
    FROM orchestration_events
    WHERE aggregate_kind = 'thread'
      AND stream_id = ${threadId}
      AND application_event_version = 2
      AND (
        event_type = 'run.created'
        OR (event_type = 'run.updated' AND json_type(payload_json, '$.queueHeld') IS NOT NULL)
        OR (
          event_type IN ('run.updated', 'run.background-work-cancelled')
          AND command_id LIKE ${`${RECONCILE_COMMAND_PREFIX}%`}
        )
      )
    ORDER BY sequence ASC
  `;

  const classify = (threadId: ThreadId) =>
    runEventRows(threadId).pipe(Effect.map((rows) => classifyHeldThread(threadId, rows)));

  interface Continuation {
    readonly effectId: string;
    readonly sourceRunId: RunId;
  }

  // The continuation the thread still owes: one not yet settled, from any restart, or the one
  // the latest reconcile pass wrote for a run it touched. Both writers key it by that run.
  const pendingContinuation = (threadId: ThreadId) =>
    sql<{ readonly effect_id: string; readonly source_run_id: RunId }>`
      SELECT effect_id, json_extract(payload_json, '$.sourceRunId') AS source_run_id
      FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId}
        AND effect_type = 'provider-runtime.continue'
        AND status IN ('pending', 'running')
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows): Continuation | undefined =>
        rows[0] === undefined
          ? undefined
          : { effectId: rows[0].effect_id, sourceRunId: rows[0].source_run_id },
      ),
    );

  const continuationFor = (touchedRunIds: ReadonlyArray<RunId>) =>
    Effect.gen(function* () {
      for (const sourceRunId of touchedRunIds) {
        const effectId = `effect:restart-continuation:${sourceRunId}`;
        if (Option.isSome(yield* outbox.get(effectId))) return { effectId, sourceRunId };
      }
      return undefined;
    });

  const parkedForUser = (shell: OrchestrationV2ThreadShell, now: DateTime.Utc) =>
    shell.archivedAt !== null ||
    shell.settledAt !== null ||
    shell.settledOverride === "settled" ||
    (shell.snoozedUntil != null && DateTime.isGreaterThan(shell.snoozedUntil, now)) ||
    shell.pendingRuntimeRequest !== null;

  const secretPending = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["turnItems"], { turnItemTypes: ["secret_request"] })
      .pipe(
        Effect.map(({ turnItems }) =>
          turnItems.some(
            (item) => item.type === "secret_request" && item.secretStatus === "pending",
          ),
        ),
      );

  // A Stop never re-holds a held queue, so the one trace of a Stop after the hold is an
  // interrupt item on whichever run it stopped.
  const stoppedSince = (threadId: ThreadId, heldAt: DateTime.Utc) =>
    projections
      .getThreadRecords(threadId, ["turnItems"], { turnItemTypes: ["run_interrupt_request"] })
      .pipe(
        Effect.map(({ turnItems }) =>
          turnItems.some(
            (item) =>
              item.completedAt !== null &&
              DateTime.isGreaterThanOrEqualTo(item.completedAt, heldAt),
          ),
        ),
      );

  interface Release {
    readonly held: RestartHeld;
    readonly continuation: Continuation | undefined;
  }

  const admit = (held: RestartHeld): Effect.Effect<Outcome | Release> =>
    Effect.gen(function* () {
      const shell = yield* projections.getThreadShell(held.threadId);
      if (shell === null || shell.deletedAt !== null) return "needs-user" as const;
      const current = yield* settings.getSettings;
      if (
        !resolveProjectSettings(current, shell.projectId).settings.continueThreadsAfterServerUpdate
      )
        return "setting-off" as const;
      const continuation =
        (yield* pendingContinuation(held.threadId)) ?? (yield* continuationFor(held.touchedRunIds));
      if (continuation === undefined && held.touchedRunIds.length > 0) return "declined" as const;
      return { held, continuation };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("held queue not admitted", { threadId: held.threadId, cause }).pipe(
          Effect.as("refused" as const),
        ),
      ),
    );

  const resume = ({ held, continuation }: Release) =>
    Effect.gen(function* () {
      const { threadId } = held;
      const shell = yield* projections.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) return "needs-user";
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      const continued =
        continuation === undefined
          ? undefined
          : runs.find((run) => run.restartContinuationOfRunId === continuation.sourceRunId);
      if (continuation !== undefined) {
        if (continued === undefined || ENDED_WITHOUT_COMPLETING.has(continued.status))
          return "declined";
        if (continued.status === "interrupted") return "stopped-since-hold";
      }
      const followsContinuation = continued !== undefined && IN_FLIGHT.has(continued.status);
      if (
        !followsContinuation &&
        (parkedForUser(shell, yield* DateTime.now) || (yield* secretPending(threadId)))
      )
        return "needs-user";
      if (yield* stoppedSince(threadId, held.heldAt)) return "stopped-since-hold";
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

  const release = (pending: Release) =>
    Effect.gen(function* () {
      const { threadId } = pending.held;
      const from = yield* Clock.currentTimeMillis;
      if (pending.continuation !== undefined)
        yield* outbox.awaitSettled(pending.continuation.effectId);
      const waitedMs = (yield* Clock.currentTimeMillis) - from;
      const outcome = yield* resume(pending);
      yield* Effect.logInfo("held queue release", { threadId, outcome, waitedMs });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("held queue not resumed", { threadId: pending.held.threadId, cause }),
      ),
    );

  const scan = Effect.gen(function* () {
    const from = yield* Clock.currentTimeMillis;
    yield* Effect.logInfo("held queue scan started");
    const threadIds = yield* heldThreadIds;
    const classes = yield* Effect.forEach(threadIds, classify);
    yield* Effect.logInfo("held queues classified", {
      threads: threadIds.length,
      ...tally(classes.map((held) => held.kind)),
      ms: (yield* Clock.currentTimeMillis) - from,
    });
    const admitted = yield* Effect.forEach(
      classes.flatMap((held) => (held.kind === "restart" ? [held] : [])),
      admit,
    );
    const releases = admitted.flatMap((entry) => (typeof entry === "string" ? [] : [entry]));
    yield* Effect.logInfo("held queue scan ended", {
      threads: threadIds.length,
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
