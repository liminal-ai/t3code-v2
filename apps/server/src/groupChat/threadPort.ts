import {
  CommandId,
  type EnvironmentId,
  type GroupChatPendingInput,
  isProviderNativeSubagentThread,
  type MessageId,
  type OrchestrationV2Run,
  type ProjectId,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export const GROUP_CHAT_MESSAGE_PREFIX = "message:group-chat:";
const IDLE_PING_PREFIX = "server:thread-workflow-idle:";

export const dispatchIds = (input: {
  readonly groupMessageId: string;
  readonly memberId: string;
  readonly attempt: number;
}) => ({
  commandId: CommandId.make(
    `group-chat:send:${input.groupMessageId}:${input.memberId}:${input.attempt}`,
  ),
  messageId:
    `${GROUP_CHAT_MESSAGE_PREFIX}${input.groupMessageId}:${input.memberId}:${input.attempt}` as MessageId,
});

export interface PortThread {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly archived: boolean;
  readonly readOnly: boolean;
}

export interface PortRun {
  readonly id: RunId;
  readonly status: OrchestrationV2Run["status"];
  readonly started: boolean;
  readonly queueHeld: boolean;
  readonly messageId: MessageId;
}

export type PortBlockingKind = "own_run" | "group_envelope" | "idle_ping" | "continuation";

export interface PortBlocking {
  readonly kind: PortBlockingKind;
  readonly runId: RunId;
  readonly pending: GroupChatPendingInput | null;
}

export class PortThreadNotFound extends Schema.TaggedError<PortThreadNotFound>()(
  "GroupChatPortThreadNotFound",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} no longer exists.`;
  }
}

export class PortRejected extends Schema.TaggedError<PortRejected>()("GroupChatPortRejected", {
  threadId: ThreadId,
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export class PortUnknown extends Schema.TaggedError<PortUnknown>()("GroupChatPortUnknown", {
  threadId: ThreadId,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The send's outcome is unknown.";
  }
}

export class PortRefused extends Schema.TaggedError<PortRefused>()("GroupChatPortRefused", {
  threadId: ThreadId,
  action: Schema.Literals(["settle", "unsettle", "answer"]),
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export class PortReadError extends Schema.TaggedError<PortReadError>()("GroupChatPortReadError", {
  threadId: ThreadId,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not read thread ${this.threadId}.`;
  }
}

export class GroupChatThreadPort extends Context.Service<
  GroupChatThreadPort,
  {
    readonly environmentId: Effect.Effect<EnvironmentId>;
    readonly thread: (threadId: ThreadId) => Effect.Effect<PortThread | null, PortReadError>;
    readonly send: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly text: string;
      readonly commandId: CommandId;
      readonly messageId: MessageId;
    }) => Effect.Effect<
      { readonly runId: RunId; readonly delivery: "started" | "queued" },
      PortRejected | PortUnknown
    >;
    readonly findMessage: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
    }) => Effect.Effect<
      { readonly runId: RunId | null; readonly text: string } | null,
      PortReadError
    >;
    readonly run: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<PortRun | null, PortReadError>;
    readonly awaitRun: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly runId: RunId;
    }) => Effect.Effect<PortRun | null, PortThreadNotFound | PortReadError>;
    readonly readReply: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<
      { readonly text: string; readonly streaming: boolean } | null,
      PortReadError
    >;
    readonly blockingRun: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<PortBlocking | null, PortReadError>;
    readonly pendingRequest: (
      threadId: ThreadId,
    ) => Effect.Effect<GroupChatPendingInput | null, PortReadError>;
    /** Run and request changes; with `messages`, also every change to a message of the thread. */
    readonly changes: (
      threadId: ThreadId,
      options?: { readonly messages?: boolean },
    ) => Effect.Effect<Stream.Stream<void, PortReadError>, PortReadError, Scope.Scope>;
    readonly cancelQueued: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<"cancelled" | "started", PortReadError>;
    readonly settle: (threadId: ThreadId) => Effect.Effect<void, PortRefused | PortReadError>;
    readonly unsettle: (threadId: ThreadId) => Effect.Effect<void, PortRefused | PortReadError>;
    readonly respond: (input: {
      readonly threadId: ThreadId;
      readonly requestId: RuntimeRequestId;
      readonly answers: ProviderUserInputAnswers;
    }) => Effect.Effect<void, PortRefused | PortReadError>;
  }
