import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  Options as ClaudeQueryOptions,
  Query as ClaudeQuery,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { LhcOptions, LhcQuery } from "claude-lhc/client";

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

export type ClaudeLhcQueryOptions = Omit<ClaudeQueryOptions, "mcpServers"> & {
  readonly lhc: LhcOptions;
};

type ClaudeProcessMcpServerConfig = Exclude<McpServerConfig, McpSdkServerConfigWithInstance>;

type LhcMessage = LhcQuery extends AsyncGenerator<infer Message, void> ? Message : never;

function withoutInProcessMcpServers(
  servers: Record<string, McpServerConfig>,
): Record<string, ClaudeProcessMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).filter(
      (entry): entry is [string, ClaudeProcessMcpServerConfig] => entry[1].type !== "sdk",
    ),
  );
}

function stockResult(result: IteratorResult<LhcMessage, void>): IteratorResult<SDKMessage, void> {
  return result.done === true ? result : { done: false, value: result.value as SDKMessage };
}

export function claudeRunnerQuery(query: LhcQuery): ClaudeRunnerQuery {
  return {
    next: () => query.next().then(stockResult),
    return: () => query.return().then(stockResult),
    [Symbol.asyncDispose]: () => query[Symbol.asyncDispose](),
    setMcpServers: (servers) => query.setMcpServers(withoutInProcessMcpServers(servers)),
    setModel: (model) => query.setModel(model),
    applyFlagSettings: (settings) => query.applyFlagSettings(settings),
    setPermissionMode: (mode) => query.setPermissionMode(mode),
    stopTask: (taskId) => query.stopTask(taskId),
    backgroundTasks: (toolUseId) => query.backgroundTasks(toolUseId),
    interrupt: () => query.interrupt(),
    close: () => query.close(),
  };
}
