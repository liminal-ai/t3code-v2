import type { ThreadId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { failOpen, HOOK_DEADLINE, ThreadHooks } from "../orchestration-v2/ThreadHooks.ts";
import * as ServerSettings from "../serverSettings.ts";
import { lifecycleBlocker, toSubscriptionView } from "./domain.ts";
import { ThreadWorkflowStore } from "./store.ts";
import { turnNote } from "./turnNote.ts";

/**
 * Core's view of the module. Both hooks read the store's memory and never take the thread lock:
 * the orchestrator's guard holds it already, and the turn note runs without it and may lag a write
 * by a moment. The flag plays no part here: an open instance keeps blocking lifecycle actions and
 * keeps reaching the agent after the flag turns off.
 *
 * The module must never stop a turn or trap a thread, so any fault in either hook (a defect
 * included) and any stall past `HOOK_DEADLINE` fall back to no note and no blocker, with a warning.
 * Interruption still passes through.
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

    const guarded = <A, E>(
      fallback: A,
      message: string,
      threadId: ThreadId,
      compute: () => Effect.Effect<A, E>,
    ): Effect.Effect<A> =>
      failOpen(Effect.suspend(compute), {
        deadline: HOOK_DEADLINE,
        fallback,
        message,
        annotations: { threadId },
      });

    return {
      turnNote: ({ threadId, compacting }) =>
        guarded("", "thread workflow turn note failed; the turn goes without it", threadId, () =>
          compacting
            ? Effect.succeed("")
            : store
                .state(threadId)
                .pipe(Effect.map((state) => turnNote(toSubscriptionView(state)))),
        ),
      lifecycleBlocker: ({ threadId, action }) =>
        guarded<string | null, unknown>(
          null,
          "thread workflow lifecycle check failed; the thread is not blocked",
          threadId,
          () =>
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
            }),
        ),
    };
  }),
);