>()("t3/groupChat/threadPort/GroupChatThreadPort") {}

const WAIT_SLICE_MS = 10 * 60_000;

export const pendingInputOf = (
  records: {
    readonly runtimeRequests: ReadonlyArray<{
      readonly id: RuntimeRequestId;
      readonly kind: string;
      readonly status: string;
      readonly nodeId: string;
    }>;
    readonly turnItems: ReadonlyArray<
      | {
          readonly type: "user_input_request";
          readonly requestId: RuntimeRequestId;
          readonly questions: ReadonlyArray<{
            readonly id: string;
            readonly header: string;
            readonly question: string;
            readonly options: ReadonlyArray<{
              readonly label: string;
              readonly description: string;
              readonly value?: string | undefined;
            }>;
            readonly multiSelect?: boolean | undefined;
          }>;
        }
      | { readonly type: string }
    >;
  },
  runNodeIds: ReadonlySet<string> | null,
): GroupChatPendingInput | null => {
  const pending = records.runtimeRequests.filter(
    (request) =>
      request.status === "pending" && (runNodeIds === null || runNodeIds.has(request.nodeId)),
  );
  const question = pending.find((request) => request.kind === "user_input");
  if (question !== undefined) {
    const item = records.turnItems.find(
      (candidate) =>
        candidate.type === "user_input_request" &&
        "requestId" in candidate &&
        candidate.requestId === question.id,
    );
    const questions =
      item !== undefined && "questions" in item
        ? item.questions.map((q) => ({
            id: q.id,
            header: q.header,
            question: q.question,
            options: q.options.map((o) => ({
              label: o.label,
              description: o.description,
              value: o.value ?? null,
            })),
            multiSelect: q.multiSelect ?? false,
          }))
        : [];
    return { _tag: "question", requestId: question.id, questions };
  }
  return pending.length > 0 ? { _tag: "approval" } : null;
};

const followContinuations = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
): OrchestrationV2Run => {
  let current = run;
  for (let hops = 0; hops < runs.length; hops++) {
    const next = runs.find((candidate) => candidate.restartContinuationOfRunId === current.id);
    if (next === undefined) break;
    current = next;
  }
  return current;
};

const toPortRun = (run: OrchestrationV2Run): PortRun => ({
  id: run.id,
  status: run.status,
  started: run.startedAt !== null,
  queueHeld: run.queueHeld === true,
  messageId: run.userMessageId,
});

const isRejected = Schema.is(PortRejected);
const isThreadNotFound = Schema.is(PortThreadNotFound);
const isRefusal = Schema.is(
  Schema.Union([
    Orchestrator.OrchestratorDispatchError,
    Orchestrator.OrchestratorCommandRejectedError,
    ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
  ]),
);

