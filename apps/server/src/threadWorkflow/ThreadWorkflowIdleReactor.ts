/**
 * Asks the agent, once per quiet day, whether an idle workflow should go on. A period is quiet
 * when nothing was recorded on the workflow and no run started on the thread for a day. The
 * command id carries when the quiet stretch began and how many days it has run, so a rescan or a
 * restart replays the receipt and sends nothing new, while a `continue` comment or a run (the
 * ping's own included) starts a fresh stretch with fresh ids.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadWorkflowInstanceSummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { printedCall, toSubscriptionView, type ThreadWorkflowState } from "./domain.ts";
import { ThreadWorkflowStore } from "./store.ts";

export const QUIET_PERIOD_MS = 24 * 60 * 60 * 1_000;
const SCAN_INTERVAL = "1 hour";

export class ThreadWorkflowIdleReactor extends Context.Service<
  ThreadWorkflowIdleReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass over every open instance; `start` runs it hourly. */
    readonly scan: Effect.Effect<void>;
  }
>()("t3/threadWorkflow/ThreadWorkflowIdleReactor") {}

interface QuietInstance {
  readonly instance: ThreadWorkflowInstanceSummary;
  readonly lastRecordAt: number;
}

const openInstance = (state: ThreadWorkflowState): QuietInstance | null => {
  if (state.corruption !== null || state.lastActivityAt === null) return null;
  const view = toSubscriptionView(state);
  const instance = view.instances.find((candidate) => candidate.id === view.activeInstanceId);
  return instance === undefined
    ? null
    : { instance, lastRecordAt: Date.parse(state.lastActivityAt) };
};

const millis = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

export const idleCommandId = (input: {
  readonly threadId: ThreadId;
  readonly instanceId: string;
  readonly quietSinceMs: number;
  readonly quietDays: number;
}) =>
  `server:thread-workflow-idle:${input.threadId}:${input.instanceId}:${input.quietSinceMs}:${input.quietDays}`;

const idleMessage = (input: {
  readonly threadId: ThreadId;
  readonly instance: ThreadWorkflowInstanceSummary;
  readonly quietDays: number;
}) => {
  const { threadId, instance, quietDays } = input;
  const step = instance.steps.find((candidate) => candidate.id === instance.currentStepId);
  return [
    `Workflow "${instance.title}" (${instance.id}) on thread ${threadId} has had no workflow activity for ${quietDays} ${quietDays === 1 ? "day" : "days"}, and no run started on the thread in that time.`,
    step === undefined
      ? "Every step is done, skipped or removed."
      : `Its current step is ${step.id}: ${step.title}.`,
    "Ask the user whether to continue this workflow.",
    "If they say continue, record who answered:",
    printedCall.commentContinue(instance.id),
    "If they say stop, abandon it:",
    printedCall.close(instance.id, "abandoned"),
    `Whole workflow: ${printedCall.get()}`,
  ].join("\n");
};

const make = Effect.gen(function* () {
  const store = yield* ThreadWorkflowStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;

  // Core's own picture of the thread: anything in flight or parked means not idle.
  const runStartedAtIfIdle = Effect.fn("threadWorkflow.idleReactor.runStartedAtIfIdle")(function* (
    shell: OrchestrationV2ThreadShell,
    nowMs: number,
  ) {
    if (
      shell.deletedAt !== null ||
      shell.archivedAt !== null ||
      shell.settledAt !== null ||
      shell.settledOverride === "settled" ||
      shell.lineage.parentThreadId !== null ||
      shell.activeRunId !== null ||
      shell.pendingRuntimeRequest !== null
    ) {
      return null;
    }
    const snoozedUntil = millis(shell.snoozedUntil);
    if (snoozedUntil !== null && snoozedUntil > nowMs) return null;
    const { runs } = yield* projections.getThreadRecords(shell.id, ["runs"]);
    if (runs.some((run) => run.status === "queued")) return null;
    return millis(shell.latestRunStartedAt) ?? 0;
  });

  const ping = Effect.fn("threadWorkflow.idleReactor.ping")(
    function* (threadId: ThreadId, candidate: QuietInstance, nowMs: number) {
      if (nowMs - candidate.lastRecordAt < QUIET_PERIOD_MS) return;
      const shell = yield* projections.getThreadShell(threadId);
      if (shell === null) return;
      const runStartedAt = yield* runStartedAtIfIdle(shell, nowMs);
      if (runStartedAt === null || nowMs - runStartedAt < QUIET_PERIOD_MS) return;
      // The instance may have moved while the projection was read.
      const fresh = openInstance(yield* store.state(threadId));
      if (
        fresh === null ||
        fresh.instance.id !== candidate.instance.id ||
        fresh.lastRecordAt !== candidate.lastRecordAt
      ) {
        return;
      }
      const quietSince = Math.max(fresh.lastRecordAt, runStartedAt);
      const quietDays = Math.floor((nowMs - quietSince) / QUIET_PERIOD_MS);
      const id = idleCommandId({
        threadId,
        instanceId: fresh.instance.id,
        quietSinceMs: quietSince,
        quietDays,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text: idleMessage({ threadId, instance: fresh.instance, quietDays }),
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: `Workflow "${fresh.instance.title}" has been idle for ${quietDays} ${quietDays === 1 ? "day" : "days"}`,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("thread workflow idle ping not sent", { threadId, cause }),
        ),
      ),
  );

  const scan = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    if (!current.threadWorkflowsEnabled) return;
    const nowMs = yield* Clock.currentTimeMillis;
    for (const state of yield* store.states) {
      const candidate = openInstance(state);
      if (candidate !== null) yield* ping(state.threadId, candidate, nowMs);
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("thread workflow idle scan failed", { cause })),
  );

  const start: ThreadWorkflowIdleReactor["Service"]["start"] = () =>
    forkParked(scan.pipe(Effect.repeat(Schedule.spaced(SCAN_INTERVAL)), Effect.asVoid));

  return ThreadWorkflowIdleReactor.of({ start, scan });
});

export const layer = Layer.effect(ThreadWorkflowIdleReactor, make);
