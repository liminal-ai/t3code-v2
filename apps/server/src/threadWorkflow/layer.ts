import * as Layer from "effect/Layer";

import { layerThreadHooks } from "./hooks.ts";
import * as ThreadWorkflowStore from "./store.ts";
import * as ThreadWorkflowService from "./ThreadWorkflowService.ts";

/**
 * The module as core sees it: the service for the pane and the MCP tools, and the hooks for every
 * core consumer. Both read one store, folded from disk when the layer builds; an unreadable
 * threads directory fails the build, so the server refuses to start rather than run without the
 * guard.
 */
export const layer = Layer.merge(ThreadWorkflowService.layer, layerThreadHooks).pipe(
  Layer.provideMerge(ThreadWorkflowStore.layer),
);