const refusalText = (error: { readonly cause?: unknown; readonly message: string }) =>
  typeof error.cause === "string" ? error.cause : error.message;

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;

  const readError = (threadId: ThreadId) => (cause: unknown) =>
    new PortReadError({ threadId, cause });

  // The orchestrator replays the receipt of a command id it has seen, so two commands in the
  // same millisecond must differ by what they act on, or the second would report the first's
  // outcome.
  const commandId = (operation: string, threadId: ThreadId, target = "") =>
    Effect.map(DateTime.now, (now) =>
      CommandId.make(
        `group-chat:${operation}:${threadId}:${target}:${DateTime.toEpochMillis(now)}`,
      ),
    );

  const records = <K extends Parameters<typeof threads.getThreadRecords>[1][number]>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: Parameters<typeof threads.getThreadRecords>[2],
  ) =>
    threads.getThreadRecords(threadId, fields, filter).pipe(Effect.mapError(readError(threadId)));

  const thread: GroupChatThreadPort["Service"]["thread"] = (threadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(readError(threadId)),
      Effect.flatMap((shell) =>
        shell === null
          ? Effect.succeed(null)
          : records(threadId, []).pipe(
              Effect.map(({ thread }) =>
                thread.deletedAt !== null
                  ? null
                  : {
                      projectId: thread.projectId,
                      title: thread.title,
                      archived: thread.archivedAt !== null,
                      readOnly: isProviderNativeSubagentThread(thread),
                    },
              ),
            ),
      ),
    );

  const send: GroupChatThreadPort["Service"]["send"] = (input) =>
    threads
      .sendToThread({
        projectId: input.projectId,
        commandId: input.commandId,
        threadId: input.threadId,
        messageId: input.messageId,
        text: input.text,
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.map((result) => ({
          runId: result.run.id,
          delivery: result.delivery === "queued" ? ("queued" as const) : ("started" as const),
        })),
        Effect.catchTags({
          ThreadManagementThreadArchivedError: (error) =>
            new PortRejected({ threadId: input.threadId, reason: error.message }),
          ThreadManagementProviderInstanceDisabledError: (error) =>
            new PortRejected({ threadId: input.threadId, reason: error.message }),
          OrchestratorSubagentThreadReadOnlyError: (error) =>
            new PortRejected({ threadId: input.threadId, reason: error.message }),
          OrchestratorCommandPreviouslyRejectedError: (error) =>
            new PortRejected({ threadId: input.threadId, reason: error.message }),
        }),
        Effect.mapError((error) =>
          isRejected(error) ? error : new PortUnknown({ threadId: input.threadId, cause: error }),
        ),
      );

  const findMessage: GroupChatThreadPort["Service"]["findMessage"] = (input) =>
    records(input.threadId, ["messages"], { messageIds: [input.messageId] }).pipe(
      Effect.map(({ messages }) => {
        const message = messages.find((candidate) => candidate.id === input.messageId);
        return message === undefined ? null : { runId: message.runId, text: message.text };
      }),
    );

  const run: GroupChatThreadPort["Service"]["run"] = (input) =>
    records(input.threadId, ["runs"]).pipe(
      Effect.map(({ runs }) => {
        const found = runs.find((candidate) => candidate.id === input.runId);
        return found === undefined ? null : toPortRun(followContinuations(runs, found));
      }),
    );

  const awaitRun: GroupChatThreadPort["Service"]["awaitRun"] = (input) => {
    const slice: Effect.Effect<
      ThreadManagementService.ThreadManagementWaitResult | null,
      PortThreadNotFound | PortReadError
    > = threads
      .waitForThread({
        projectId: input.projectId,
        threadId: input.threadId,
        runId: input.runId,
        timeoutMs: WAIT_SLICE_MS,
      })
      .pipe(
        Effect.catchTags({
          ThreadManagementThreadNotFoundError: () =>
            Effect.fail(new PortThreadNotFound({ threadId: input.threadId })),
          ThreadManagementRunNotFoundError: () => Effect.succeed(null),
        }),
        Effect.mapError((error) =>
          isThreadNotFound(error)
            ? error
            : new PortReadError({ threadId: input.threadId, cause: error }),
        ),
      );
    const loop: Effect.Effect<PortRun | null, PortThreadNotFound | PortReadError> = Effect.flatMap(
      slice,
      (waited) => {
        if (waited === null) return Effect.succeed(null);
        if (waited.timedOut) return loop;
        return Effect.succeed(waited.run === null ? null : toPortRun(waited.run));
      },
    );
    return loop;
  };

  const readReply: GroupChatThreadPort["Service"]["readReply"] = (input) =>
    records(input.threadId, ["messages"], {
      messageRoles: ["assistant"],
      messageRunIds: [input.runId],
    }).pipe(
      Effect.map(({ messages }) => {
        const last = messages
          .filter((message) => message.runId === input.runId && message.role === "assistant")
          .toSorted(
            (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
          )
          .at(-1);
        return last === undefined ? null : { text: last.text, streaming: last.streaming };
      }),
    );

  const isActive = (candidate: OrchestrationV2Run) =>
    candidate.status === "preparing" ||
    candidate.status === "starting" ||
    candidate.status === "running" ||
    candidate.status === "waiting";

  const blockingRun: GroupChatThreadPort["Service"]["blockingRun"] = Effect.fn(
    "groupChat.threadPort.blockingRun",
  )(function* (input) {
    const projection = yield* records(
      input.threadId,
      ["runs", "nodes", "runtimeRequests", "turnItems"],
      { turnItemTypes: ["user_input_request"] },
    );
    const active = projection.runs
      .toSorted((a, b) => b.ordinal - a.ordinal)
      .find((candidate) => candidate.id !== input.runId && isActive(candidate));
    if (active === undefined) return null;
    const kind: PortBlockingKind = active.userMessageId.startsWith(GROUP_CHAT_MESSAGE_PREFIX)
      ? "group_envelope"
      : active.restartContinuationOfRunId !== undefined
        ? "continuation"
        : active.userMessageId.startsWith(IDLE_PING_PREFIX)
          ? "idle_ping"
          : "own_run";
    const nodeIds = new Set(
      projection.nodes.filter((node) => node.runId === active.id).map((node) => node.id),
    );
    return { kind, runId: active.id, pending: pendingInputOf(projection, nodeIds) };
  });

  const pendingRequest: GroupChatThreadPort["Service"]["pendingRequest"] = (threadId) =>
    records(threadId, ["runtimeRequests", "turnItems"], {
      turnItemTypes: ["user_input_request"],
    }).pipe(Effect.map((projection) => pendingInputOf(projection, null)));

  const changes: GroupChatThreadPort["Service"]["changes"] = (threadId, options) =>
    threads.getThreadEventSequence(threadId).pipe(
      Effect.mapError(readError(threadId)),
      Effect.map((afterSequence) => {
        const events = (eventType: "run.updated" | "runtime-request.updated" | "message.updated") =>
          threads.streamStoredEventsFrom({ threadId, afterSequence, eventType });
        return Stream.merge(
          Stream.merge(events("run.updated"), events("runtime-request.updated")),
          options?.messages === true ? events("message.updated") : Stream.empty,
        ).pipe(
          Stream.mapError(readError(threadId)),
          Stream.map(() => undefined),
        );
      }),
    );

  const dispatch = <A, E>(
    threadId: ThreadId,
    action: PortRefused["action"],
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, PortRefused | PortReadError> =>
    effect.pipe(
      Effect.mapError((error) =>
        isRefusal(error)
          ? new PortRefused({ threadId, action, reason: refusalText(error) })
          : new PortReadError({ threadId, cause: error }),
      ),
    );

  const cancelQueued: GroupChatThreadPort["Service"]["cancelQueued"] = Effect.fn(
    "groupChat.threadPort.cancelQueued",
  )(function* (input) {
    const id = yield* commandId("cancel", input.threadId, input.runId);
    return yield* threads
      .dispatch({
        type: "queued-run.cancel",
        commandId: id,
        threadId: input.threadId,
        runId: input.runId,
      })
      .pipe(
        Effect.as("cancelled" as const),
        Effect.catchTags({
          OrchestratorDispatchError: () => Effect.succeed("started" as const),
        }),
        Effect.mapError(readError(input.threadId)),
      );
  });

  const settle: GroupChatThreadPort["Service"]["settle"] = Effect.fn("groupChat.threadPort.settle")(
    function* (threadId) {
      const id = yield* commandId("settle", threadId);
      yield* dispatch(
        threadId,
        "settle",
        threads.settleThread({ threadId, commandId: id, byOwnAgent: false }),
      );
    },
  );

  const unsettle: GroupChatThreadPort["Service"]["unsettle"] = Effect.fn(
    "groupChat.threadPort.unsettle",
  )(function* (threadId) {
    const id = yield* commandId("unsettle", threadId);
    yield* dispatch(
      threadId,
      "unsettle",
      threads.dispatch({ type: "thread.unsettle", commandId: id, threadId, reason: "user" }),
    );
  });

  const respond: GroupChatThreadPort["Service"]["respond"] = Effect.fn(
    "groupChat.threadPort.respond",
  )(function* (input) {
    const id = yield* commandId("respond", input.threadId, input.requestId);
    yield* dispatch(
      input.threadId,
      "answer",
      threads.dispatch({
        type: "runtime-request.respond",
        commandId: id,
        threadId: input.threadId,
        requestId: input.requestId,
        answers: input.answers,
      }),
    );
  });

  return GroupChatThreadPort.of({
    environmentId: identity.getEnvironmentId,
    thread,
    send,
    findMessage,
    run,
    awaitRun,
    readReply,
    blockingRun,
    pendingRequest,
    changes,
    cancelQueued,
    settle,
    unsettle,
    respond,
  });
});

export const layer = Layer.effect(GroupChatThreadPort, make);
