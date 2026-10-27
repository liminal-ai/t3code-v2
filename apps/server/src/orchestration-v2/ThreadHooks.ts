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
 * What core asks of an optional thread module (the fork's workflow module).
 * The default is inert, so a build without the module behaves as before.
 *
 * Both methods read memory only (never disk) and never take the thread's
 * dispatch lock, which is not reentrant. The orchestrator asks `lifecycleBlocker`
 * under that lock, where its answer is authoritative; the settle sweep, the
 * agent's early self-settle check and the project-delete preflight ask without
 * it, as a prefilter the guard repeats. `turnNote` runs from the
 * `provider-turn.start` outbox handler without the lock, so it may show a step
 * that changed a moment ago, which is acceptable: the next turn shows the
 * current one. Neither may fail or stall: a module fault must not stop a turn
 * or wedge a lifecycle command. `failOpen` is that promise as a combinator, and
 * core applies it at each call site over whatever containment the module brings.
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
    /** Compaction turn items so far, plus typed /compact messages. */
    readonly compactions: number;
  };
  /** Runs whose provider turn completed, so a note they carried was read. */
  readonly completedRunIds: ReadonlySet<RunId>;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "role" | "text" | "context">
  >;
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
 * Runs `effect` under a deadline that holds even when the work cannot be interrupted.
 * `Effect.timeout` interrupts the work and then waits for it to finish, and a filesystem call
 * inside `acquireRelease` finishes only when the OS answers, so a stalled disk would hold the
 * caller past any deadline. Here the work runs in its own detached fiber and the deadline stops
 * only the wait: `None` means the work did not finish in time. It is told to stop without being
 * waited for, so an uninterruptible region inside it runs to its end unobserved, and its result
 * is never read. Interrupting the caller does the same.
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
