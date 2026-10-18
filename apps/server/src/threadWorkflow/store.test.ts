import { ThreadId, type ThreadWorkflowRecord } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { decide, lifecycleBlocker, toView, type ThreadWorkflowState } from "./domain.ts";
import {
  ThreadWorkflowStore,
  layer as storeLayer,
  threadIdOfLogFileName,
  threadLogFileName,
} from "./store.ts";
import { agent, apply, contextWith, given, request, started, threadId, user } from "./testkit.ts";

const withStore = <A, E>(
  baseDir: string,
  body: (store: ThreadWorkflowStore["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* ThreadWorkflowStore);
  }).pipe(
    Effect.provide(
      storeLayer.pipe(Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir)))),
    ),
  );

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-thread-workflow-store-",
  });
  const threadsDir = path.join(baseDir, "userdata", "thread-workflows", "threads");
  const logFile = path.join(threadsDir, threadLogFileName(threadId));
  const lines = (records: ReadonlyArray<ThreadWorkflowRecord>) =>
    records.map((record) => `${JSON.stringify(record)}\n`).join("");
  const seed = (text: string) =>
    fileSystem
      .makeDirectory(threadsDir, { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(logFile, text)));
  return { fileSystem, path, baseDir, threadsDir, logFile, lines, seed };
});

const appendAll = (
  store: ThreadWorkflowStore["Service"],
  records: ReadonlyArray<ThreadWorkflowRecord>,
) => Effect.forEach(records, (record) => store.append(threadId, record), { discard: true });

const twoRecords = given(started, [agent, { _tag: "tick", stepId: "w1.1", comment: "wrote it" }]);

