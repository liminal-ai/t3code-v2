import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ThreadHooks } from "../orchestration-v2/ThreadHooks.ts";
import { lifecycleBlocker, toSubscriptionView } from "./domain.ts";
import { ThreadWorkflowStore } from "./store.ts";
import { turnNote } from "./turnNote.ts";

/**
 * Core's view of the module. Both hooks read the store's memory and never take the thread lock,
 * which their callers already hold. The flag plays no part here: an open instance keeps blocking
 * lifecycle actions and keeps reaching the agent after the flag turns off.
 *
 * The module must never stop a turn or trap a thread, so any fault in either hook (a defect
 * included) falls back to no note and no blocker. Interruption still passes through.
 */
export const layerThreadHooks = Layer.effect(
  ThreadHooks,
  Effect.gen(function* () {
    const store = yield* ThreadWorkflowStore;
    const warned = yield* Ref.make<ReadonlySet<string>>(new Set());

    const warnOnce = (key: string, message: string, threadId: ThreadId) =>
      Ref.modify(warned, (keys) =>
        keys.has(key) ? [false, keys] : [true, new Set(keys).add(key)],
      ).pipe(
        Effect.flatMap((first) => (first ? Effect.logWarning(message, { threadId }) : Effect.void)),
      );

    const orElse =
      <A>(fallback: A, message: string, threadId: ThreadId) =>
      (self: Effect.Effect<A>): Effect.Effect<A> =>
        Effect.suspend(() => self).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logWarning(message, { threadId, cause }).pipe(Effect.as(fallback)),
          ),
        );

    return {
      turnNote: ({ threadId, compacting }) =>
        (compacting
          ? Effect.succeed("")
          : store.state(threadId).pipe(Effect.map((state) => turnNote(toSubscriptionView(state))))
        ).pipe(orElse("", "thread workflow turn note failed; the turn goes without it", threadId)),
      lifecycleBlocker: ({ threadId, action }) =>
        Effect.gen(function* () {
          const state = yield* store.state(threadId);
          if (state.corruption !== null) {
            yield* warnOnce(
              `corrupt:${threadId}`,
              "thread workflow log is corrupt; it does not block the thread's lifecycle",
              threadId,
            );
          }
          return lifecycleBlocker(state, action);
        }).pipe(
          orElse<string | null>(
            null,
            "thread workflow lifecycle check failed; the thread is not blocked",
            threadId,
          ),
        ),
    };
  }),
);
