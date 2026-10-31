import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  Options as ClaudeQueryOptions,
  Query as ClaudeQuery,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { LhcOptions, LhcQuery } from "claude-lhc/client";

/** The members of the stock SDK's `Query` that `ClaudeAgentSdkQueryRunner` calls, and no others. */
export type ClaudeRunnerQuery = AsyncIterator<SDKMessage, void> &
  AsyncDisposable &
  Pick<
    ClaudeQuery,
    | "setMcpServers"
    | "setModel"
    | "applyFlagSettings"
    | "setPermissionMode"
    | "stopTask"
    | "backgroundTasks"
    | "interrupt"
    | "close"
  >;

/** Stock query options for a sidecar open. The runner sends MCP servers with `setMcpServers`. */
export type ClaudeLhcQueryOptions = Omit<ClaudeQueryOptions, "mcpServers"> & {
  readonly lhc: LhcOptions;
};

type ClaudeProcessMcpServerConfig = Exclude<McpServerConfig, McpSdkServerConfigWithInstance>;

type LhcMessage = LhcQuery extends AsyncGenerator<infer Message, void> ? Message : never;

// claude-lhc drops in-process servers itself; dropping them here keeps the stock MCP SDK's class out of its type.
function processMcpServers(
  servers: Record<string, McpServerConfig>,
): Record<string, ClaudeProcessMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).filter(
      (entry): entry is [string, ClaudeProcessMcpServerConfig] => entry[1].type !== "sdk",
    ),
  );
}

function stockResult(result: IteratorResult<LhcMessage, void>): IteratorResult<SDKMessage, void> {
  // Both SDKs type the same CLI JSON; 0.3.312 only widens literal unions the runner passes through.
  return result.done === true ? result : { done: false, value: result.value as SDKMessage };
}

export function claudeRunnerQuery(query: LhcQuery): ClaudeRunnerQuery {
  return {
    next: () => query.next().then(stockResult),
    return: () => query.return().then(stockResult),
    [Symbol.asyncDispose]: () => query[Symbol.asyncDispose](),
    setMcpServers: (servers) => query.setMcpServers(processMcpServers(servers)),
    setModel: (model) => query.setModel(model),
    applyFlagSettings: (settings) => query.applyFlagSettings(settings),
    setPermissionMode: (mode) => query.setPermissionMode(mode),
    stopTask: (taskId) => query.stopTask(taskId),
    backgroundTasks: (toolUseId) => query.backgroundTasks(toolUseId),
    interrupt: () => query.interrupt(),
    close: () => query.close(),
  };
}
