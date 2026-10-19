/**
 * A fake thread port for engine and service tests. It models what matters for delivery: sends keyed
 * by command id that replay a recorded run, queued runs that start only when the thread is free, a
 * held queue, pending questions, restart continuations, and faults on the send path.
 */
import {
  type CommandId,
  EnvironmentId,
  type GroupChatPendingInput,
  type MessageId,
  type OrchestrationV2Run,
  ProjectId,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
  RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  GroupChatThreadPort,
  type PortBlocking,
  PortRefused,
  PortRejected,
  PortUnknown,
  type PortRun,
} from "./threadPort.ts";

export type SendFault =
  /** T3 refuses for good: an archived thread, a read-only subagent, a rejected receipt. */
  | { readonly type: "reject"; readonly reason: string }
  /** The dispatch commits, but the caller never learns it. */
  | { readonly type: "commit-silently" }
  /** The dispatch never commits and the caller gets an error. */
  | { readonly type: "lose" };

export interface FakeRun {
  readonly id: RunId;
  status: OrchestrationV2Run["status"];
  started: boolean;
  queueHeld: boolean;
  readonly messageId: MessageId;
  text: string;
  reply: string | null;
  /** Set on a continuation run, to the run a restart cut. */
  readonly continuationOf: RunId | null;
  /** Whether group chat sent it, by its derived message id. */
  readonly own: boolean;
  readonly ended: Deferred.Deferred<void>;
}

export interface FakeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  title: string;
  archived: boolean;
  deleted: boolean;
  settled: boolean;
  /** A sentence that refuses settle and unsettle, as a workflow hook would. */
  settleRefusal: string | null;
  pending: GroupChatPendingInput | null;
  held: boolean;
  readonly faults: SendFault[];
  readonly runs: FakeRun[];
  readonly changes: PubSub.PubSub<void>;
  readonly sends: Array<{
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    readonly text: string;
  }>;
  readonly responses: Array<{
    readonly requestId: RuntimeRequestId;
    readonly answers: ProviderUserInputAnswers;
  }>;
}

export const FAKE_ENVIRONMENT_ID = EnvironmentId.make("env-fake");

const TERMINAL = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

