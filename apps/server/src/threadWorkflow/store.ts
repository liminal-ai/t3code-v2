/**
 * One JSONL log per thread under `<stateDir>/thread-workflows/threads/`, folded into memory at
 * layer build so readers never touch disk.
 *
 * Locking contract: the store takes no lock. Every call for one thread (read `state`, decide,
 * `append`, publish) must run inside `ThreadCommandExecutor.withLock(threadId)`, the lock every
 * orchestration dispatch for that thread holds. Two unserialized appends to one thread would both
 * claim the next seq. Server ownership guarantees one process writes the directory.
 */
import { ThreadWorkflowError, ThreadWorkflowRecord, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { emptyState, evolve, fold, markCorrupt, type ThreadWorkflowState } from "./domain.ts";

export class ThreadWorkflowStore extends Context.Service<
  ThreadWorkflowStore,
  {
    /**
     * Why the module is off, or null. Set at build when the threads directory exists but cannot be
     * read or folded; the server still starts. Every thread then reads as empty and nothing is
     * written until a restart.
     */
    readonly unavailable: string | null;
    /** The thread's folded state from memory; an empty state for a thread with no log. */
    readonly state: (threadId: ThreadId) => Effect.Effect<ThreadWorkflowState>;
    /** Every thread that has a log, for sweeps such as the inactivity ping. */
    readonly states: Effect.Effect<ReadonlyArray<ThreadWorkflowState>>;
    /**
     * Makes the record durable, then folds it into memory and returns the new state. A `recovered`
     * record sets the old log aside and starts a fresh one. A failed or timed-out write marks the
     * thread corrupt in memory until restart, because the disk may hold the record or not.
     */
    readonly append: (
      threadId: ThreadId,
      record: ThreadWorkflowRecord,
    ) => Effect.Effect<ThreadWorkflowState, ThreadWorkflowError>;
  }
>()("t3/threadWorkflow/store/ThreadWorkflowStore") {}

const LOG_SUFFIX = ".jsonl";
const WRITE_TIMEOUT = "10 seconds";
const NEWLINE = 0x0a;

const isSafeByte = (byte: number) =>
  (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d;

/**
 * `[a-z0-9-]` stays as is and every other byte becomes `_xx`, so names are reversible, safe on
 * every filesystem, and never collide on a case-insensitive one. UUID thread ids stay readable.
 */
export const threadLogFileName = (threadId: ThreadId): string => {
  let name = "";
  for (const byte of new TextEncoder().encode(threadId)) {
    name += isSafeByte(byte) ? String.fromCharCode(byte) : `_${byte.toString(16).padStart(2, "0")}`;
  }
  return `${name}${LOG_SUFFIX}`;
};

/** The inverse of `threadLogFileName`, or null for a file the store did not name. */
export const threadIdOfLogFileName = (fileName: string): ThreadId | null => {
  if (!fileName.endsWith(LOG_SUFFIX)) return null;
  const encoded = fileName.slice(0, -LOG_SUFFIX.length);
  if (encoded.length === 0 || !/^(?:[a-z0-9-]|_[0-9a-f]{2})+$/.test(encoded)) return null;
  const bytes: Array<number> = [];
  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] === "_") {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index));
    }
  }
  try {
    const threadId = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    return threadLogFileName(threadId as ThreadId) === fileName ? (threadId as ThreadId) : null;
  } catch {
    return null;
  }
};

const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeRecord = Schema.decodeUnknownExit(ThreadWorkflowRecord);
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(ThreadWorkflowRecord));

/** Every instance number any line mentions, readable or not, so a recovery never reuses one. */
const highestInstanceNumber = (text: string) => {
  let highest = 0;
  for (const match of text.matchAll(/"w([1-9]\d*)(?:\.[1-9]\d*)?"/g)) {
    highest = Math.max(highest, Number(match[1]));
  }
  return highest;
};

