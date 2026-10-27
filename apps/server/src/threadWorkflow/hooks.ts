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
        // The reminder names a start that `decideStart` refuses while the flag is off.
        if (!(yield* workflowsEnabled)) return "";
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
      turnNote: (input) =>
        guarded(
          "",
          "thread workflow turn note failed; the turn goes without it",
          input.threadId,
          () => (input.compacting ? Effect.succeed("") : noteFor(input)),
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
