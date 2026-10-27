import type {
  OrchestrationV2ConversationMessage,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

/**
 * What core asks of an optional thread module; the default is inert. Both methods read memory only
 * and never take the thread's dispatch lock, which is not reentrant. Only the orchestrator's answer
 * under that lock is authoritative; other callers prefilter. Neither may fail or stall a turn or a
 * lifecycle command, so core wraps each call site in `failOpen`.
 */
/** Core's side of the turn note: what anchors the agent's context, and what it has already read. */
export interface TurnNoteInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly compacting: boolean;
  /** A change in any field means the agent may have lost what an earlier note carried. */
  readonly context: {
    readonly providerThreadId: ProviderThreadId;
    readonly nativeThreadId: string | null;
    /** The run's model selection as one string. */
    readonly model: string;
    /** Compaction turn items across the thread so far, plus typed /compact messages. */
    readonly compactions: number;
  };
  /** Runs whose provider turn completed, so a note they carried was read. */
  readonly completedRunIds: ReadonlySet<RunId>;
  /** The run's own user message. */
  readonly message: Pick<OrchestrationV2ConversationMessage, "role" | "text" | "context">;
}

export class ThreadHooks extends Context.Reference<{
  /** Prepended to the first provider turn of a root run, or "". */
  readonly turnNote: (input: TurnNoteInput) => Effect.Effect<string>;
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

/**
 * How long a hook, or a check that gates a turn the same way, may take. A hook reads memory and
 * at most the settings cache, which answers in microseconds once warm and in milliseconds when it
 * reads two small files cold, so two seconds is never reached on a working machine. It is also
 * the longest a settle, archive or delete may wait on the module before going ahead without it.
 */
export const HOOK_DEADLINE: Duration.Input = "2 seconds";

/**
 * Runs `effect` under a deadline that holds even when the work cannot be interrupted, as a stalled
 * disk inside `acquireRelease` would hold `Effect.timeout` past it. The work runs in a detached
 * fiber and the deadline stops only the wait: `None` means it did not finish in time, and it is
 * told to stop without being waited for. Interrupting the caller does the same.
 */
export const withinDeadline = Effect.fn("threadHooks.withinDeadline")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadline: Duration.Input,
): Effect.fn.Return<Option.Option<Exit.Exit<A, E>>, never, R> {
  const fiber = yield* Effect.forkDetach(effect);
  const stop = Effect.asVoid(Effect.forkDetach(Fiber.interrupt(fiber)));
  return yield* Fiber.await(fiber).pipe(
    Effect.timeoutOption(deadline),
    Effect.tap((result) => (Option.isNone(result) ? stop : Effect.void)),
    Effect.onInterrupt(() => stop),
  );
});

/**
 * Makes `effect` total and bounded: it answers by `deadline`, and a typed failure, a defect or
 * the deadline yields `fallback` after one warning. Interruption of the caller passes through.
 */
export const failOpen = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: {
    readonly deadline: Duration.Input;
    readonly fallback: A;
    /** What failed and what happens instead, for the warning. */
    readonly message: string;
    readonly annotations?: Record<string, unknown>;
  },
): Effect.Effect<A, never, R> =>
  withinDeadline(effect, options.deadline).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning(options.message, {
            ...options.annotations,
            timeout: Duration.format(Duration.fromInputUnsafe(options.deadline)),
          }).pipe(Effect.as(options.fallback)),
        onSome: Exit.match({
          onSuccess: Effect.succeed,
          onFailure: (cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning(options.message, { ...options.annotations, cause }).pipe(
                  Effect.as(options.fallback),
                ),
        }),
      }),
    ),
  );
