import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type AgentSessionSource,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ClaudeLhcOperationError } from "../provider/Drivers/claudeLhc/client.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

function candidate(
  modelSelection: typeof CODEX_MODEL_SELECTION,
  providerSessionId: string,
  provider: AgentSessionSource = "codex",
) {
  const providerInstanceId = modelSelection.instanceId;
  return {
    _tag: "Importable" as const,
    source: {
      provider,
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerInstanceId}/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId,
      title: "Imported thread",
      model: modelSelection.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      omittedMessageCount: 0,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
  } satisfies AgentSessionScanner.AgentSessionRecentThread;
}

const PI_MODEL_SELECTION = { instanceId: ProviderInstanceId.make("pi"), model: "default" };

// Pi threads are owned by their session file path, not the session UUID.
const nativeId = ({ source }: ReturnType<typeof candidate>) =>
  source.provider === "pi" ? source.filePath : source.providerSessionId;

function importId(source: ReturnType<typeof candidate>) {
  return ThreadId.make(
    `import:${source.source.providerInstanceId}:${source.source.providerSessionId}`,
  );
}

const seedOwner = Effect.fn(function* (
  source: ReturnType<typeof candidate>,
  lifecycle: "active" | "archived" | "deleted" = "active",
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { providerInstanceId, providerSessionId, provider } = source.source;
  const nativeThreadId = nativeId(source);
  const threadId = ThreadId.make(`owner:${providerInstanceId}:${providerSessionId}`);
  const driver = ProviderDriverKind.make(provider);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({ driver, nativeThreadId }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Native thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: source.thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: lifecycle === "archived" ? now : null,
    deletedAt: lifecycle === "deleted" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

const makeImporter = Effect.fn(function* (
  candidates: ReadonlyArray<ReturnType<typeof candidate>>,
  beforeTransaction: Effect.Effect<void> = Effect.void,
) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const published: Array<ApplicationStoredEvent> = [];
  const withTransaction: typeof sql.withTransaction = (effect) =>
    beforeTransaction.pipe(Effect.andThen(sql.withTransaction(effect)));
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
  });
  const sinkLayer = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, {
          ...events,
          publishCommitted: (batch) =>
            events.publishCommitted(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  published.push(...batch);
                }),
              ),
            ),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sinkLayer,
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            recentThreads: () => Stream.fromIterable(candidates),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: projectId,
                title: "Project",
                workspaceRoot: "/workspace/project",
                defaultModelSelection: null,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: null,
              }),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
        ),
      ),
    ),
  );
  const importer = Context.get(context, AgentSessionImporter.AgentSessionImporter);
  return { run: importer.importRecentAgentThreads({ projectId }), published };
});

