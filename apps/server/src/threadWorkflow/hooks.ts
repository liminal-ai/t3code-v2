import type {
  RunId,
  ThreadId,
  ThreadWorkflowInstanceId,
  ThreadWorkflowStepId,
  ThreadWorkflowStepSummary,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  failOpen,
  HOOK_DEADLINE,
  ThreadHooks,
  type TurnNoteInput,
} from "../orchestration-v2/ThreadHooks.ts";
import * as ServerSettings from "../serverSettings.ts";

type LifecycleInput = Parameters<(typeof ThreadHooks)["Service"]["lifecycleBlocker"]>[0];
import { lifecycleBlocker, toSubscriptionView } from "./domain.ts";
import { ThreadWorkflowStore } from "./store.ts";
import { noWorkflowNote, openStep, turnNote } from "./turnNote.ts";

interface LastFullNote {
  readonly instanceId: ThreadWorkflowInstanceId;
  readonly stepId: ThreadWorkflowStepId;
  readonly stepKey: string;
  readonly contextKey: string;
  readonly runId: RunId;
}

const stepKey = (step: ThreadWorkflowStepSummary) =>
  JSON.stringify([
    step.title,
    step.instructions,
    step.proofLevel,
    step.proofHint ?? null,
    step.waitsForUser,
  ]);

const contextKey = (context: TurnNoteInput["context"]) =>
  [context.providerThreadId, context.nativeThreadId ?? "", context.model, context.compactions].join(
    "\n",
  );

const PSTACK_TEXT = /\/poteto-mode|poteto[ -]mode/i;

const isSkillRecord = (record: unknown, name: string) =>
  typeof record === "object" &&
  record !== null &&
  "kind" in record &&
  record.kind === "skill" &&
  "name" in record &&
  record.name === name;

const asksForPstack = (message: TurnNoteInput["message"]) =>
  message.role === "user" &&
  (PSTACK_TEXT.test(message.text) ||
    (message.context?.records ?? []).some((record) => isSkillRecord(record, "poteto-mode")));

/**
 * Core's view of the module. Both hooks read memory without the thread lock, and an open instance
 * keeps blocking after the flag turns off. A fault or a stall past `HOOK_DEADLINE`, never an
 * interrupt, gives no note and no blocker, with a warning. `threadWorkflowEnforcementDisabled` in
 * settings or `T3CODE_THREAD_WORKFLOW_ENFORCEMENT=off` stops enforcement without a rebuild.
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
    const workflowsEnabled = settings.getSettings.pipe(
      Effect.map((current) => current.threadWorkflowsEnabled),
    );
    const warned = yield* Ref.make<ReadonlySet<string>>(new Set());
    const lastFullNotes = yield* Ref.make<ReadonlyMap<ThreadId, LastFullNote>>(new Map());

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

    const noteFor = Effect.fn("threadWorkflow.hooks.noteFor")(function* (input: TurnNoteInput) {
      const state = yield* store.state(input.threadId);
      const view = toSubscriptionView(state);
      if (view.corruption !== null) return turnNote(view, "full");
      const current = openStep(view);
      if (current === null) {
        const note = turnNote(view, "full");
        if (note !== "") return note;
        // The reminder names a start the service refuses while the flag is off or the store
        // could not load its logs.
        if (store.unavailable !== null || !(yield* workflowsEnabled)) return "";
        const marked = (yield* store.pstackThreads).has(input.threadId);
        if (state.instances.length > 0 || marked) return noWorkflowNote();
        if (!asksForPstack(input.message)) return "";
        yield* Effect.forkDetach(store.markPstackThread(input.threadId));
        return noWorkflowNote();
      }
      const key = {
        instanceId: current.instance.id,
        stepId: current.step.id,
        stepKey: stepKey(current.step),
        contextKey: contextKey(input.context),
      };
      const last = (yield* Ref.get(lastFullNotes)).get(input.threadId);
      const agentHasIt =
        last !== undefined &&
        last.instanceId === key.instanceId &&
        last.stepId === key.stepId &&
        last.stepKey === key.stepKey &&
        last.contextKey === key.contextKey &&
        input.completedRunIds.has(last.runId);
      if (agentHasIt) return turnNote(view, "short");
      yield* Ref.update(lastFullNotes, (map) =>
        new Map(map).set(input.threadId, { ...key, runId: input.runId }),
      );
      return turnNote(view, "full");
    });

    return {
      turnNote: Effect.fn("ThreadHooks.turnNote")((input: TurnNoteInput) =>
        guarded(
          "",
          "thread workflow turn note failed; the turn goes without it",
          input.threadId,
          () => (input.compacting ? Effect.succeed("") : noteFor(input)),
        ),
      ),
      lifecycleBlocker: Effect.fn("ThreadHooks.lifecycleBlocker")(
        ({ threadId, action }: LifecycleInput) =>
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
      ),
    };
  }),
);
