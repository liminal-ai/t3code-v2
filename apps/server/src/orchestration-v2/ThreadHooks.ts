import type { RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * What core asks of an optional thread module (the fork's workflow module).
 * The default is inert, so a build without the module behaves as before.
 *
 * Both methods run on paths that hold the thread's dispatch lock, so they read
 * memory only (never disk) and never take that lock themselves; the lock is not
 * reentrant. Neither may fail: a module fault must not stop a turn or wedge a
 * lifecycle command.
 */
export class ThreadHooks extends Context.Reference<{
  /** Prepended to the first provider turn of a root run, or "". */
  readonly turnNote: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly compacting: boolean;
  }) => Effect.Effect<string>;
  /**
   * Why the thread may not take this action, worded to follow "Thread <id> ",
   * or null. An implementation that cannot tell returns null: a module fault
   * must never trap a thread.
   */
  readonly lifecycleBlocker: (input: {
    readonly threadId: ThreadId;
    readonly action: "settle" | "archive" | "delete";
  }) => Effect.Effect<string | null>;
}>("t3/orchestration-v2/ThreadHooks", {
  defaultValue: () => ({
    turnNote: () => Effect.succeed(""),
    lifecycleBlocker: () => Effect.succeed(null),
  }),
}) {}

/** The lifecycle commands a thread module may refuse, by the hook action each asks about. */
export const lifecycleActionOf = {
  "thread.settle": "settle",
  "thread.archive": "archive",
  "thread.delete": "delete",
} as const;