it.effect(
  "ignores owned sessions, including archived and deleted threads, but imports other instances and unowned sessions",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const active = candidate(CODEX_MODEL_SELECTION, "active");
      const archived = candidate(
        CLAUDE_MODEL_SELECTION,
        "020e7f00-dce6-406b-8ec6-ed90498945d6",
        "claudeAgent",
      );
      const deleted = candidate(CODEX_MODEL_SELECTION, "deleted");
      const ownedPi = candidate(PI_MODEL_SELECTION, "owned-pi", "pi");
      const owners = [
        yield* seedOwner(active),
        yield* seedOwner(archived, "archived"),
        yield* seedOwner(deleted, "deleted"),
        yield* seedOwner(ownedPi),
      ];
      const before = yield* Effect.forEach(owners, (id) =>
        projections.getThreadRecords(id, ["providerThreads"]),
      );
      const otherInstance = candidate(
        { ...CLAUDE_MODEL_SELECTION, instanceId: ProviderInstanceId.make("claude-other") },
        archived.source.providerSessionId,
        "claudeAgent",
      );
      const unowned = candidate(CODEX_MODEL_SELECTION, "unowned");
      unowned.thread.omittedMessageCount = 1;
      const unownedPi = candidate(PI_MODEL_SELECTION, "unowned-pi", "pi");
      const importer = yield* makeImporter([
        active,
        archived,
        deleted,
        ownedPi,
        otherInstance,
        unowned,
        unownedPi,
      ]);

      expect(yield* importer.run).toEqual({ importedCount: 3, skippedCount: 0 });
      for (const source of [active, archived, deleted, ownedPi]) {
        const threadId = importId(source);
        expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
        expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
        expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
      }
      expect(
        yield* Effect.forEach(owners, (id) =>
          projections.getThreadRecords(id, ["providerThreads"]),
        ),
      ).toEqual(before);
      expect(
        new Set(
          importer.published.flatMap((stored) =>
            "event" in stored ? [stored.event.threadId] : [],
          ),
        ),
      ).toEqual(new Set([importId(otherInstance), importId(unowned), importId(unownedPi)]));
      for (const source of [otherInstance, unowned, unownedPi]) {
        const threadId = importId(source);
        const records = yield* projections.getThreadRecords(threadId, [
          "messages",
          "turnItems",
          "providerThreads",
        ]);
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        const notices = records.turnItems.filter((item) => item.type === "system_notice");
        if (source === unowned) {
          expect(records.turnItems[0]).toBe(notices[0]);
          expect(notices).toMatchObject([
            {
              ordinal: 1,
              runId: null,
              message: expect.stringContaining("1 earlier message was not imported"),
            },
          ]);
        } else {
          expect(notices).toEqual([]);
        }
        expect(records.thread.historyOrigin).toBe("v1_import");
        expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(nativeId(source));
        expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
          providerInstanceId: source.source.providerInstanceId,
          resumeCursor:
            source.source.provider === "claudeAgent"
              ? { threadId, resume: source.source.providerSessionId }
              : { threadId: nativeId(source) },
          runtimePayload: { importedTranscripts: [source.source] },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks ownership after the import reaches the commit transaction", () =>
  Effect.gen(function* () {
    const enteringTransaction = yield* Deferred.make<void>();
    const continueTransaction = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "claimed-during-import");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(enteringTransaction, undefined).pipe(
        Effect.andThen(Deferred.await(continueTransaction)),
      ),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(enteringTransaction);
    // Commit ownership after all pre-transaction reads, before the import acquires SQLite.
    const ownerId = yield* seedOwner(source);
    yield* Deferred.succeed(continueTransaction, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 0 });
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    expect(yield* events.read({ threadId: importId(source) }).pipe(Stream.runCollect)).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
    expect(importer.published).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retries failed commits and runtime persistence without replaying committed history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = candidate(CODEX_MODEL_SELECTION, "retry");
      const threadId = importId(source);
      const importer = yield* makeImporter([source]);
      yield* sql`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtimes.list()).toEqual([]);
      expect(importer.published).toEqual([]);
      yield* sql`DROP TRIGGER fail_import`;

      yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      const committed = yield* events.read({ threadId }).pipe(Stream.runCollect);
      expect(committed).toHaveLength(6);
      expect(importer.published).toHaveLength(6);
      expect(yield* runtimes.list()).toEqual([]);
      yield* sql`DROP TRIGGER fail_runtime`;

      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(committed);
      expect(importer.published).toHaveLength(6);
      expect(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerInstanceId: source.source.providerInstanceId,
        resumeCursor: { threadId: source.source.providerSessionId },
        runtimePayload: { importedTranscripts: [source.source] },
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

const STOCK_INSTANCE = ProviderInstanceId.make("claudeAgent");
const LHC_INSTANCE = ProviderInstanceId.make("claude-lhc-work");
const STOCK_SESSION = "11111111-1111-4111-8111-111111111111";
const GENERATION = "22222222-2222-4222-8222-222222222222";
const RENAMED_GENERATION = "33333333-3333-4333-8333-333333333333";
const COPIED_FILE = "44444444-4444-4444-8444-444444444444";
const COPIED_GENERATION = "55555555-5555-4555-8555-555555555555";
const importNow = Date.parse("2026-09-01T12:00:00.000Z");

const claudeTranscript = (cwd: string, sessionId: string, title: object = {}) =>
  `${JSON.stringify({
    type: "user",
    cwd,
    sessionId,
    timestamp: "2026-09-01T10:00:00.000Z",
    message: { role: "user", content: "Fix it" },
    ...title,
  })}\n${JSON.stringify({
    type: "assistant",
    sessionId,
    timestamp: "2026-09-01T10:01:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Fixed" }] },
  })}\n`;

const makeLhcFixture = Effect.fn(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = () =>
    fileSystem
      .makeTempDirectoryScoped({ prefix: "t3code-lhc-import-" })
      .pipe(Effect.flatMap((dir) => fileSystem.realPath(dir)));
  const baseDir = yield* tempDir();
  const claudeHome = yield* tempDir();
  const codexHome = yield* tempDir();
  const workspace = yield* tempDir();
  const write = (fileId: string, contents: string, ageMs = 60 * 60 * 1000) =>
    Effect.gen(function* () {
      const filePath = path.join(claudeHome, "projects", "-workspace", `${fileId}.jsonl`);
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fileSystem.writeFileString(filePath, contents);
      const seconds = (importNow - ageMs) / 1000;
      yield* fileSystem.utimes(filePath, seconds, seconds);
    });
  yield* write(STOCK_SESSION, claudeTranscript(workspace, STOCK_SESSION));
  yield* write(GENERATION, claudeTranscript(workspace, GENERATION, { aiTitle: "Fix the build" }));
  yield* write(
    RENAMED_GENERATION,
    claudeTranscript(workspace, RENAMED_GENERATION, { customTitle: "Plain title" }),
  );
  const lhcStore = path.join(baseDir, "userdata", "lhc");
  const createStore = fileSystem
    .makeDirectory(lhcStore, { recursive: true })
    .pipe(Effect.andThen(fileSystem.writeFileString(path.join(lhcStore, "registry.sqlite"), "")));
  return { baseDir, claudeHome, codexHome, workspace, lhcStore, write, createStore };
});

const makeLhcImporter = Effect.fn(function* (input: {
  readonly fixture: Effect.Success<ReturnType<typeof makeLhcFixture>>;
  readonly lhcConfig: Record<string, unknown>;
  readonly managed: ReadonlySet<string>;
  readonly storeFails?: boolean;
}) {
  const calls: Array<ReadonlyArray<string>> = [];
  const { fixture } = input;
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provideMerge(
        Layer.effect(AgentSessionScanner.AgentSessionScanner, AgentSessionScanner.make),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          ServerSettings.layerTest({
            providerInstances: {
              [STOCK_INSTANCE]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: fixture.claudeHome },
              },
              [LHC_INSTANCE]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: fixture.claudeHome, ...input.lhcConfig },
              },
              [ProviderInstanceId.make("codex")]: {
                driver: ProviderDriverKind.make("codex"),
                config: { homePath: fixture.codexHome },
              },
            },
          }),
          ServerConfig.layerTest(fixture.baseDir, fixture.baseDir),
          Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
          Layer.succeed(AgentSessionScanner.ClaudeLhcSessionInspector, {
            inspect: (sessionIds) =>
              Effect.sync(() => calls.push(sessionIds)).pipe(
                Effect.andThen(
                  input.storeFails === true
                    ? Effect.fail(
                        new ClaudeLhcOperationError({
                          operation: "inspectSessions",
                          cause: new Error("LHC registry read failed: SQLITE_CANTOPEN"),
                        }),
                      )
                    : Effect.succeed(
                        sessionIds.map((id) =>
                          input.managed.has(id)
                            ? { kind: "managed" as const, threadId: "t", currentSessionId: id }
                            : { kind: "unknown" as const },
                        ),
                      ),
                ),
              ),
          }),
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(EventSink.EventSinkV2, yield* EventSink.EventSinkV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: projectId,
                title: "Project",
                workspaceRoot: fixture.workspace,
                defaultModelSelection: null,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: null,
              }),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId) =>
              Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId, cause: null })),
          }),
        ),
      ),
    ),
  );
  return {
    calls,
    scanner: Context.get(context, AgentSessionScanner.AgentSessionScanner),
    settings: Context.get(context, ServerSettings.ServerSettingsService),
    run: Context.get(context, AgentSessionImporter.AgentSessionImporter).importRecentAgentThreads({
      projectId,
    }),
  };
});

const importedNativeIds = Effect.gen(function* () {
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  return (yield* runtimes.list()).map((runtime) => runtime.resumeCursor).sort();
});

it.effect("refuses LHC generations from a stale list and imports the stock sessions", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(importNow);
    const fixture = yield* makeLhcFixture();
    yield* fixture.write(COPIED_FILE, claudeTranscript(fixture.workspace, COPIED_GENERATION));
    yield* fixture.createStore;
    const importer = yield* makeLhcImporter({
      fixture,
      lhcConfig: {},
      managed: new Set([GENERATION, RENAMED_GENERATION, COPIED_GENERATION]),
    });
    const stale = yield* importer.scanner.scan;
    expect(stale.candidates.map((candidate) => candidate.threadCount)).toEqual([4]);
    yield* importer.settings.updateSettings({
      providerInstances: {
        [LHC_INSTANCE]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: fixture.claudeHome, contextEngine: "claude-lhc" },
        },
      },
    });

    expect(yield* importer.run).toEqual({
      importedCount: 1,
      skippedCount: 3,
      refused: [
        {
          claudeHome: fixture.claudeHome,
          lhcInstanceIds: [LHC_INSTANCE],
          reason: "lhc-managed",
          sessionCount: 3,
        },
      ],
    });
    expect(yield* importedNativeIds).toEqual([
      { threadId: `import:${STOCK_INSTANCE}:${STOCK_SESSION}`, resume: STOCK_SESSION },
    ]);
    expect(importer.calls).toEqual([
      expect.arrayContaining([STOCK_SESSION, GENERATION, RENAMED_GENERATION, COPIED_FILE]),
      [COPIED_GENERATION],
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect.each([
  { case: "missing", reason: "lhc-store-missing", calls: 0 },
  {
    case: "unreadable",
    reason: "lhc-store-unreadable",
    detail: "claude-lhc inspectSessions failed: LHC registry read failed: SQLITE_CANTOPEN",
    calls: 1,
  },
] as const)("refuses every session of a shared home whose LHC store is $case", (store) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(importNow);
    const fixture = yield* makeLhcFixture();
    if (store.case === "unreadable") {
      yield* fixture.createStore;
    }
    const importer = yield* makeLhcImporter({
      fixture,
      lhcConfig: { contextEngine: "claude-lhc" },
      managed: new Set([GENERATION]),
      storeFails: store.case === "unreadable",
    });

    expect(yield* importer.run).toEqual({
      importedCount: 0,
      skippedCount: 3,
      refused: [
        {
          claudeHome: fixture.claudeHome,
          lhcInstanceIds: [LHC_INSTANCE],
          reason: store.reason,
          ...("detail" in store ? { detail: store.detail } : {}),
          sessionCount: 3,
        },
      ],
    });
    expect(yield* importedNativeIds).toEqual([]);
    expect(importer.calls).toHaveLength(store.calls);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("imports every session from a home no LHC instance uses, with no refusals", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(importNow);
    const fixture = yield* makeLhcFixture();
    const importer = yield* makeLhcImporter({
      fixture,
      lhcConfig: { contextEngine: "claude" },
      managed: new Set([GENERATION]),
    });

    expect(yield* importer.run).toEqual({ importedCount: 3, skippedCount: 0 });
    expect(importer.calls).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("refuses known LHC generations before they use the import budget", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(importNow);
    const fixture = yield* makeLhcFixture();
    const generations = Array.from(
      { length: 100 },
      (_, index) => `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
    );
    for (const id of generations) {
      yield* fixture.write(id, claudeTranscript(fixture.workspace, id));
    }
    yield* fixture.write(
      STOCK_SESSION,
      claudeTranscript(fixture.workspace, STOCK_SESSION),
      2 * 60 * 60 * 1000,
    );
    yield* fixture.createStore;
    const importer = yield* makeLhcImporter({
      fixture,
      lhcConfig: { contextEngine: "claude-lhc" },
      managed: new Set([...generations, GENERATION, RENAMED_GENERATION]),
    });

    expect(yield* importer.run).toMatchObject({ importedCount: 1, skippedCount: 102 });
    expect(yield* importedNativeIds).toEqual([
      { threadId: `import:${STOCK_INSTANCE}:${STOCK_SESSION}`, resume: STOCK_SESSION },
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("skips a stale list's sessions when their instance has become an LHC instance", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(importNow);
    const fixture = yield* makeLhcFixture();
    yield* fixture.createStore;
    const importer = yield* makeLhcImporter({
      fixture,
      lhcConfig: {},
      managed: new Set([GENERATION, RENAMED_GENERATION]),
    });
    yield* importer.scanner.scan;
    yield* importer.settings.updateSettings({
      providerInstances: {
        [STOCK_INSTANCE]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: fixture.claudeHome, contextEngine: "claude-lhc" },
        },
      },
    });

    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 3 });
    expect(yield* importedNativeIds).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);
