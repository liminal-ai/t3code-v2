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
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a throwaway agent on loopback is plain node:http.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import type * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import {
  ExternalDeliveryConfig,
  type ExternalDeliverySettings,
  type GroupChatEngine,
  RetryDelay,
} from "./engine.ts";
import * as GroupChatLayer from "./layer.ts";
import * as Reach from "./reach.ts";
import type { GroupChatStore, StoreError } from "./store.ts";
import {
  GroupChatThreadPort,
  type PortBlocking,
  PortReadError,
  PortRefused,
  PortRejected,
  PortUnknown,
  type PortRun,
} from "./threadPort.ts";

export type SendFault =
  | { readonly type: "reject"; readonly reason: string }
  /** Rejected only once the send passed the gate, as T3 answers after the operator's Stop. */
  | { readonly type: "reject-late"; readonly reason: string }
  | { readonly type: "commit-silently" }
  | { readonly type: "lose" };

export interface FakeRun {
  readonly id: RunId;
  status: OrchestrationV2Run["status"];
  started: boolean;
  queueHeld: boolean;
  readonly messageId: MessageId;
  text: string;
  reply: string | null;
  /** The last assistant message is still being written, as T3 reports right after the run ends. */
  streaming: boolean;
  readonly continuationOf: RunId | null;
  readonly own: boolean;
  readonly ended: Deferred.Deferred<void>;
}

export interface FakeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  title: string;
  archived: boolean;
  deleted: boolean;
  /** A provider-native subagent thread, which T3 refuses messages into. */
  readOnly: boolean;
  settled: boolean;
  settleRefusal: string | null;
  pending: GroupChatPendingInput | null;
  held: boolean;
  /** Holds a send before T3 takes it, so a test can act while the envelope is in flight but not yet committed. */
  commitGate: Deferred.Deferred<void> | null;
  sendReached: Deferred.Deferred<void> | null;
  sendGate: Deferred.Deferred<void> | null;
  readGate: Deferred.Deferred<void> | null;
  /** Resolved when a thread read reaches the gate, so a test knows the lane is parked there. */
  readReached: Deferred.Deferred<void> | null;
  /** Resolved when the port reads this thread's reply. */
  replyReached: Deferred.Deferred<void> | null;
  readonly faults: SendFault[];
  /** Reads of the thread's runs that fail before one succeeds, as a transient store fault would. */
  readFaults: number;
  threadReadFaults: number;
  /** Queued-run cancels that fail before one succeeds. */
  cancelFaults: number;
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