/** Folds the complete lines. The first line that is not a known record marks the thread corrupt. */
const parseLog = (threadId: ThreadId, text: string): ThreadWorkflowState => {
  const records: Array<ThreadWorkflowRecord> = [];
  const lines = text.split("\n").slice(0, -1);
  for (const [index, line] of lines.entries()) {
    const corrupt = (problem: string) =>
      markCorrupt(
        fold(threadId, records),
        `line ${index + 1} of its log ${problem}`,
        highestInstanceNumber(text) + 1,
      );
    const json = decodeJson(line);
    if (Exit.isFailure(json)) return corrupt("is not JSON");
    const version = (json.value as { readonly v?: unknown } | null)?.v;
    if (version !== 1) {
      return corrupt(
        typeof version === "number" ? `has unknown version ${version}` : "has no version",
      );
    }
    const decoded = decodeRecord(json.value);
    if (Exit.isFailure(decoded)) return corrupt("is not a record this build understands");
    if (decoded.value.seq !== records.length + 1) return corrupt("is out of sequence");
    records.push(decoded.value);
  }
  return fold(threadId, records);
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const rootDir = path.join(stateDir, "thread-workflows");
  const threadsDir = path.join(rootDir, "threads");

  // Opened read-write: Windows refuses to flush a handle without write access.
  const syncFile = (file: string) =>
    Effect.scoped(
      fileSystem.open(file, { flag: "r+" }).pipe(Effect.flatMap((handle) => handle.sync)),
    );

  // Windows has no directory fsync: the handle opens but sync fails with EPERM, and NTFS
  // journals the entry on its own.
  const syncDirectory = (directory: string) =>
    Effect.scoped(
      fileSystem.open(directory, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync)),
    ).pipe(
      Effect.catchIf(
        (error: PlatformError.PlatformError) => error.reason._tag === "PermissionDenied",
        () => Effect.void,
      ),
    );

  const writeDurably = (file: string, bytes: Uint8Array, flag: "a" | "w") =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fileSystem.open(file, { flag, mode: 0o600 });
        yield* handle.writeAll(bytes);
        yield* handle.sync;
      }),
    );

  const loadThread = (threadId: ThreadId, file: string) =>
    Effect.gen(function* () {
      const bytes = yield* fileSystem.readFile(file);
      const complete = bytes.lastIndexOf(NEWLINE) + 1;
      // A final segment without its newline was never acknowledged, decodable or not.
      if (complete < bytes.length) {
        yield* fileSystem.truncate(file, complete);
        yield* syncFile(file);
      }
      return parseLog(threadId, new TextDecoder().decode(bytes.subarray(0, complete)));
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("thread workflow log unreadable", { threadId, cause }).pipe(
          Effect.as(markCorrupt(emptyState(threadId), "its log could not be read")),
        ),
      ),
    );

  const loaded = yield* Effect.gen(function* () {
    if (!(yield* fileSystem.exists(threadsDir))) return new Map<ThreadId, ThreadWorkflowState>();
    const states = new Map<ThreadId, ThreadWorkflowState>();
    for (const fileName of yield* fileSystem.readDirectory(threadsDir)) {
      const threadId = threadIdOfLogFileName(fileName);
      if (threadId === null) continue;
      states.set(threadId, yield* loadThread(threadId, path.join(threadsDir, fileName)));
    }
    return states;
  }).pipe(
    Effect.map((states) => ({ states, unavailable: null })),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logError("thread workflow module disabled: its logs could not be loaded", {
            directory: threadsDir,
            cause,
          }).pipe(
            Effect.as({
              states: new Map<ThreadId, ThreadWorkflowState>(),
              unavailable: `The thread workflow logs in ${threadsDir} could not be loaded when the server started, so thread workflows are unavailable until it restarts.`,
            }),
          ),
    ),
  );

  const states = yield* Ref.make<ReadonlyMap<ThreadId, ThreadWorkflowState>>(loaded.states);
  const directoriesReady = yield* Ref.make(false);

  const ensureDirectories = Effect.gen(function* () {
    if (yield* Ref.get(directoriesReady)) return;
    yield* fileSystem.makeDirectory(threadsDir, { recursive: true });
    for (const directory of [threadsDir, rootDir, stateDir]) yield* syncDirectory(directory);
    yield* Ref.set(directoriesReady, true);
  });

  const write = (threadId: ThreadId, record: ThreadWorkflowRecord) =>
    Effect.gen(function* () {
      yield* ensureDirectories;
      const file = path.join(threadsDir, threadLogFileName(threadId));
      const bytes = new TextEncoder().encode(`${yield* encodeLine(record).pipe(Effect.orDie)}\n`);
      if (record.kind === "change" && record.event._tag === "recovered") {
        const recovering = `${file}.recovering`;
        // Copy, not rename, so a crash at any point leaves either the old log live or the new one.
        if (yield* fileSystem.exists(file)) {
          const aside = `${file}.corrupt-${record.at.replace(/[^0-9A-Za-z]/g, "")}`;
          yield* fileSystem.copyFile(file, aside);
          yield* syncFile(aside);
        }
        yield* writeDurably(recovering, bytes, "w");
        yield* fileSystem.rename(recovering, file);
        yield* syncDirectory(threadsDir);
        return;
      }
      const created = !(yield* fileSystem.exists(file));
      yield* writeDurably(file, bytes, "a");
      if (created) yield* syncDirectory(threadsDir);
    });

  const stateOf = (map: ReadonlyMap<ThreadId, ThreadWorkflowState>, threadId: ThreadId) =>
    map.get(threadId) ?? emptyState(threadId);

  const unavailable = (message: string) =>
    new ThreadWorkflowError({ code: "store_unavailable", message });

  const append = (threadId: ThreadId, record: ThreadWorkflowRecord) =>
    Effect.gen(function* () {
      if (loaded.unavailable !== null) return yield* unavailable(loaded.unavailable);
      const current = stateOf(yield* Ref.get(states), threadId);
      const recovering = record.kind === "change" && record.event._tag === "recovered";
      if (current.corruption !== null && !recovering) {
        return yield* unavailable(
          `This thread's workflow log cannot be trusted (${current.corruption}), so nothing more is written to it. The user can recover it from the Workflow tab on web or desktop.`,
        );
      }
      const expectedSeq = recovering ? 1 : current.lastSeq + 1;
      if (record.seq !== expectedSeq) {
        return yield* Effect.die(
          new Error(`thread workflow record seq ${record.seq}, expected ${expectedSeq}`),
        );
      }
      return yield* Effect.uninterruptibleMask((restore) =>
        restore(write(threadId, record).pipe(Effect.timeout(WRITE_TIMEOUT))).pipe(
          Effect.matchCauseEffect({
            onSuccess: () =>
              Ref.modify(states, (map) => {
                const next = evolve(stateOf(map, threadId), record);
                return [next, new Map(map).set(threadId, next)];
              }),
            onFailure: (cause) =>
              Effect.logWarning("thread workflow write failed", { threadId, cause }).pipe(
                Effect.andThen(
                  Ref.update(states, (map) =>
                    new Map(map).set(
                      threadId,
                      markCorrupt(stateOf(map, threadId), "a write did not complete"),
                    ),
                  ),
                ),
                Effect.andThen(
                  Effect.fail(
                    unavailable(
                      "The workflow write did not complete, so this thread's workflow is read-only until the server restarts.",
                    ),
                  ),
                ),
              ),
          }),
        ),
      );
    });

  return ThreadWorkflowStore.of({
    unavailable: loaded.unavailable,
    state: (threadId) => Ref.get(states).pipe(Effect.map((map) => stateOf(map, threadId))),
    states: Ref.get(states).pipe(Effect.map((map) => [...map.values()])),
    append,
  });
});

export const layer = Layer.effect(ThreadWorkflowStore, make);
