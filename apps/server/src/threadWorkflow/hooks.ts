import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ThreadHooks } from "../orchestration-v2/ThreadHooks.ts";
import * as ServerSettings from "../serverSettings.ts";
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
 *
 * The operator can switch enforcement off without a rebuild: `threadWorkflowEnforcementDisabled`
 * in settings, read on every check, or `T3CODE_THREAD_WORKFLOW_ENFORCEMENT=off` in the
 * environment, which works even when settings cannot be edited or read.
 */
export const layerThreadHooks = Layer.effect(
  ThreadHooks,
  Effect.gen(function* () {
    const store = yield* ThreadWorkflowStore;
    const settings = yield* ServerSettings.ServerSettingsService;
    const enforcementOffByEnv = yield* Config.String("T3CODE_THREAD_WORKFLOW_ENFORCEMENT").pipe(
      Config.option,
      Effect.map(Option.exists((value) => value.trim().toLowerCase() === "off")),
      Effect.orElseSucceed(() => false),
    );
    const enforcementOff = enforcementOffByEnv
      ? Effect.succeed(true)
      : settings.getSettings.pipe(
          Effect.map((current) => current.threadWorkflowEnforcementDisabled),
        );
    const warned = yield* Ref.make<ReadonlySet<string>>(new Set());

    const warnOnce = (key: string, message: string, threadId: ThreadId) =>
      Ref.modify(warned, (keys) =>
        keys.has(key) ? [false, keys] : [true, new Set(keys).add(key)],
      ).pipe(
        Effect.flatMap((first) => (first ? Effect.logWarning(message, { threadId }) : Effect.void)),
      );

    const orElse =
      <A>(fallback: A, message: string, threadId: ThreadId) =>
      <E>(self: Effect.Effect<A, E>): Effect.Effect<A> =>
        Effect.suspend(() => self).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning(message, { threadId, cause }).pipe(Effect.as(fallback)),
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
          const blocker = lifecycleBlocker(state, action);
          if (blocker === null || !(yield* enforcementOff)) return blocker;
          yield* warnOnce(
            `bypassed:${threadId}`,
            "thread workflow enforcement is off; an open workflow does not block the thread",
            threadId,
          );
          return null;
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
