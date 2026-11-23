import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ContextHandoffId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextHandoff,
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

const bindCommand = (ifLastRun: number) => ({
  type: "thread.limbase.bind" as const,
  commandId: CommandId.make("command:bind"),
  threadId: THREAD_ID,
  providerInstanceId: LIMBASE,
  limbaseThreadId: "th_target",
  sessionId: "session-new",
  ifLastRun,
});
const NEW_ROW = ProviderThreadId.make("pt:session-new");

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

  it("adds a Limbase row that holds the migrated runs and points the thread at it", () => {
    const plan = LimbaseMigration.planBind({
      projection: idle,
      command: bindCommand(2),
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
      refusal({ projection: idle, command: bindCommand(1), providerThreadId: NEW_ROW, now: NOW }),
      "not 1",
    );
  });

  it.each(["queued", "starting", "running", "waiting", "preparing"] as const)(
    "refuses while a run is %s",
    (status) => {
      assert.include(
        refusal({
          projection: { ...idle, runs: [...idle.runs, run(3, "pt:session-a", { status })] },
          command: bindCommand(3),
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
        command: bindCommand(2),
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
        command: bindCommand(2),
        providerThreadId: NEW_ROW,
        now: NOW,
      }),
      "not Claude",
    );
    assert.include(
      refusal({
        projection: idle,
        command: bindCommand(2),
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