export interface FakeThreads {
  readonly port: GroupChatThreadPort["Service"];
  readonly thread: (id: ThreadId) => Effect.Effect<FakeThread>;
  /** Starts a queued run now. */
  readonly start: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
  /** A turn the thread starts on its own: an operator message, or a workflow's idle ping. */
  readonly startOwnRun: (
    threadId: ThreadId,
    text?: string,
    options?: { readonly idlePing?: boolean },
  ) => Effect.Effect<FakeRun>;
  readonly complete: (
    threadId: ThreadId,
    runId: RunId,
    reply: string | null,
  ) => Effect.Effect<void>;
  /** The web Stop on a running reply. */
  readonly interrupt: (
    threadId: ThreadId,
    runId: RunId,
    reply?: string | null,
  ) => Effect.Effect<void>;
  readonly failRun: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
  /** The operator removes a queued message from the thread's queue in T3. */
  readonly removeQueued: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
  /** The operator edits a queued message in T3. The run keeps its id. */
  readonly editQueued: (threadId: ThreadId, runId: RunId, text: string) => Effect.Effect<void>;
  /** A server restart cuts the running run and continues it as a new one. */
  readonly restart: (threadId: ThreadId, runId: RunId) => Effect.Effect<FakeRun>;
  readonly hold: (threadId: ThreadId, held: boolean) => Effect.Effect<void>;
  readonly ask: (
    threadId: ThreadId,
    requestId: string,
    question: string,
    options?: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly askApproval: (threadId: ThreadId) => Effect.Effect<void>;
  readonly sends: (threadId: ThreadId) => Effect.Effect<FakeThread["sends"]>;
}

export const makeFakeThreads = Effect.sync(() => {
  const threads = new Map<ThreadId, FakeThread>();
  const receipts = new Map<CommandId, FakeRun>();
  let runCount = 0;

  const thread = (id: ThreadId): Effect.Effect<FakeThread> => {
    const existing = threads.get(id);
    if (existing !== undefined) return Effect.succeed(existing);
    return Effect.map(PubSub.unbounded<void>(), (changes) => {
      const created: FakeThread = {
        id,
        projectId: ProjectId.make("project-fake"),
        title: `${id} thread`,
        archived: false,
        deleted: false,
        settled: false,
        settleRefusal: null,
        pending: null,
        held: false,
        faults: [],
        runs: [],
        changes,
        sends: [],
        responses: [],
      };
      threads.set(id, created);
      return created;
    });
  };

  const signal = (t: FakeThread) => PubSub.publish(t.changes, undefined).pipe(Effect.asVoid);
  const activeOf = (t: FakeThread) =>
    t.runs.find((run) => !TERMINAL.has(run.status) && run.started);
  const runOf = (t: FakeThread, runId: RunId) =>
    t.runs.find((candidate) => candidate.id === runId)!;

  const newRun = (input: {
    readonly messageId: MessageId;
    readonly text: string;
    readonly started: boolean;
    readonly queueHeld: boolean;
    readonly continuationOf: RunId | null;
    readonly own: boolean;
  }) =>
    Effect.map(Deferred.make<void>(), (ended): FakeRun => ({
      id: RunId.make(`run-${++runCount}`),
      status: input.started ? "running" : "queued",
      started: input.started,
      queueHeld: input.queueHeld,
      messageId: input.messageId,
      text: input.text,
      reply: null,
      continuationOf: input.continuationOf,
      own: input.own,
      ended,
    }));

  const startRun = (t: FakeThread, run: FakeRun) => {
    run.status = "running";
    run.started = true;
    run.queueHeld = false;
    return signal(t);
  };

  const startNextQueued = (t: FakeThread) => {
    if (t.held || activeOf(t) !== undefined) return Effect.void;
    const next = t.runs.find((candidate) => candidate.status === "queued");
    return next === undefined ? Effect.void : startRun(t, next);
  };

  const end = (
    t: FakeThread,
    run: FakeRun,
    status: OrchestrationV2Run["status"],
    reply: string | null,
  ) =>
    Effect.gen(function* () {
      run.status = status;
      run.reply = reply;
      yield* Deferred.succeed(run.ended, undefined);
      yield* signal(t);
      yield* startNextQueued(t);
    });

  const commit = (t: FakeThread, commandId: CommandId, messageId: MessageId, text: string) =>
    Effect.gen(function* () {
      const seen = receipts.get(commandId);
      if (seen !== undefined) return seen;
      const run = yield* newRun({
        messageId,
        text,
        started: false,
        queueHeld: t.held,
        continuationOf: null,
        own: true,
      });
      receipts.set(commandId, run);
      t.runs.push(run);
      if (activeOf(t) === undefined && !t.held) yield* startRun(t, run);
      else yield* signal(t);
      return run;
    });

  const latest = (t: FakeThread, run: FakeRun): FakeRun => {
    let current = run;
    for (let hops = 0; hops < t.runs.length; hops++) {
      const next = t.runs.find((candidate) => candidate.continuationOf === current.id);
      if (next === undefined) break;
      current = next;
    }
    return current;
  };

  const view = (run: FakeRun): PortRun => ({
    id: run.id,
    status: run.status,
    started: run.started,
    queueHeld: run.queueHeld,
    messageId: run.messageId,
  });

  const port: GroupChatThreadPort["Service"] = {
    environmentId: Effect.succeed(FAKE_ENVIRONMENT_ID),
    thread: (threadId) =>
      Effect.map(thread(threadId), (t) =>
        t.deleted
          ? null
          : { projectId: t.projectId, title: t.title, archived: t.archived, subagent: false },
      ),
    send: (input) =>
      Effect.gen(function* () {
        const t = yield* thread(input.threadId);
        t.sends.push({ commandId: input.commandId, messageId: input.messageId, text: input.text });
        if (t.archived) {
          return yield* new PortRejected({
            threadId: t.id,
            reason: `Thread ${t.id} is archived and cannot receive messages.`,
          });
        }
        const fault = t.faults.shift();
        if (fault?.type === "reject") {
          return yield* new PortRejected({ threadId: t.id, reason: fault.reason });
        }
        if (fault?.type === "lose") {
          return yield* new PortUnknown({ threadId: t.id, cause: "lost" });
        }
        const run = yield* commit(t, input.commandId, input.messageId, input.text);
        if (fault?.type === "commit-silently") {
          return yield* new PortUnknown({ threadId: t.id, cause: "response lost" });
        }
        return {
          runId: run.id,
          delivery: run.started ? ("started" as const) : ("queued" as const),
        };
      }),
    findMessage: (input) =>
      Effect.map(thread(input.threadId), (t) => {
        const run = t.runs.find((candidate) => candidate.messageId === input.messageId);
        return run === undefined ? null : { runId: run.id, text: run.text };
      }),
    run: (input) =>
      Effect.map(thread(input.threadId), (t) => {
        const run = t.runs.find((candidate) => candidate.id === input.runId);
        return run === undefined ? null : view(latest(t, run));
      }),
    awaitRun: (input) =>
      Effect.gen(function* () {
        const t = yield* thread(input.threadId);
        let current = t.runs.find((candidate) => candidate.id === input.runId);
        if (current === undefined) return null;
        for (;;) {
          yield* Deferred.await(current.ended);
          const next = latest(t, current);
          if (next.id === current.id) return view(current);
          current = next;
        }
      }),
    readReply: (input) =>
      Effect.map(thread(input.threadId), (t) => {
        const run = t.runs.find((candidate) => candidate.id === input.runId);
        return run?.reply == null ? null : { text: run.reply };
      }),
    blockingRun: (input) =>
      Effect.map(thread(input.threadId), (t): PortBlocking | null => {
        const active = t.runs.find(
          (candidate) =>
            candidate.id !== input.runId && candidate.started && !TERMINAL.has(candidate.status),
        );
        if (active === undefined) return null;
        const kind = active.own
          ? "group_envelope"
          : active.continuationOf !== null
            ? "continuation"
            : active.messageId.startsWith("server:thread-workflow-idle:")
              ? "idle_ping"
              : "own_run";
        return { kind, runId: active.id, pending: t.pending };
      }),
    pendingRequest: (threadId) => Effect.map(thread(threadId), (t) => t.pending),
    changes: (threadId) => Effect.map(thread(threadId), (t) => Stream.fromPubSub(t.changes)),
    cancelQueued: (input) =>
      Effect.gen(function* () {
        const t = yield* thread(input.threadId);
        const run = t.runs.find((candidate) => candidate.id === input.runId);
        if (run === undefined || run.status !== "queued") return "started" as const;
        yield* end(t, run, "cancelled", null);
        return "cancelled" as const;
      }),
    settle: (threadId) =>
      Effect.gen(function* () {
        const t = yield* thread(threadId);
        if (t.settleRefusal !== null) {
          return yield* new PortRefused({ threadId, action: "settle", reason: t.settleRefusal });
        }
        t.settled = true;
      }),
    unsettle: (threadId) =>
      Effect.gen(function* () {
        const t = yield* thread(threadId);
        if (t.settleRefusal !== null) {
          return yield* new PortRefused({ threadId, action: "unsettle", reason: t.settleRefusal });
        }
        t.settled = false;
      }),
    respond: (input) =>
      Effect.gen(function* () {
        const t = yield* thread(input.threadId);
        if (t.pending?._tag !== "question" || t.pending.requestId !== input.requestId) {
          return yield* new PortRefused({
            threadId: t.id,
            action: "answer",
            reason: "The pending user-input request was not found.",
          });
        }
        t.responses.push({ requestId: input.requestId, answers: input.answers });
        t.pending = null;
        yield* signal(t);
      }),
  };

  const fake: FakeThreads = {
    port,
    thread,
    start: (threadId, runId) =>
      Effect.flatMap(thread(threadId), (t) => startRun(t, runOf(t, runId))),
    startOwnRun: (threadId, text = "own work", options = {}) =>
      Effect.gen(function* () {
        const t = yield* thread(threadId);
        const run = yield* newRun({
          messageId: (options.idlePing
            ? `server:thread-workflow-idle:${threadId}:w1:0:1`
            : `message:own-${runCount + 1}`) as MessageId,
          text,
          started: true,
          queueHeld: false,
          continuationOf: null,
          own: false,
        });
        t.runs.push(run);
        yield* signal(t);
        return run;
      }),
    complete: (threadId, runId, reply) =>
      Effect.flatMap(thread(threadId), (t) => end(t, runOf(t, runId), "completed", reply)),
    interrupt: (threadId, runId, reply = null) =>
      Effect.flatMap(thread(threadId), (t) => end(t, runOf(t, runId), "interrupted", reply)),
    failRun: (threadId, runId) =>
      Effect.flatMap(thread(threadId), (t) => end(t, runOf(t, runId), "failed", null)),
    removeQueued: (threadId, runId) =>
      Effect.flatMap(thread(threadId), (t) => end(t, runOf(t, runId), "cancelled", null)),
    editQueued: (threadId, runId, text) =>
      Effect.flatMap(thread(threadId), (t) => {
        runOf(t, runId).text = text;
        return signal(t);
      }),
    restart: (threadId, runId) =>
      Effect.gen(function* () {
        const t = yield* thread(threadId);
        const cut = runOf(t, runId);
        cut.status = "cancelled";
        yield* Deferred.succeed(cut.ended, undefined);
        const continuation = yield* newRun({
          messageId: cut.messageId,
          text: cut.text,
          started: true,
          queueHeld: false,
          continuationOf: cut.id,
          own: cut.own,
        });
        t.runs.push(continuation);
        yield* signal(t);
        return continuation;
      }),
    hold: (threadId, held) =>
      Effect.gen(function* () {
        const t = yield* thread(threadId);
        t.held = held;
        for (const run of t.runs) if (run.status === "queued") run.queueHeld = held;
        yield* signal(t);
        yield* startNextQueued(t);
      }),
    ask: (threadId, requestId, question, options = []) =>
      Effect.gen(function* () {
        const t = yield* thread(threadId);
        t.pending = {
          _tag: "question",
          requestId: requestId as RuntimeRequestId,
          questions: [
            {
              id: question,
              header: "Question",
              question,
              options: options.map((label) => ({ label, description: null })),
              multiSelect: false,
            },
          ],
        };
        yield* signal(t);
      }),
    askApproval: (threadId) =>
      Effect.gen(function* () {
        const t = yield* thread(threadId);
        t.pending = { _tag: "approval" };
        yield* signal(t);
      }),
    sends: (threadId) => Effect.map(thread(threadId), (t) => t.sends),
  };
  return fake;
});

/** A port whose every call hangs, to prove the module builds without waiting on T3. */
export const neverPort: GroupChatThreadPort["Service"] = {
  environmentId: Effect.never,
  thread: () => Effect.never,
  send: () => Effect.never,
  findMessage: () => Effect.never,
  run: () => Effect.never,
  awaitRun: () => Effect.never,
  readReply: () => Effect.never,
  blockingRun: () => Effect.never,
  pendingRequest: () => Effect.never,
  changes: () => Effect.never,
  cancelQueued: () => Effect.never,
  settle: () => Effect.never,
  unsettle: () => Effect.never,
  respond: () => Effect.never,
};

export const layerNeverPort = Layer.succeed(GroupChatThreadPort, neverPort);

export const layerFakePort = (fake: FakeThreads) => Layer.succeed(GroupChatThreadPort, fake.port);
