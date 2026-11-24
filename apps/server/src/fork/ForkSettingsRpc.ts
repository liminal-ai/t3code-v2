import {
  blockingProblems,
  type ClaudeSettings,
  FORK_SETTINGS_WS_METHODS,
  ForkSettingsError,
  type ForkSettingsGroups,
  type InstanceSettingsView,
  type LimbaseCompaction,
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
  type ThreadSettingsView,
} from "@t3tools/contracts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeModelCatalog,
  scopeClaudeModelCatalog,
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

  const limbaseThread = Effect.fn("ForkSettings.limbaseThread")(function* (threadId: ThreadId) {
    const { thread, providerThreads } = yield* orchestrator
      .getThreadRecords(threadId, ["providerThreads"], { turnItemTypes: [] })
      .pipe(Effect.mapError(() => refusal(`No thread ${threadId}.`)));
    const active = providerThreads.find((row) => row.id === thread.activeProviderThreadId);
    const claude = claudeSettingsOf(yield* readSettings, thread.providerInstanceId);
    const limbaseThreadId = active?.nativeMetadata?.limbaseThreadId;
    if (limbaseThreadId === undefined && !hasLimbaseHome(claude)) return undefined;
    const instance =
      (yield* store.read({ scope: "instance", id: thread.providerInstanceId })).limbaseCompaction ??
      {};
    return {
      claude,
      limbaseThreadId,
      instance,
      model: thread.modelSelection.model,
      contextWindow:
        (yield* catalogWindow(claude, thread.modelSelection)) ??
        active?.contextUsage?.maxTokens ??
        null,
    };
  });

  const threadView = Effect.fn("ForkSettings.threadView")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<ThreadSettingsView, ForkSettingsError> {
    const limbase = yield* limbaseThread(threadId);
    if (limbase === undefined) return {};
    const value = (yield* store.read({ scope: "thread", id: threadId })).limbaseCompaction ?? {};
    return {
      limbaseCompaction: yield* Limbase.threadCompactionView({
        settings: limbase.claude,
        limbaseThreadId: limbase.limbaseThreadId,
        value,
        instance: limbase.instance,
        model: limbase.model,
        contextWindow: limbase.contextWindow,
      }),
    };
  });

  const applyThreadCompaction = Effect.fn("ForkSettings.applyThreadCompaction")(function* (
    threadId: ThreadId,
    value: LimbaseCompaction,
  ) {
    const limbase = yield* limbaseThread(threadId);
    if (limbase === undefined) {
      return yield* refusal("Limbase compaction applies only to a thread on a Limbase instance.");
    }
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
    if (limbase.limbaseThreadId === undefined || resolved.policy === undefined) return;
    yield* Limbase.applyPolicy(limbase.claude, limbase.limbaseThreadId, resolved.policy).pipe(
      Effect.mapError((error) => refusal(`Limbase: ${error.detail}`)),
    );
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
    value: LimbaseCompaction,
  ) {
    if (!hasLimbaseHome(claudeSettingsOf(yield* readSettings, instanceId))) {
      return yield* refusal(
        "Limbase compaction applies only to a Claude instance with a Limbase home.",
      );
    }
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
  });

  return {
    [FORK_SETTINGS_WS_METHODS.getThread]: (input: { readonly threadId: ThreadId }) =>
      threadView(input.threadId),
    [FORK_SETTINGS_WS_METHODS.setThread]: Effect.fn("ForkSettings.setThread")(function* (input: {
      readonly threadId: ThreadId;
      readonly settings: ForkSettingsGroups;
    }) {
      if (input.settings.limbaseCompaction !== undefined) {
        yield* applyThreadCompaction(input.threadId, input.settings.limbaseCompaction);
      }
      yield* store.write({ scope: "thread", id: input.threadId }, input.settings);
      return yield* threadView(input.threadId);
    }),
    [FORK_SETTINGS_WS_METHODS.getInstance]: (input: { readonly instanceId: ProviderInstanceId }) =>
      instanceView(input.instanceId),
    [FORK_SETTINGS_WS_METHODS.setInstance]: Effect.fn("ForkSettings.setInstance")(
      function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly settings: ForkSettingsGroups;
      }) {
        if (input.settings.limbaseCompaction !== undefined) {
          yield* checkInstanceCompaction(input.instanceId, input.settings.limbaseCompaction);
        }
        yield* store.write({ scope: "instance", id: input.instanceId }, input.settings);
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
