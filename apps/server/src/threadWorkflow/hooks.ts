import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadHooks } from "../orchestration-v2/ThreadHooks.ts";
import { lifecycleBlocker, toSubscriptionView } from "./domain.ts";
import { ThreadWorkflowStore } from "./store.ts";
import { turnNote } from "./turnNote.ts";

/**
 * Core's view of the module. Both hooks read the store's memory and never take the thread lock,
 * which their callers already hold. The flag plays no part here: an instance that is open or
 * corrupt keeps blocking lifecycle actions and keeps reaching the agent after the flag turns off.
 */
export const layerThreadHooks = Layer.effect(
  ThreadHooks,
  Effect.gen(function* () {
    const store = yield* ThreadWorkflowStore;
    return {
      turnNote: ({ threadId, compacting }) =>
        compacting
          ? Effect.succeed("")
          : store.state(threadId).pipe(Effect.map((state) => turnNote(toSubscriptionView(state)))),
      lifecycleBlocker: ({ threadId, action }) =>
        store.state(threadId).pipe(Effect.map((state) => lifecycleBlocker(state, action))),
    };
  }),
);
