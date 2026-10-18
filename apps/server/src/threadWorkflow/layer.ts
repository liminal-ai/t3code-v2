import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { layerThreadHooks } from "./hooks.ts";
import * as ThreadWorkflowStore from "./store.ts";
import * as IdleReactor from "./ThreadWorkflowIdleReactor.ts";
import * as ThreadWorkflowService from "./ThreadWorkflowService.ts";

/**
 * The module as core sees it: the service for the pane and the MCP tools, and the hooks for every
 * core consumer. Both read one store, folded from disk when the layer builds. The build never
 * fails: an unreadable threads directory turns the module off (see `ThreadWorkflowStore`) so the
 * server still starts.
 */
export const layer = Layer.merge(ThreadWorkflowService.layer, layerThreadHooks).pipe(
  Layer.provideMerge(ThreadWorkflowStore.layer),
);

/**
 * `layer` as `server.ts` provides it: below everything that builds a `ThreadHooks` consumer
 * (orchestration, settlement, project deletion, provider sessions), so each of them sees the
 * module's hooks instead of the inert default. It shares the orchestrator's thread lock, which is
 * the same memoized `ThreadCommandExecutor.layer`.
 */
export const layerForServer = <E, R>(
  layerSettings: Layer.Layer<ServerSettings.ServerSettingsService, E, R>,
) =>
  layer.pipe(
    Layer.provide(layerSettings),
    Layer.provide(ProjectionStore.layer),
    Layer.provide(ThreadCommandExecutor.layer),
  );

/** Starts the idle ping. It dispatches through the orchestrator, so it sits above it. */
export const layerIdleReactorStart = Layer.effectDiscard(
  Effect.flatMap(IdleReactor.ThreadWorkflowIdleReactor, (reactor) => reactor.start()),
).pipe(Layer.provide(IdleReactor.layer), Layer.provide(ProjectionStore.layer));