it.layer(NodeServices.layer)("ThreadWorkflowStore", (it) => {
  it.effect("reloads what it appended", () =>
    Effect.gen(function* () {
      const { baseDir, fileSystem, logFile } = yield* setup;
      const appended = yield* withStore(baseDir, (store) =>
        appendAll(store, twoRecords.records).pipe(Effect.andThen(store.state(threadId))),
      );
      const reloaded = yield* withStore(baseDir, (store) => store.state(threadId));
      assert.deepStrictEqual(toView(reloaded), toView(twoRecords.state));
      assert.deepStrictEqual(toView(appended), toView(twoRecords.state));
      const text = yield* fileSystem.readFileString(logFile);
      assert.strictEqual(text.split("\n").length, 3);
    }),
  );

  it("names files safely and reversibly", () => {
    for (const id of ["0f8c-uuid-like", "Thread/../X", "a.b", "ünï", "A"]) {
      const name = threadLogFileName(ThreadId.make(id));
      assert.match(name, /^[a-z0-9_-]+\.jsonl$/);
      assert.strictEqual(threadIdOfLogFileName(name), id);
    }
    assert.notStrictEqual(
      threadLogFileName(ThreadId.make("A")),
      threadLogFileName(ThreadId.make("a")),
    );
    assert.isNull(threadIdOfLogFileName("x.jsonl.corrupt-20261017"));
    assert.isNull(threadIdOfLogFileName("_zz.jsonl"));
  });

  it.effect("truncates a torn final line that is not JSON", () =>
    Effect.gen(function* () {
      const { baseDir, fileSystem, logFile, lines, seed } = yield* setup;
      yield* seed(`${lines(twoRecords.records)}{"v":1,"se`);
      const state = yield* withStore(baseDir, (store) => store.state(threadId));
      assert.isNull(state.corruption);
      assert.strictEqual(state.lastSeq, 2);
      assert.strictEqual(yield* fileSystem.readFileString(logFile), lines(twoRecords.records));
    }),
  );

  it.effect("truncates a decodable final record that lacks its newline", () =>
    Effect.gen(function* () {
      const { baseDir, fileSystem, logFile, lines, seed } = yield* setup;
      const [first, second] = twoRecords.records;
      assert.isDefined(first);
      assert.isDefined(second);
      yield* seed(`${lines([first])}${JSON.stringify(second)}`);
      const state = yield* withStore(baseDir, (store) => store.state(threadId));
      assert.isNull(state.corruption);
      assert.strictEqual(state.lastSeq, 1);
      assert.strictEqual(toView(state).instances[0]?.steps[0]?.state._tag, "open");
      assert.strictEqual(yield* fileSystem.readFileString(logFile), lines([first]));
    }),
  );

  it.effect("marks the thread corrupt on a bad middle line and keeps the readable prefix", () =>
    Effect.gen(function* () {
      const { baseDir, lines, seed } = yield* setup;
      const [first, second] = twoRecords.records;
      assert.isDefined(first);
      assert.isDefined(second);
      yield* seed(`${lines([first])}not json\n${lines([second])}`);
      yield* withStore(baseDir, (store) =>
        Effect.gen(function* () {
          const state = yield* store.state(threadId);
          assert.strictEqual(state.corruption, "line 2 of its log is not JSON");
          assert.strictEqual(toView(state).activeInstanceId, "w1");
          assert.isNull(lifecycleBlocker(state, "settle"));
          const refused = yield* store.append(threadId, second).pipe(Effect.flip);
          assert.strictEqual(refused.code, "store_unavailable");
        }),
      );
    }),
  );

  it.effect("marks the thread corrupt on an unknown version or event kind", () =>
    Effect.gen(function* () {
      const { baseDir, lines, seed } = yield* setup;
      const [first] = twoRecords.records;
      assert.isDefined(first);
      const future = { ...first, seq: 2, v: 2 };
      yield* seed(`${lines([first])}${JSON.stringify(future)}\n`);
      const versioned = yield* withStore(baseDir, (store) => store.state(threadId));
      assert.strictEqual(versioned.corruption, "line 2 of its log has unknown version 2");

      const unknownKind = { ...first, seq: 2, event: { _tag: "paused", instanceId: "w1" } };
      yield* seed(`${lines([first])}${JSON.stringify(unknownKind)}\n`);
      const kinded = yield* withStore(baseDir, (store) => store.state(threadId));
      assert.strictEqual(
        kinded.corruption,
        "line 2 of its log is not a record this build understands",
      );
    }),
  );

  it.effect("replays a receipt across a reload", () =>
    Effect.gen(function* () {
      const { baseDir } = yield* setup;
      const noop = apply(
        twoRecords.state,
        agent,
        { _tag: "tick", stepId: "w1.1", comment: "again" },
        {
          requestId: "retry-1",
        },
      );
      assert.strictEqual(noop.record?.kind, "receipt");
      yield* withStore(baseDir, (store) =>
        appendAll(store, [...twoRecords.records, noop.record as ThreadWorkflowRecord]),
      );
      const reloaded = yield* withStore(baseDir, (store) => store.state(threadId));
      const replay = decide(
        reloaded,
        agent,
        request({ _tag: "tick", stepId: "w1.1", comment: "again" }),
        contextWith({ requestId: "retry-1" }),
      );
      assert.deepStrictEqual(replay, { _tag: "unchanged", replayed: true });
      const reused = decide(
        reloaded,
        agent,
        request({ _tag: "skip", stepId: "w1.2", reason: "different" }),
        contextWith({ requestId: "retry-1" }),
      );
      assert.strictEqual(reused._tag === "ThreadWorkflowError" && reused.code, "request_id_reused");
    }),
  );

  it.effect("marks the thread corrupt in memory when a write fails", () =>
    Effect.gen(function* () {
      const { baseDir, fileSystem, logFile } = yield* setup;
      yield* withStore(baseDir, (store) =>
        Effect.gen(function* () {
          // A directory where the log should be makes the append fail after a clean load.
          yield* fileSystem.makeDirectory(logFile, { recursive: true });
          const [first] = twoRecords.records;
          assert.isDefined(first);
          const failed = yield* store.append(threadId, first).pipe(Effect.flip);
          assert.strictEqual(failed.code, "store_unavailable");
          const state: ThreadWorkflowState = yield* store.state(threadId);
          assert.strictEqual(state.corruption, "a write did not complete");
          assert.isNull(lifecycleBlocker(state, "archive"));
        }),
      );
    }),
  );

  it.effect("recovers a corrupt log into a fresh one and keeps the old one beside it", () =>
    Effect.gen(function* () {
      const { baseDir, fileSystem, threadsDir, logFile, lines, seed } = yield* setup;
      const [first] = twoRecords.records;
      assert.isDefined(first);
      const broken = `${lines([first])}garbage "w4.2"\n`;
      yield* seed(broken);
      yield* withStore(baseDir, (store) =>
        Effect.gen(function* () {
          const corrupt = yield* store.state(threadId);
          const recovered = apply(corrupt, user, { _tag: "recover", reason: "log broke" });
          assert.isNotNull(recovered.record);
          yield* store.append(threadId, recovered.record as ThreadWorkflowRecord);
        }),
      );
      const reloaded = yield* withStore(baseDir, (store) => store.state(threadId));
      assert.isNull(reloaded.corruption);
      assert.strictEqual(toView(reloaded).instances.length, 0);
      assert.strictEqual(reloaded.nextInstanceNumber, 5);
      assert.strictEqual((yield* fileSystem.readFileString(logFile)).split("\n").length, 2);
      const aside = (yield* fileSystem.readDirectory(threadsDir)).filter((name) =>
        name.includes(".corrupt-"),
      );
      assert.strictEqual(aside.length, 1);
      assert.strictEqual(yield* fileSystem.readFileString(`${threadsDir}/${aside[0]}`), broken);
    }),
  );
});
