/**
 * The one write path for a thread's workflows. Every write runs under the thread's dispatch lock,
 * the same `ThreadCommandExecutor` every orchestration command for that thread holds, so a `start`
 * and a `thread.settle` serialize: whichever runs first makes the other refuse. Reads come from the
 * store's memory. Subscribers hear about a change only after its record is durable.
 */
import {
  isThreadWorkflowError,
  ThreadWorkflowError,
  type ThreadId,
  type ThreadWorkflowActor,
  type ThreadWorkflowApplyResult,
  type ThreadWorkflowRequest,
  type ThreadWorkflowSubscriptionState,
  type ThreadWorkflowTemplateId,
  type ThreadWorkflowTemplateSummary,
  type ThreadWorkflowView,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
// @effect-diagnostics nodeBuiltinImport:off - the playbook dir is under the user's home.
import * as NodeOS from "node:os";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { withinDeadline } from "../orchestration-v2/ThreadHooks.ts";
import * as ServerSettings from "../serverSettings.ts";
import { decide, recordFor, toSubscriptionView, toView, type ResolvedTemplate } from "./domain.ts";
import { ThreadWorkflowStore } from "./store.ts";
import { builtInTemplates, freshness } from "./templates/index.ts";

export interface ThreadWorkflowApplyOptions {
  /** Binds a retry to its first result. The pane always sends one; agents may omit it. */
  readonly requestId?: string | undefined;
  /** The pane's stale-view check. Agents may omit it. */
  readonly expectedRevision?: number | undefined;
}

export class ThreadWorkflowService extends Context.Service<
  ThreadWorkflowService,
  {
    readonly apply: (
      actor: ThreadWorkflowActor,
      threadId: ThreadId,
      request: ThreadWorkflowRequest,
      options?: ThreadWorkflowApplyOptions,
    ) => Effect.Effect<ThreadWorkflowApplyResult, ThreadWorkflowError>;
    /** Every instance with full history, from memory. */
    readonly view: (threadId: ThreadId) => Effect.Effect<ThreadWorkflowView, ThreadWorkflowError>;
    /** The history-free view with the flag and whether the pane should show the tab. */
    readonly state: (threadId: ThreadId) => Effect.Effect<ThreadWorkflowSubscriptionState>;
    /** `state` now, then again after every durable change to the thread or to the flag. */
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<ThreadWorkflowSubscriptionState>;
    readonly templates: Effect.Effect<ReadonlyArray<ThreadWorkflowTemplateSummary>>;
    readonly enabled: Effect.Effect<boolean>;
  }
>()("t3/threadWorkflow/ThreadWorkflowService") {}

const NO_TEMPLATES: ReadonlyMap<ThreadWorkflowTemplateId, ResolvedTemplate> = new Map();
const templateList = [...builtInTemplates.values()];
/**
 * What `apply` reads under the thread lock before it decides: the settings cache, one projection
 * row and a hash of each template's playbook file. Each answers in milliseconds, so five seconds
 * only passes when a disk or the database has stopped answering, and it caps how long a stalled
 * dependency holds the thread lock.
 */
const DEPENDENCY_DEADLINE = "5 seconds";

/** Only these consult the thread's lifecycle, so only they pay for the projection read. */
const needsThreadState = (request: ThreadWorkflowRequest) =>
  request._tag === "start" || (request._tag === "reopen" && !request.target.includes("."));

const make = Effect.gen(function* () {
  const store = yield* ThreadWorkflowStore;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const playbookDir = path.join(NodeOS.homedir(), ".agents", "skills");
  const changes = yield* PubSub.unbounded<ThreadId>();

  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.threadWorkflowsEnabled),
    Effect.orDie,
  );

  // Missing from the projection counts as not active: nothing may start on a thread core cannot see.
  const threadActive = (threadId: ThreadId) =>
    projections.getThread(threadId).pipe(
      Effect.map(
        (thread) =>
          thread.deletedAt === null &&
          thread.archivedAt === null &&
          thread.settledAt === null &&
          thread.settledOverride !== "settled",
      ),
      Effect.orElseSucceed(() => false),
    );

  const resolvedTemplates = Effect.forEach(templateList, (template) =>
    freshness(template, playbookDir).pipe(
      Effect.map((fresh): ResolvedTemplate => ({ template, freshness: fresh })),
    ),
  ).pipe(
    Effect.map(
      (resolved) =>
        new Map<ThreadWorkflowTemplateId, ResolvedTemplate>(
          resolved.map((entry) => [entry.template.id, entry]),
        ),
    ),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const stateOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const [current, flag] = yield* Effect.all([store.state(threadId), enabled]);
      const view = toSubscriptionView(current);
      return {
        enabled: flag,
        visible: flag || view.corruption !== null || view.activeInstanceId !== null,
        unavailable: store.unavailable,
        view,
      } satisfies ThreadWorkflowSubscriptionState;
    });

  /** A dependency that does not answer in time fails the request instead of holding the lock. */
  const awaited = <A, E>(
    what: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ThreadWorkflowError> =>
    withinDeadline(effect, DEPENDENCY_DEADLINE).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ThreadWorkflowError({
                code: "store_unavailable",
                message: `${what} did not answer within ${DEPENDENCY_DEADLINE}, so this workflow request was not applied. Try again.`,
              }),
            ),
          onSome: (exit): Effect.Effect<A, E | ThreadWorkflowError> => exit,
        }),
      ),
    );

  const whenAvailable = <A, R>(
    effect: Effect.Effect<A, ThreadWorkflowError, R>,
  ): Effect.Effect<A, ThreadWorkflowError, R> =>
    store.unavailable === null
      ? effect
      : Effect.fail(
          new ThreadWorkflowError({ code: "store_unavailable", message: store.unavailable }),
        );

  const apply: ThreadWorkflowService["Service"]["apply"] = (
    actor,
    threadId,
    request,
    options = {},
  ) =>
    whenAvailable(
      executor.withLock(
        threadId,
        Effect.gen(function* () {
          const state = yield* store.state(threadId);
          const decision = decide(state, actor, request, {
            requestId: options.requestId ?? null,
            expectedRevision: options.expectedRevision ?? null,
            enabled: yield* awaited("Server settings", enabled),
            threadActive: needsThreadState(request)
              ? yield* awaited("The thread's state", threadActive(threadId))
              : true,
            templates:
              request._tag === "start"
                ? yield* awaited("The workflow templates", resolvedTemplates)
                : NO_TEMPLATES,
          });
          if (isThreadWorkflowError(decision)) return yield* decision;
          const record = recordFor(state, actor, request, decision, {
            requestId: options.requestId ?? null,
            at: DateTime.formatIso(yield* DateTime.now),
          });
          const next = record === null ? state : yield* store.append(threadId, record);
          if (record !== null) yield* PubSub.publish(changes, threadId);
          return {
            changed: decision._tag === "changed",
            replayed: decision._tag === "unchanged" && decision.replayed,
            view: toSubscriptionView(next),
          };
        }),
      ),
    ).pipe(Effect.withSpan("threadWorkflow.apply", { attributes: { threadId } }));

  const subscribe: ThreadWorkflowService["Service"]["subscribe"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot so a change landing between the two is buffered, not lost.
        const subscription = yield* PubSub.subscribe(changes);
        const settingsChanges = yield* settings.subscribeChanges;
        return Stream.concat(
          Stream.fromEffect(stateOf(threadId)),
          Stream.merge(
            Stream.fromSubscription(subscription).pipe(Stream.filter((id) => id === threadId)),
            settingsChanges,
          ).pipe(Stream.mapEffect(() => stateOf(threadId))),
        );
      }),
    );

  const templates = resolvedTemplates.pipe(
    Effect.map((resolved) =>
      [...resolved.values()].map(
        ({ template, freshness: fresh }): ThreadWorkflowTemplateSummary => ({
          id: template.id,
          version: template.version,
          title: template.title,
          description: template.description,
          stepCount: template.steps.length,
          freshness: fresh,
        }),
      ),
    ),
  );

  return ThreadWorkflowService.of({
    apply,
    view: (threadId) => whenAvailable(store.state(threadId).pipe(Effect.map(toView))),
    state: stateOf,
    subscribe,
    templates,
    enabled,
  });
});

export const layer = Layer.effect(ThreadWorkflowService, make);