const FAKE_ENVIRONMENT_ID = EnvironmentId.make("env-fake");

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
  readonly start: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
  readonly startOwnRun: (
    threadId: ThreadId,
    text?: string,
    options?: { readonly idlePing?: boolean },
  ) => Effect.Effect<FakeRun>;
  readonly complete: (
    threadId: ThreadId,
    runId: RunId,
    reply: string | null,
    streaming?: boolean,
  ) => Effect.Effect<void>;
  /** Closes a reply that `complete` left streaming. */
  readonly settleReply: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
  readonly interrupt: (
    threadId: ThreadId,
    runId: RunId,
    reply?: string | null,
  ) => Effect.Effect<void>;
  readonly failRun: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
  readonly removeQueued: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
  readonly editQueued: (threadId: ThreadId, runId: RunId, text: string) => Effect.Effect<void>;
  readonly restart: (threadId: ThreadId, runId: RunId) => Effect.Effect<FakeRun>;
  readonly hold: (threadId: ThreadId, held: boolean) => Effect.Effect<void>;
  readonly ask: (
    threadId: ThreadId,
    requestId: string,
    question: string,
    options?: ReadonlyArray<string>,
    multiSelect?: boolean,
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
        readOnly: false,
        settled: false,
        settleRefusal: null,
        pending: null,
        held: false,
        commitGate: null,
        sendReached: null,
        sendGate: null,
        readGate: null,
        readReached: null,
        replyReached: null,
        faults: [],
        readFaults: 0,
        threadReadFaults: 0,
        cancelFaults: 0,
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
      streaming: false,
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

  const end = Effect.fn("groupChat.testkit.end")(function* (
    t: FakeThread,
    run: FakeRun,
    status: OrchestrationV2Run["status"],
    reply: string | null,
    streaming = false,
  ) {
    run.status = status;
    run.reply = reply;
    run.streaming = streaming;
    yield* Deferred.succeed(run.ended, undefined);
    yield* signal(t);
    yield* startNextQueued(t);
  });

  const commit = Effect.fn("groupChat.testkit.commit")(function* (
    t: FakeThread,
    commandId: CommandId,
    messageId: MessageId,
    text: string,
  ) {
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
    thread: Effect.fn("groupChat.testkit.thread")(function* (threadId) {
      const t = yield* thread(threadId);
      if (t.readReached !== null) yield* Deferred.succeed(t.readReached, undefined);
      if (t.readGate !== null) yield* Deferred.await(t.readGate);
      if (t.threadReadFaults > 0) {
        t.threadReadFaults -= 1;
        return yield* new PortReadError({ threadId: t.id, cause: "thread read fault" });
      }
      return t.deleted
        ? null
        : { projectId: t.projectId, title: t.title, archived: t.archived, readOnly: t.readOnly };
    }),
    send: Effect.fn("groupChat.testkit.send")(function* (input) {
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
      if (t.commitGate !== null) yield* Deferred.await(t.commitGate);
      const run = yield* commit(t, input.commandId, input.messageId, input.text);
      if (t.sendReached !== null) yield* Deferred.succeed(t.sendReached, undefined);
      if (t.sendGate !== null) yield* Deferred.await(t.sendGate);
      if (fault?.type === "commit-silently") {
        return yield* new PortUnknown({ threadId: t.id, cause: "response lost" });
      }
      if (fault?.type === "reject-late") {
        return yield* new PortRejected({ threadId: t.id, reason: fault.reason });
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
      Effect.flatMap(thread(input.threadId), (t) => {
        if (t.readFaults > 0) {
          t.readFaults -= 1;
          return Effect.fail(new PortReadError({ threadId: t.id, cause: "read fault" }));
        }
        const run = t.runs.find((candidate) => candidate.id === input.runId);
        return Effect.succeed(run === undefined ? null : view(latest(t, run)));
      }),
    awaitRun: Effect.fn("groupChat.testkit.awaitRun")(function* (input) {
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
    readReply: Effect.fn("groupChat.testkit.readReply")(function* (input) {
      const t = yield* thread(input.threadId);
      const run = t.runs.find((candidate) => candidate.id === input.runId);
      if (t.replyReached !== null) yield* Deferred.succeed(t.replyReached, undefined);
      return run?.reply == null ? null : { text: run.reply, streaming: run.streaming };
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
    changes: (threadId) =>
      Effect.flatMap(thread(threadId), (t) =>
        Effect.map(PubSub.subscribe(t.changes), Stream.fromSubscription),
      ),
    cancelQueued: Effect.fn("groupChat.testkit.cancelQueued")(function* (input) {
      const t = yield* thread(input.threadId);
      if (t.cancelFaults > 0) {
        t.cancelFaults -= 1;
        return yield* new PortReadError({ threadId: t.id, cause: "cancel fault" });
      }
      const run = t.runs.find((candidate) => candidate.id === input.runId);
      if (run === undefined || run.status !== "queued") return "started" as const;
      yield* end(t, run, "cancelled", null);
      return "cancelled" as const;
    }),
    settle: Effect.fn("groupChat.testkit.settle")(function* (threadId) {
      const t = yield* thread(threadId);
      if (t.settleRefusal !== null) {
        return yield* new PortRefused({ threadId, action: "settle", reason: t.settleRefusal });
      }
      t.settled = true;
    }),
    unsettle: Effect.fn("groupChat.testkit.unsettle")(function* (threadId) {
      const t = yield* thread(threadId);
      if (t.settleRefusal !== null) {
        return yield* new PortRefused({ threadId, action: "unsettle", reason: t.settleRefusal });
      }
      t.settled = false;
    }),
    respond: Effect.fn("groupChat.testkit.respond")(function* (input) {
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
    startOwnRun: Effect.fn("groupChat.testkit.startOwnRun")(function* (
      threadId,
      text = "own work",
      options = {},
    ) {
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
    complete: (threadId, runId, reply, streaming = false) =>
      Effect.flatMap(thread(threadId), (t) =>
        end(t, runOf(t, runId), "completed", reply, streaming),
      ),
    settleReply: (threadId, runId) =>
      Effect.flatMap(thread(threadId), (t) => {
        runOf(t, runId).streaming = false;
        return signal(t);
      }),
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
    restart: Effect.fn("groupChat.testkit.restart")(function* (threadId, runId) {
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
    hold: Effect.fn("groupChat.testkit.hold")(function* (threadId, held) {
      const t = yield* thread(threadId);
      t.held = held;
      for (const run of t.runs) if (run.status === "queued") run.queueHeld = held;
      yield* signal(t);
      yield* startNextQueued(t);
    }),
    ask: Effect.fn("groupChat.testkit.ask")(function* (
      threadId,
      requestId,
      question,
      options = [],
      multiSelect = false,
    ) {
      const t = yield* thread(threadId);
      t.pending = {
        _tag: "question",
        requestId: requestId as RuntimeRequestId,
        questions: [
          {
            id: question,
            header: "Question",
            question,
            options: options.map((label) => ({ label, description: null, value: null })),
            multiSelect,
          },
        ],
      };
      yield* signal(t);
    }),
    askApproval: Effect.fn("groupChat.testkit.askApproval")(function* (threadId) {
      const t = yield* thread(threadId);
      t.pending = { _tag: "approval" };
      yield* signal(t);
    }),
    sends: (threadId) => Effect.map(thread(threadId), (t) => t.sends),
  };
  return fake;
});

const neverPort: GroupChatThreadPort["Service"] = {
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

export const layerNeverPort = Layer.mergeAll(
  Layer.succeed(GroupChatThreadPort, neverPort),
  Reach.layerFixed({ exposed: false, origin: "http://127.0.0.1:1" }),
  FetchHttpClient.layer,
);

const layerFakePort = (fake: FakeThreads) => Layer.succeed(GroupChatThreadPort, fake.port);

export interface App {
  readonly engine: GroupChatEngine["Service"];
  readonly store: GroupChatStore;
  readonly shutdown: Effect.Effect<void>;
  readonly until: <A>(
    read: Effect.Effect<A, StoreError>,
    predicate: (value: A) => boolean,
  ) => Effect.Effect<A, StoreError>;
  readonly dispatch: GroupChatEngine["Service"]["dispatch"];
}

export const FAKE_ORIGIN = "http://127.0.0.1:1";

const FAST_EXTERNAL: ExternalDeliverySettings = {
  maxAttempts: 3,
  backoffBase: "10 millis",
  callbackTimeout: "300 millis",
  restTimeout: "300 millis",
  webhookPostTimeout: "300 millis",
};

export const boot = Effect.fn("groupChat.testkit.boot")(function* (
  fake: FakeThreads,
  baseDir: string,
  options: {
    readonly external?: Partial<ExternalDeliverySettings>;
    readonly exposed?: boolean;
  } = {},
): Effect.fn.Return<App, never, Scope.Scope | NodeServices.NodeServices> {
  const layer = GroupChatLayer.layer.pipe(
    Layer.provide(layerFakePort(fake)),
    Layer.provide(Layer.succeed(RetryDelay, "10 millis")),
    Layer.provide(Layer.succeed(ExternalDeliveryConfig, { ...FAST_EXTERNAL, ...options.external })),
    Layer.provide(Reach.layerFixed({ exposed: options.exposed ?? false, origin: FAKE_ORIGIN })),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
  );
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const context = yield* Layer.buildWithScope(layer, scope).pipe(Effect.orDie);
  const groupChat = Context.get(context, GroupChatLayer.GroupChat);
  const engine = yield* groupChat.engine.pipe(Effect.orDie);
  const store = yield* groupChat.store.pipe(Effect.orDie);
  const subscription = yield* PubSub.subscribe(store.changes);
  yield* engine.start;
  const until: App["until"] = Effect.fn("groupChat.testkit.until")(function* (read, predicate) {
    for (;;) {
      const value = yield* read;
      if (predicate(value)) return value;
      yield* PubSub.take(subscription);
    }
  });
  return {
    engine,
    store,
    until,
    dispatch: engine.dispatch,
    shutdown: Scope.close(scope, Exit.void),
  };
});

export const tempBaseDir = Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
  fileSystem.makeTempDirectoryScoped({ prefix: "t3-group-chat-" }),
);

export interface AgentCall {
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

export interface AgentAnswer {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Milliseconds to hold the whole answer back, so a test can act while the request is open. */
  readonly delayMs?: number;
  /** `hang` sends the headers and one byte and never ends; `chunked` sends the body without a content-length. */
  readonly mode?: "hang" | "chunked";
}

export interface FakeAgent {
  readonly url: string;
  readonly calls: Array<AgentCall>;
  answer: (call: AgentCall) => AgentAnswer;
}

export const fakeAgent = (
  answer: (call: AgentCall) => AgentAnswer,
): Effect.Effect<FakeAgent, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<FakeAgent>((resume) => {
      const calls: Array<AgentCall> = [];
      const agent: FakeAgent = { url: "", calls, answer };
      const server = NodeHttp.createServer((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", async () => {
          const call: AgentCall = {
            url: request.url ?? "/",
            headers: request.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          };
          calls.push(call);
          const answered = agent.answer(call);
          if (answered.delayMs !== undefined) {
            // @effect-diagnostics-next-line globalTimers:off -- the agent is plain node:http outside Effect.
            await new Promise((resolve) => setTimeout(resolve, answered.delayMs));
          }
          response.writeHead(answered.status, {
            "content-type": "application/json",
            ...answered.headers,
          });
          if (answered.mode === "hang") {
            response.write(answered.body.slice(0, 1));
            return;
          }
          if (answered.mode === "chunked") {
            for (let at = 0; at < answered.body.length; at += 65_536) {
              response.write(answered.body.slice(at, at + 65_536));
            }
            response.end();
            return;
          }
          response.end(answered.body);
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as NodeNet.AddressInfo;
        resume(
          Effect.succeed(
            Object.assign(agent, {
              url: `http://127.0.0.1:${address.port}/agent`,
              close: () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            }),
          ),
        );
      });
    }),
    (agent) => Effect.promise(() => (agent as FakeAgent & { close: () => Promise<void> }).close()),
  );
