import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ContextHandoffId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  ProviderTurnId,
  TurnItemId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as LimbaseMigration from "./LimbaseMigration.ts";

const NOW = DateTime.makeUnsafe("2026-11-23T12:00:00.000Z");
const THREAD_ID = ThreadId.make("thread:migration");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const PLAIN = ProviderInstanceId.make("claudeAgent");
const LIMBASE = ProviderInstanceId.make("claude-limbase");
const CODEX = ProviderInstanceId.make("codex");
const SELECTION = { instanceId: PLAIN, model: "claude-opus-4-7" };

const appThread = (
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: THREAD_ID,
  projectId: ProjectId.make("project:migration"),
  title: "Migrated",
  providerInstanceId: PLAIN,
  modelSelection: SELECTION,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: "/work",
  activeProviderThreadId: ProviderThreadId.make("pt:session-b"),
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
  forkedFrom: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});

const providerThread = (
  id: string,
  nativeId: string,
  overrides: Partial<OrchestrationV2ProviderThread> = {},
): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make(id),
  driver: CLAUDE,
  providerInstanceId: PLAIN,
  providerSessionId: null,
  appThreadId: THREAD_ID,
  ownerNodeId: null,
  nativeThreadRef: { driver: CLAUDE, nativeId, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  contextUsage: null,
  nativeMetadata: null,
  goal: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const run = (
  ordinal: number,
  providerThreadId: string | null,
  overrides: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run => ({
  id: RunId.make(`run:${ordinal}`),
  threadId: THREAD_ID,
  ordinal,
  providerInstanceId: PLAIN,
  modelSelection: SELECTION,
  providerThreadId: providerThreadId === null ? null : ProviderThreadId.make(providerThreadId),
  userMessageId: MessageId.make(`message:${ordinal}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: NOW,
  checkpointId: null,
  contextHandoffId: null,
  ...overrides,
});

const projection = (input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly thread?: OrchestrationV2AppThread;
  readonly runtimeRequests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
}) => ({
  thread: input.thread ?? appThread(),
  runs: input.runs,
  runtimeRequests: input.runtimeRequests ?? [],
  providerThreads: input.providerThreads,
});

const sessionA = providerThread("pt:session-a", "session-a", {
  firstRunOrdinal: 1,
  lastRunOrdinal: 2,
});
const sessionB = providerThread("pt:session-b", "session-b", {
  firstRunOrdinal: 3,
  lastRunOrdinal: 4,
});
const codexRow = providerThread("pt:codex", "codex-thread", {
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: CODEX,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "codex-thread",
    strength: "strong",
  },
});

const bindCommand = (ifLastRun: number, ifHistory: string) => ({
  type: "thread.limbase.bind" as const,
  commandId: CommandId.make("command:bind"),
  threadId: THREAD_ID,
  providerInstanceId: LIMBASE,
  limbaseThreadId: "th_target",
  sessionId: "session-new",
  ifLastRun,
  ifHistory,
});
const NEW_ROW = ProviderThreadId.make("pt:session-new");

describe("LimbaseMigration.limbaseIds", () => {
  it("names the active row and its Limbase thread, and nothing for a row not on Limbase", () => {
    const limbaseRow = providerThread("pt:limbase", "session-l", {
      providerInstanceId: LIMBASE,
      nativeMetadata: { limbaseThreadId: "th_native" },
    });
    const onLimbase = appThread({ activeProviderThreadId: limbaseRow.id });
    assert.deepStrictEqual(
      LimbaseMigration.limbaseIds({ thread: onLimbase, providerThreads: [sessionA, limbaseRow] }),
      { providerThreadId: "pt:limbase", limbaseThreadId: "th_native" },
    );
    assert.isNull(
      LimbaseMigration.limbaseIds({ thread: appThread(), providerThreads: [sessionB, limbaseRow] }),
    );
    assert.isNull(
      LimbaseMigration.limbaseIds({
        thread: appThread({ activeProviderThreadId: null }),
        providerThreads: [limbaseRow],
      }),
    );
  });
});

describe("LimbaseMigration.buildManifest", () => {
  it("lists each native session in run order with the runs it holds", () => {
    const handoff: OrchestrationV2ContextHandoff = {
      id: ContextHandoffId.make("handoff:5"),
      threadId: THREAD_ID,
      targetRunId: RunId.make("run:5"),
      fromProviderThreadIds: [ProviderThreadId.make("pt:session-b")],
      toProviderThreadId: ProviderThreadId.make("pt:codex"),
      coveredRunOrdinals: { from: 1, to: 4 },
      strategy: "full_thread_summary",
      status: "ready",
      summaryMessageId: null,
      summaryText: "",
      delivery: { nativeThreadId: "codex-thread", status: "inline", itemIds: [] },
      createdByProviderInstanceId: CODEX,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const attempt: OrchestrationV2RunAttempt = {
      id: RunAttemptId.make("attempt:4"),
      nativeThreadId: "session-b",
      runId: RunId.make("run:4"),
      attemptOrdinal: 1,
      rootNodeId: NodeId.make("node:4"),
      providerInstanceId: PLAIN,
      providerThreadId: ProviderThreadId.make("pt:session-b"),
      providerTurnId: null,
      reason: "initial",
      status: "completed",
      startedAt: NOW,
      completedAt: NOW,
    };
    const manifest = LimbaseMigration.buildManifest({
      projection: {
        ...projection({
          runs: [
            run(1, "pt:session-a"),
            run(2, "pt:session-a", { status: "interrupted" }),
            run(3, "pt:session-b", { freshContext: true }),
            run(4, "pt:session-b", { activeAttemptId: RunAttemptId.make("attempt:4") }),
            run(5, "pt:codex", { providerInstanceId: CODEX }),
            // Neither reached the history: one rolled back, one cancelled before it started.
            run(6, "pt:session-b", { status: "rolled_back" }),
            run(7, "pt:session-b", { status: "cancelled", startedAt: null }),
          ],
          providerThreads: [sessionA, sessionB, codexRow],
        }),
        attempts: [attempt],
        contextHandoffs: [handoff],
        providerTurns: [],
        turnItems: [],
      },
      cwd: "/work",
      pathOf: (session) =>
        LimbaseMigration.isClaudeDriver(session.driver)
          ? `/claude/projects/-work/${session.sessionId}.jsonl`
          : null,
      userTextOf: (target) => (target.ordinal === 5 ? "clean words" : undefined),
    });
    assert.equal(manifest.lastRunOrdinal, 7);
    assert.equal(manifest.cwd, "/work");
    assert.deepEqual(
      manifest.sessions.map((session) => ({
        id: session.sessionId,
        path: session.path,
        range: session.runRange,
        ordinals: session.runOrdinals,
        fresh: session.freshContext,
      })),
      [
        {
          id: "session-a",
          path: "/claude/projects/-work/session-a.jsonl",
          range: { first: 1, last: 2 },
          ordinals: [1, 2],
          fresh: undefined,
        },
        {
          id: "session-b",
          path: "/claude/projects/-work/session-b.jsonl",
          range: { first: 3, last: 4 },
          ordinals: [3, 4],
          fresh: true,
        },
        {
          id: "codex-thread",
          path: null,
          range: { first: 5, last: 5 },
          ordinals: [5],
          fresh: undefined,
        },
      ],
    );
    assert.deepEqual(manifest.handoffs, [
      {
        runOrdinal: 5,
        strategy: "full_thread_summary",
        status: "ready",
        coveredRunOrdinals: { from: 1, to: 4 },
        deliveryStatus: "inline",
        cleanUserTextSha256: LimbaseMigration.sha256Hex("clean words"),
      },
    ]);
  });
});

describe("LimbaseMigration.planBind", () => {
  const idle = projection({
    runs: [run(1, "pt:session-a"), run(2, "pt:session-a")],
    providerThreads: [sessionA],
    thread: appThread({ activeProviderThreadId: sessionA.id }),
  });
  const idleHistory = LimbaseMigration.historyDigest(idle.runs);

  it("adds a Limbase row that holds the migrated runs and points the thread at it", () => {
    const plan = LimbaseMigration.planBind({
      projection: idle,
      command: bindCommand(2, idleHistory),
      providerThreadId: NEW_ROW,
      now: NOW,
    });
    assert.isTrue(Result.isSuccess(plan));
    if (!Result.isSuccess(plan)) return;
    assert.equal(plan.success.providerThread.providerInstanceId, LIMBASE);
    assert.deepEqual(plan.success.providerThread.nativeMetadata, {
      limbaseThreadId: "th_target",
      limbaseMigratedThroughRunOrdinal: 2,
      limbaseMigratedFromProviderThreadId: sessionA.id,
    });
    assert.deepEqual(plan.success.thread.modelSelection, { ...SELECTION, instanceId: LIMBASE });
    assert.equal(plan.success.thread.activeProviderThreadId, NEW_ROW);
    assert.equal(LimbaseMigration.historyStartOrdinal(plan.success.providerThread), 3);
  });

  const refusal = (input: Parameters<typeof LimbaseMigration.planBind>[0]) => {
    const plan = LimbaseMigration.planBind(input);
    return Result.isFailure(plan) ? plan.failure : undefined;
  };

  it("refuses a thread that ran again after the export", () => {
    assert.include(
      refusal({
        projection: idle,
        command: bindCommand(1, idleHistory),
        providerThreadId: NEW_ROW,
        now: NOW,
      }),
      "not 1",
    );
  });

  it("refuses an export taken before a rollback, though the last run is unchanged", () => {
    const rolledBack = {
      ...idle,
      runs: [run(1, "pt:session-a"), run(2, "pt:session-a", { status: "rolled_back" })],
    };
    assert.include(
      refusal({
        projection: rolledBack,
        command: bindCommand(2, idleHistory),
        providerThreadId: NEW_ROW,
        now: NOW,
      }),
      "changed after the export",
    );
  });

  it.each(["queued", "starting", "running", "waiting", "preparing"] as const)(
    "refuses while a run is %s",
    (status) => {
      assert.include(
        refusal({
          projection: { ...idle, runs: [...idle.runs, run(3, "pt:session-a", { status })] },
          command: bindCommand(3, idleHistory),
          providerThreadId: NEW_ROW,
          now: NOW,
        }),
        "in progress or queued",
      );
    },
  );

  it("refuses a thread already bound, one not on Claude, and a session it already has", () => {
    const bound = providerThread("pt:bound", "session-bound", {
      providerInstanceId: LIMBASE,
      nativeMetadata: {
        limbaseThreadId: "th_old",
        limbaseMigratedThroughRunOrdinal: 2,
        limbaseMigratedFromProviderThreadId: sessionA.id,
      },
    });
    assert.include(
      refusal({
        projection: {
          ...idle,
          providerThreads: [sessionA, bound],
          thread: appThread({ activeProviderThreadId: bound.id }),
        },
        command: bindCommand(2, idleHistory),
        providerThreadId: NEW_ROW,
        now: NOW,
      }),
      "already bound",
    );
    assert.include(
      refusal({
        projection: {
          ...idle,
          providerThreads: [codexRow],
          thread: appThread({ activeProviderThreadId: codexRow.id }),
        },
        command: bindCommand(2, idleHistory),
        providerThreadId: NEW_ROW,
        now: NOW,
      }),
      "not Claude",
    );
    assert.include(
      refusal({
        projection: idle,
        command: bindCommand(2, idleHistory),
        providerThreadId: sessionA.id,
        now: NOW,
      }),
      "already has a provider thread",
    );
  });
});

describe("LimbaseMigration.planUnbind", () => {
  it("points the thread back at the original row and names the runs made on Limbase", () => {
    const bound = providerThread("pt:bound", "session-bound", {
      providerInstanceId: LIMBASE,
      nativeMetadata: {
        limbaseThreadId: "th_target",
        limbaseMigratedThroughRunOrdinal: 2,
        limbaseMigratedFromProviderThreadId: sessionA.id,
      },
    });
    const plan = LimbaseMigration.planUnbind({
      projection: projection({
        runs: [
          run(1, "pt:session-a"),
          run(2, "pt:session-a"),
          run(3, "pt:bound"),
          run(4, "pt:bound"),
        ],
        providerThreads: [sessionA, bound],
        thread: appThread({
          activeProviderThreadId: bound.id,
          providerInstanceId: LIMBASE,
          modelSelection: { ...SELECTION, instanceId: LIMBASE },
        }),
      }),
      now: NOW,
    });
    assert.isTrue(Result.isSuccess(plan));
    if (!Result.isSuccess(plan)) return;
    assert.equal(plan.success.thread.activeProviderThreadId, sessionA.id);
    assert.deepEqual(plan.success.thread.modelSelection, SELECTION);
    assert.deepEqual(plan.success.limbaseRuns, { from: 3, to: 4 });
  });

  it("refuses a thread that is not bound", () => {
    const plan = LimbaseMigration.planUnbind({
      projection: projection({
        runs: [run(1, "pt:session-a")],
        providerThreads: [sessionA],
        thread: appThread({ activeProviderThreadId: sessionA.id }),
      }),
      now: NOW,
    });
    assert.isTrue(Result.isFailure(plan));
  });
});

describe("LimbaseMigration.buildManifest runs", () => {
  const attemptOf = (
    ordinal: number,
    attemptOrdinal: number,
    overrides: Partial<OrchestrationV2RunAttempt> = {},
  ): OrchestrationV2RunAttempt => ({
    id: RunAttemptId.make(`attempt:${ordinal}:${attemptOrdinal}`),
    runId: RunId.make(`run:${ordinal}`),
    attemptOrdinal,
    rootNodeId: NodeId.make(`node:${ordinal}:${attemptOrdinal}`),
    providerInstanceId: PLAIN,
    providerThreadId: ProviderThreadId.make("pt:session-a"),
    providerTurnId: null,
    reason: attemptOrdinal === 1 ? "initial" : "steering_restart",
    status: "completed",
    startedAt: NOW,
    completedAt: NOW,
    ...overrides,
  });
  const turnFor = (
    attempt: OrchestrationV2RunAttempt,
    nativeId: string,
  ): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(`provider-turn:${attempt.id}`),
    providerThreadId: attempt.providerThreadId,
    nodeId: attempt.rootNodeId,
    runAttemptId: attempt.id,
    nativeTurnRef: { driver: CLAUDE, nativeId, strength: "weak" },
    ordinal: 1,
    status: "completed",
    startedAt: NOW,
    completedAt: NOW,
  });
  const LINE_1 = "11111111-1111-4111-8111-111111111111";
  const LINE_2A = "22222222-2222-4222-8222-22222222222a";
  const LINE_2B = "22222222-2222-4222-8222-22222222222b";

  // Run 2 was restarted by a steer: its first attempt wrote a line, its second wrote another.
  const retried = [
    attemptOf(1, 1, { nativeThreadId: "session-a" }),
    attemptOf(2, 1, { nativeThreadId: "session-a", status: "superseded" }),
    attemptOf(2, 2, { nativeThreadId: "session-a" }),
    // Stopped before any assistant line: the adapter's cursor is still its synthetic id.
    attemptOf(3, 1, { nativeThreadId: "session-a", status: "cancelled" }),
    attemptOf(4, 1, { nativeThreadId: "session-a", status: "failed" }),
    attemptOf(5, 1, {
      providerInstanceId: CODEX,
      providerThreadId: codexRow.id,
      nativeThreadId: "codex-thread",
    }),
  ];
  const usageLimit: OrchestrationV2TurnItem = {
    id: TurnItemId.make("item:4:error"),
    threadId: THREAD_ID,
    runId: RunId.make("run:4"),
    nodeId: NodeId.make("node:4:1"),
    providerThreadId: ProviderThreadId.make("pt:session-a"),
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "failed",
    title: null,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
    type: "error",
    failure: {
      class: "usage_limit",
      message: "You have hit your limit.",
      code: "rate_limit",
      retryable: true,
      resetAt: null,
    },
  };
  const manifest = LimbaseMigration.buildManifest({
    projection: {
      ...projection({
        runs: [
          run(1, "pt:session-a", { activeAttemptId: retried[0]!.id }),
          run(2, "pt:session-a", { activeAttemptId: retried[2]!.id }),
          run(3, "pt:session-a", { status: "cancelled", activeAttemptId: retried[3]!.id }),
          run(4, "pt:session-a", {
            status: "failed",
            activeAttemptId: retried[4]!.id,
            rootNodeId: NodeId.make("node:4:1"),
          }),
          run(5, "pt:codex", { providerInstanceId: CODEX, activeAttemptId: retried[5]!.id }),
          // Cancelled while queued: it never started an attempt.
          run(6, "pt:session-a", { status: "cancelled", startedAt: null }),
        ],
        providerThreads: [sessionA, codexRow],
      }),
      attempts: retried,
      contextHandoffs: [],
      providerTurns: [
        turnFor(retried[0]!, LINE_1),
        turnFor(retried[1]!, LINE_2A),
        turnFor(retried[2]!, LINE_2B),
        turnFor(retried[3]!, `turn:${retried[3]!.id}`),
        turnFor(retried[5]!, "codex-turn-uuid"),
      ],
      turnItems: [usageLimit],
    },
    cwd: "/work",
    pathOf: () => null,
    userTextOf: () => undefined,
  });
  const runsByOrdinal = new Map((manifest.runs ?? []).map((entry) => [entry.ordinal, entry]));

  it("gives each attempt of a retried run its own last assistant line", () => {
    assert.deepEqual(runsByOrdinal.get(2), {
      ordinal: 2,
      status: "completed",
      attempts: [
        {
          attemptOrdinal: 1,
          status: "superseded",
          sessionId: "session-a",
          lastRootAssistantUuid: LINE_2A,
        },
        {
          attemptOrdinal: 2,
          status: "completed",
          sessionId: "session-a",
          lastRootAssistantUuid: LINE_2B,
        },
      ],
    });
    assert.equal(runsByOrdinal.get(1)?.attempts[0]?.lastRootAssistantUuid, LINE_1);
  });

  it("gives a cancelled run its status, and null for an attempt that wrote no assistant line", () => {
    assert.deepEqual(runsByOrdinal.get(3), {
      ordinal: 3,
      status: "cancelled",
      attempts: [
        {
          attemptOrdinal: 1,
          status: "cancelled",
          sessionId: "session-a",
          lastRootAssistantUuid: null,
        },
      ],
    });
    assert.deepEqual(runsByOrdinal.get(6), { ordinal: 6, status: "cancelled", attempts: [] });
  });

  it("gives a failed run its failure's class and code", () => {
    assert.deepEqual(runsByOrdinal.get(4), {
      ordinal: 4,
      status: "failed",
      failureClass: "usage_limit",
      failureCode: "rate_limit",
      attempts: [
        {
          attemptOrdinal: 1,
          status: "failed",
          sessionId: "session-a",
          lastRootAssistantUuid: null,
        },
      ],
    });
  });

  it("names no assistant line for an attempt on another provider", () => {
    assert.equal(runsByOrdinal.get(5)?.attempts[0]?.lastRootAssistantUuid, null);
    assert.deepEqual(
      (manifest.runs ?? []).map((entry) => entry.ordinal),
      [1, 2, 3, 4, 5, 6],
    );
  });

  it("decodes a manifest written before runs were added, and one written now", () => {
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(LimbaseMigration.ThreadManifest));
    const before = decode(
      JSON.stringify({
        formatVersion: 1,
        threadId: "mcp:thread",
        title: "Synthetic",
        cwd: "/work",
        modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
        providerInstanceId: "claudeAgent",
        activeProviderThreadId: "pt:session-a",
        lastRunOrdinal: 1,
        historyDigest: "0".repeat(64),
        sessions: [
          {
            sessionId: "session-a",
            driver: "claudeAgent",
            providerInstanceId: "claudeAgent",
            providerThreadIds: ["pt:session-a"],
            path: "/claude/projects/-work/session-a.jsonl",
            runRange: { first: 1, last: 1 },
            runOrdinals: [1],
          },
        ],
        handoffs: [],
      }),
    );
    assert.isUndefined(before.runs);
    assert.deepEqual(decode(JSON.stringify(manifest)), manifest);
  });
});
