import {
  blockingProblems,
  type ClaudeSettings,
  FORK_SETTINGS_WS_METHODS,
  ForkSettingsError,
  type ForkSettingsPatch,
  type InstanceSettingsView,
  type LimbaseCompactionPatch,
  type ModelSelection,
  patchLimbaseCompaction,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderThreadId,
  type ThreadId,
  type ThreadSettingsView,
} from "@t3tools/contracts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
} from "../orchestration-v2/ProjectionStore.ts";
import {
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeModelCatalog,
  scopeClaudeModelCatalog,
  stripClaudeContextWindowSuffix,
} from "../provider/ClaudeModelCatalog.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { claudeSettingsOf, ForkSettingsStore, hasLimbaseHome, storeError } from "./ForkSettings.ts";
import * as Limbase from "./Limbase.ts";

const refusal = (message: string) => new ForkSettingsError({ message });

const handlersFor = Effect.fnUntraced(function* (
  store: ForkSettingsStore["Service"],
  catalogs: ModelCatalog.ModelCatalog["Service"],
) {
  const orchestrator = yield* OrchestratorV2;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const readSettings = serverSettings.getSettings.pipe(Effect.mapError(storeError));

  const catalogWindow = Effect.fn("ForkSettings.catalogWindow")(function* (
    claude: ClaudeSettings | undefined,
    modelSelection: ModelSelection,
  ) {
    const catalog = scopeClaudeModelCatalog(
      resolveClaudeModelCatalog(yield* catalogs.current(ProviderDriverKind.make("claudeAgent"))),
      claude?.customModels ?? [],
    );
    return resolveClaudeCatalogContextWindowTokens(catalog, modelSelection) ?? null;
  });

  const records = <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) =>
    orchestrator
      .getThreadRecords(threadId, fields, filter)
      .pipe(Effect.mapError(() => refusal(`No thread ${threadId}.`)));

  const reportedWindow = Effect.fn("ForkSettings.reportedWindow")(function* (
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    model: string,
  ) {
    const { providerTurns } = yield* records(threadId, ["providerTurns"], {
      providerTurnThreadIds: [providerThreadId],
      latestProviderTurnUsageOnly: true,
    });
    const [turn] = providerTurns;
    const maxTokens = turn?.tokenUsage?.maxTokens ?? 0;
    return turn?.model !== undefined &&
      stripClaudeContextWindowSuffix(turn.model) === stripClaudeContextWindowSuffix(model) &&
      maxTokens > 0
      ? maxTokens
      : null;
  });

  const limbaseThread = Effect.fn("ForkSettings.limbaseThread")(function* (threadId: ThreadId) {
    const { thread } = yield* records(threadId, []);
    const claude = claudeSettingsOf(yield* readSettings, thread.providerInstanceId);
    if (!hasLimbaseHome(claude)) return undefined;
    const activeId = thread.activeProviderThreadId;
    const active =
      activeId === null
        ? undefined
        : (yield* records(threadId, ["providerThreads"], {
            providerThreadIds: [activeId],
          })).providerThreads[0];
    const instance =
      (yield* store.read({ scope: "instance", id: thread.providerInstanceId })).limbaseCompaction ??
      {};
    const contextWindow =
      (yield* catalogWindow(claude, thread.modelSelection)) ??
      (activeId === null
        ? null
        : yield* reportedWindow(threadId, activeId, thread.modelSelection.model)) ??
      active?.contextUsage?.maxTokens ??
      null;
    return {
      claude,
      limbaseThreadId: active?.nativeMetadata?.limbaseThreadId,
      instance,
      stored: (yield* store.read({ scope: "thread", id: threadId })).limbaseCompaction ?? {},
      model: thread.modelSelection.model,
      contextWindow,
    };
  });

  const threadView = Effect.fn("ForkSettings.threadView")(function* (
    threadId: ThreadId,
    readHeld: (model: string) => boolean,
  ): Effect.fn.Return<ThreadSettingsView, ForkSettingsError> {
    const limbase = yield* limbaseThread(threadId);
    if (limbase === undefined) return {};
    return {
      limbaseCompaction: yield* Limbase.threadCompactionView({
        settings: limbase.claude,
        limbaseThreadId: limbase.limbaseThreadId,
        value: limbase.stored,
        instance: limbase.instance,
        model: limbase.model,
        contextWindow: limbase.contextWindow,
        readHeld: readHeld(limbase.model),
      }),
    };
  });

  const applyThreadCompaction = Effect.fn("ForkSettings.applyThreadCompaction")(function* (
    threadId: ThreadId,
    patch: LimbaseCompactionPatch,
  ) {
    const limbase = yield* limbaseThread(threadId);
    if (limbase === undefined) {
      return yield* refusal("Limbase compaction applies only to a thread on a Limbase instance.");
    }
    const value = patchLimbaseCompaction(limbase.stored, patch);
    const resolved = Limbase.resolveCompaction({
      thread: value,
      instance: limbase.instance,
      model: limbase.model,
      contextWindow: limbase.contextWindow,
    });
    const blocking = blockingProblems(resolved, "thread");
    if (blocking.length > 0) {
      return yield* refusal(blocking.map((problem) => problem.message).join(" "));
    }
    if (limbase.limbaseThreadId !== undefined && resolved.policy !== undefined) {
      yield* Limbase.applyPolicy(limbase.claude, limbase.limbaseThreadId, resolved.policy).pipe(
        Effect.mapError((error) => refusal(`Limbase: ${error.detail}`)),
      );
    }
    return value;
  });

  const instanceView = Effect.fn("ForkSettings.instanceView")(function* (
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<InstanceSettingsView, ForkSettingsError> {
    if (!hasLimbaseHome(claudeSettingsOf(yield* readSettings, instanceId))) return {};
    const stored = yield* store.read({ scope: "instance", id: instanceId });
    return {
      limbaseCompaction: {
        value: stored.limbaseCompaction ?? {},
        defaults: Limbase.COMPACTION_DEFAULTS,
      },
    };
  });

  const checkInstanceCompaction = Effect.fn("ForkSettings.checkInstanceCompaction")(function* (
    instanceId: ProviderInstanceId,
    patch: LimbaseCompactionPatch,
  ) {
    if (!hasLimbaseHome(claudeSettingsOf(yield* readSettings, instanceId))) {
      return yield* refusal(
        "Limbase compaction applies only to a Claude instance with a Limbase home.",
      );
    }
    const stored = yield* store.read({ scope: "instance", id: instanceId });
    const value = patchLimbaseCompaction(stored.limbaseCompaction ?? {}, patch);
    const resolved = Limbase.resolveCompaction({
      thread: {},
      instance: value,
      model: "",
      contextWindow: null,
    });
    const blocking = blockingProblems(resolved, "instance");
    if (blocking.length > 0) {
      return yield* refusal(blocking.map((problem) => problem.message).join(" "));
    }
    return value;
  });

  return {
    [FORK_SETTINGS_WS_METHODS.getThread]: (input: {
      readonly threadId: ThreadId;
      readonly shownModel?: string;
    }) => threadView(input.threadId, (model) => model !== input.shownModel),
    [FORK_SETTINGS_WS_METHODS.setThread]: Effect.fn("ForkSettings.setThread")(function* (input: {
      readonly threadId: ThreadId;
      readonly settings: ForkSettingsPatch;
    }) {
      const { limbaseCompaction } = input.settings;
      if (limbaseCompaction !== undefined) {
        yield* store.write(
          { scope: "thread", id: input.threadId },
          { limbaseCompaction: yield* applyThreadCompaction(input.threadId, limbaseCompaction) },
        );
      }
      return yield* threadView(input.threadId, () => false);
    }),
    [FORK_SETTINGS_WS_METHODS.getInstance]: (input: { readonly instanceId: ProviderInstanceId }) =>
      instanceView(input.instanceId),
    [FORK_SETTINGS_WS_METHODS.setInstance]: Effect.fn("ForkSettings.setInstance")(
      function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly settings: ForkSettingsPatch;
      }) {
        const { limbaseCompaction } = input.settings;
        if (limbaseCompaction !== undefined) {
          yield* store.write(
            { scope: "instance", id: input.instanceId },
            {
              limbaseCompaction: yield* checkInstanceCompaction(
                input.instanceId,
                limbaseCompaction,
              ),
            },
          );
        }
        return yield* instanceView(input.instanceId);
      },
    ),
  } as const;
});

const unavailable = () => Effect.fail(refusal("Thread settings are not available on this server."));

export const wsHandlers = Effect.gen(function* () {
  const store = yield* Effect.serviceOption(ForkSettingsStore);
  const catalogs = yield* Effect.serviceOption(ModelCatalog.ModelCatalog);
  if (Option.isSome(store) && Option.isSome(catalogs)) {
    return yield* handlersFor(store.value, catalogs.value);
  }
  return {
    [FORK_SETTINGS_WS_METHODS.getThread]: unavailable,
    [FORK_SETTINGS_WS_METHODS.setThread]: unavailable,
    [FORK_SETTINGS_WS_METHODS.getInstance]: unavailable,
    [FORK_SETTINGS_WS_METHODS.setInstance]: unavailable,
  } as const;
});
