/**
 * Wakes the parent when an app-owned delegated child raises an approval, and answers any approval
 * or question on a delegated child still pending `REQUEST_DEADLINE` after its stored `createdAt`
 * with a note that no human is available. A sweep re-arms deadlines after a restart.
 */
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  MessageId,
  ProviderRequestKind,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type RunId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import { reportLabel } from "@t3tools/provider-core/server/notification";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";

const REQUEST_DEADLINE = Duration.minutes(10);
const SWEEP_INTERVAL = "1 minute";
const PROMPT_MAX = 400;
const REASON_MAX = 600;

export class DelegatedRequestTimeout extends Context.Service<
  DelegatedRequestTimeout,
  {
    /** Follows domain events and sweeps on start and every minute, unless switched off. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Arms a deadline for every pending request on a delegated thread that has none. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/fork/DelegatedRequestTimeout") {}

/**
 * Who delegated the thread a request waits on. Only these threads get a deadline: a top-level
 * thread, a fork and a provider-native subagent have a human or a provider behind them.
 */
type Delegation =
  | {
      readonly kind: "local";
      readonly task: OrchestrationV2Subagent;
      readonly parentRuns: ReadonlyArray<OrchestrationV2Run>;
      readonly parentOpen: boolean;
    }
  /** Launched here by `delegate_task` in a linked environment; its parent is on that machine. */
  | { readonly kind: "linked" };

type TimeoutAnswer =
  | { readonly decision: ProviderApprovalDecision; readonly feedback?: string }
  | { readonly answers: Record<string, string> };

const isApproval = Schema.is(ProviderRequestKind);

const answerable = (request: OrchestrationV2RuntimeRequest) =>
  request.status === "pending" &&
  request.responseCapability.type !== "not_resumable" &&
  (request.kind === "user_input" || isApproval(request.kind));

const deadlineOf = (request: OrchestrationV2RuntimeRequest) =>
  DateTime.addDuration(request.createdAt, REQUEST_DEADLINE);

const clip = (text: string | undefined, max: number) => {
  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const minutes = Duration.toMinutes(REQUEST_DEADLINE);
const WORK_AROUND =
  "Continue without it: work around it, or stop and say in your final message what you needed and why.";

export const approvalNote = (reason: string | undefined) => {
  const quoted = clip(reason, REASON_MAX);
  return [
    `No human is available to answer this permission prompt, so T3 declined it after waiting ${minutes} minutes.`,
    ...(quoted === undefined ? [] : [`The reason it asked: "${quoted}"`]),
    WORK_AROUND,
  ].join(" ");
};

export const QUESTION_NOTE = `No human is available to answer this question, so T3 answered it after waiting ${minutes} minutes. ${WORK_AROUND}`;

/** What the provider gets at the deadline; `undefined` when the request has nothing to send. */
const timeoutAnswer = (
  request: OrchestrationV2RuntimeRequest,
  item: OrchestrationV2TurnItem | undefined,
): TimeoutAnswer | undefined => {
  if (request.kind === "user_input") {
    // The respond command takes the note only as an answer to each question. Its `cancel`
    // delivers no text, and a live question cannot be dismissed.
    const questions = item?.type === "user_input_request" ? item.questions : [];
    if (questions.length === 0) return undefined;
    return { answers: Object.fromEntries(questions.map(({ id }) => [id, QUESTION_NOTE])) };
  }
  // `decline` lets the turn go on, where `cancel` can stop it. Only a live approval that says it
  // supports feedback takes text; Codex's carries its own fixed refusal.
  return request.responseCapability.type === "live" && request.responseCapability.supportsFeedback
    ? {
        decision: "decline",
        feedback: approvalNote(item?.type === "approval_request" ? item.reason : undefined),
      }
    : { decision: "decline" };
};

/** A capability change, which only a restart makes, is a new attempt; a rejected receipt sticks. */
const timeoutCommandId = (request: OrchestrationV2RuntimeRequest) =>
  CommandId.make(
    `server:fork-delegated-request-timeout:${request.id}:${request.responseCapability.type}`,
  );

const wakeKey = (parentThreadId: ThreadId, requestId: RuntimeRequestId) =>
  `${parentThreadId}:${requestId}`;

export const approvalWakeMessageId = (parentThreadId: ThreadId, requestId: RuntimeRequestId) =>
  MessageId.make(`message:fork-delegated-approval:${wakeKey(parentThreadId, requestId)}`);

const KIND_WORDS: Record<ProviderRequestKind, string> = {
  command: "a command",
  "file-read": "a file read",
  "file-change": "a file change",
  "mcp-elicitation": "an MCP request",
  permission: "a permission",
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const off = yield* Config.String("T3CODE_DELEGATED_REQUEST_TIMEOUT").pipe(
    Config.option,
    Effect.map(Option.exists((value) => value.trim().toLowerCase() === "off")),
    Effect.orElseSucceed(() => false),
  );
  const timers = yield* FiberMap.make<RuntimeRequestId>();

  const pendingOnDelegatedThreads = sql<{
    readonly thread_id: ThreadId;
    readonly runtime_request_id: RuntimeRequestId;
  }>`
    SELECT request.thread_id, request.runtime_request_id
    FROM orchestration_v2_projection_runtime_requests request
    JOIN orchestration_v2_projection_threads thread ON thread.thread_id = request.thread_id
    WHERE request.status = 'pending'
      AND thread.deleted_at IS NULL
      AND (json_extract(thread.payload_json, '$.lineage.parentThreadId') IS NOT NULL
        OR json_extract(thread.payload_json, '$.delegatedFrom') IS NOT NULL)
  `.pipe(NodeSqliteClient.readOnly);

  // Upstream DelegatedTaskQuestionReactor.ts finds a question's task the same way: a follow-up
  // run on the child is its own task.
  const delegationOf = Effect.fnUntraced(function* (threadId: ThreadId, runId: RunId | null) {
    const child = yield* projections.getThread(threadId);
    if (child.deletedAt !== null) return undefined;
    const parentThreadId = child.lineage.parentThreadId;
    if (parentThreadId === null) {
      return child.delegatedFrom === undefined ? undefined : ({ kind: "linked" } as const);
    }
    const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents", "runs"]);
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    const run =
      runs.find((candidate) => candidate.id === runId) ??
      runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    const taskId =
      run?.delegatedTaskId ??
      (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined);
    const task = parent.subagents.find(
      (candidate) => candidate.origin === "app_owned" && candidate.id === taskId,
    );
    if (task === undefined) return undefined;
    return {
      kind: "local",
      task,
      parentRuns: parent.runs,
      parentOpen: parent.thread.archivedAt === null && parent.thread.deletedAt === null,
    } satisfies Delegation;
  });

  const expire = Effect.fnUntraced(
    function* (threadId: ThreadId, requestId: RuntimeRequestId) {
      const context = yield* projections.getRuntimeResponseContext(threadId, requestId);
      const request = context.request;
      if (request === undefined || !answerable(request)) return;
      const answer = timeoutAnswer(request, context.item);
      if (answer === undefined) {
        yield* Effect.logWarning("delegated request has no question to answer", {
          threadId,
          requestId,
        });
        return;
      }
      yield* engine.dispatch({
        type: "runtime-request.respond",
        commandId: timeoutCommandId(request),
        threadId,
        requestId,
        ...answer,
      });
      yield* Effect.logInfo("declined a delegated request nobody answered", {
        threadId,
        requestId,
        kind: request.kind,
      });
    },
    (effect, threadId, requestId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated request timeout not delivered", {
            threadId,
            requestId,
            cause,
          }),
        ),
      ),
  );

  const arm = (threadId: ThreadId, request: OrchestrationV2RuntimeRequest) =>
    FiberMap.run(
      timers,
      request.id,
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const remaining = DateTime.distance(now, deadlineOf(request));
        if (Duration.isGreaterThan(remaining, Duration.zero)) yield* Effect.sleep(remaining);
        yield* expire(threadId, request.id);
      }),
      { onlyIfMissing: true },
    ).pipe(Effect.asVoid);

  const wakeParent = Effect.fnUntraced(function* (
    task: OrchestrationV2Subagent,
    request: OrchestrationV2RuntimeRequest,
    item: Extract<OrchestrationV2TurnItem, { readonly type: "approval_request" }>,
  ) {
    if (task.childThreadId === null) return;
    const key = wakeKey(task.threadId, request.id);
    const label = reportLabel(task.title?.trim() || task.prompt);
    const prompt = clip(item.prompt, PROMPT_MAX);
    const reason = clip(item.reason, REASON_MAX);
    const deadline = DateTime.formatIso(deadlineOf(request));
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:fork-delegated-approval:${key}`),
      threadId: task.threadId,
      messageId: approvalWakeMessageId(task.threadId, request.id),
      text: [
        `Delegated task ${task.id} is blocked on a permission prompt for ${KIND_WORDS[item.requestKind]} and cannot continue until it is answered.`,
        ...(prompt === undefined ? [] : [`The prompt: ${prompt}`]),
        ...(reason === undefined ? [] : [`The reason it asked: ${reason}`]),
        `An agent cannot approve or decline it, and t3_pending_request does not list it. The user can answer it in thread ${task.childThreadId}.`,
        `If nobody answers by ${deadline}, T3 declines it with a note that no human is available, and the task works around it or reports what it needed.`,
      ].join("\n"),
      notification: {
        source: { kind: "delegated_task", taskIds: [task.id], childThreadId: task.childThreadId },
        outcome: "updated",
        summary: `Delegated task${label === undefined ? "" : ` "${label}"`} needs approval`,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const maybeWake = Effect.fnUntraced(function* (threadId: ThreadId, requestId: RuntimeRequestId) {
    const context = yield* projections.getRuntimeResponseContext(threadId, requestId);
    const { request, item } = context;
    // Claude writes the request before its prompt item and Codex after, so whichever lands
    // second sends the one wake.
    if (
      request?.status !== "pending" ||
      request.responseCapability.type !== "live" ||
      item?.type !== "approval_request"
    ) {
      return;
    }
    const delegation = yield* delegationOf(threadId, context.node?.runId ?? null);
    if (delegation?.kind !== "local" || !delegation.parentOpen) return;
    const { task } = delegation;
    // As upstream's question reactor: a blocking delegate_task wait returns the approval itself.
    if (
      task.completionWake === "settled_only" &&
      delegation.parentRuns.some(
        (run) =>
          run.id === task.runId &&
          (run.status === "preparing" || run.status === "starting" || run.status === "running"),
      )
    ) {
      return;
    }
    yield* wakeParent(task, request, item);
  });

  const cancelWake = Effect.fnUntraced(function* (threadId: ThreadId, requestId: RuntimeRequestId) {
    const child = yield* projections.getThread(threadId);
    const parentThreadId = child.lineage.parentThreadId;
    if (parentThreadId === null) return;
    const messageId = approvalWakeMessageId(parentThreadId, requestId);
    const { runs } = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
    const queued = runs.find((run) => run.status === "queued" && run.userMessageId === messageId);
    if (queued === undefined) return;
    yield* engine.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make(
        `server:fork-delegated-approval-cancel:${wakeKey(parentThreadId, requestId)}`,
      ),
      threadId: parentThreadId,
      runId: queued.id,
    });
  });

  const handle: DelegatedRequestTimeout["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "turn-item.updated") {
        if (event.payload.type === "approval_request") {
          yield* maybeWake(event.threadId, event.payload.requestId);
        }
        return;
      }
      if (event.type !== "runtime-request.updated") return;
      const request = event.payload;
      if (request.kind !== "user_input" && !isApproval(request.kind)) return;
      if (request.status !== "pending") {
        if (isApproval(request.kind)) yield* cancelWake(event.threadId, request.id);
        return;
      }
      const delegation = yield* delegationOf(event.threadId, event.runId ?? null);
      if (delegation === undefined) return;
      yield* arm(event.threadId, request);
      if (delegation.kind === "local" && isApproval(request.kind)) {
        yield* maybeWake(event.threadId, request.id);
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated request event not handled", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const sweep: DelegatedRequestTimeout["Service"]["sweep"] = Effect.gen(function* () {
    for (const row of yield* pendingOnDelegatedThreads) {
      if (yield* FiberMap.has(timers, row.runtime_request_id)) continue;
      const context = yield* projections.getRuntimeResponseContext(
        row.thread_id,
        row.runtime_request_id,
      );
      if (context.request === undefined || !answerable(context.request)) continue;
      if ((yield* delegationOf(row.thread_id, context.node?.runId ?? null)) === undefined) continue;
      yield* arm(row.thread_id, context.request);
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("delegated request sweep failed", { cause })),
  );

  const start: DelegatedRequestTimeout["Service"]["start"] = () =>
    off
      ? Effect.logInfo(
          "delegated request timeout is turned off by T3CODE_DELEGATED_REQUEST_TIMEOUT=off",
        )
      : Effect.all(
          [
            forkParked(
              Stream.runForEach(engine.streamDomainEvents, handle).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("delegated request event stream failed", { cause }),
                ),
              ),
            ),
            forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid)),
          ],
          { discard: true },
        );

  return DelegatedRequestTimeout.of({ start, handle, sweep });
});

export const layer = Layer.effect(DelegatedRequestTimeout, make);

export const layerStart = Layer.effectDiscard(
  Effect.flatMap(DelegatedRequestTimeout, (service) => service.start()),
).pipe(Layer.provide(layer), Layer.provide(ProjectionStore.layer));
