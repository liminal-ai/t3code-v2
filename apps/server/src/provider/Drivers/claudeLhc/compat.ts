import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  Options as ClaudeQueryOptions,
  Query as ClaudeQuery,
  SDKMessage,
  SDKMessageOrigin,
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

type LhcOrigin = NonNullable<Extract<LhcMessage, { type: "user" }>["origin"]>;
type LhcResultError = Exclude<Extract<LhcMessage, { type: "result" }>, { subtype: "success" }>;
type LhcStartupFailureReason = NonNullable<LhcResultError["startup_failure_reason"]>;

// SDK 0.3.312 startup failures that 0.3.276 cannot name. T3 never reads the reason.
const LHC_ONLY_STARTUP_FAILURE_REASONS = [
  "org_config_refused",
  "org_config_required_unavailable",
  "provider_not_allowed",
] as const satisfies ReadonlyArray<LhcStartupFailureReason>;

function isLhcOnlyStartupFailureReason(
  reason: LhcStartupFailureReason,
): reason is (typeof LHC_ONLY_STARTUP_FAILURE_REASONS)[number] {
  return LHC_ONLY_STARTUP_FAILURE_REASONS.some((lhcOnly) => lhcOnly === reason);
}

// T3 reads only `origin.kind`, so a session-inbox delivery stays a task notification without its subkind.
function stockOrigin(origin: LhcOrigin): SDKMessageOrigin {
  if (origin.kind !== "task-notification") return origin;
  const { subkind, ...notification } = origin;
  return subkind === undefined || subkind === "session-inbox"
    ? notification
    : { ...notification, subkind };
}

function withStockOrigin<M extends { readonly origin?: LhcOrigin }>(
  message: M,
): Omit<M, "origin"> & { origin?: SDKMessageOrigin } {
  const { origin, ...rest } = message;
  return origin === undefined ? rest : { ...rest, origin: stockOrigin(origin) };
}

function stockResultError(message: LhcResultError) {
  const { startup_failure_reason: reason, ...rest } = withStockOrigin(message);
  return reason === undefined || isLhcOnlyStartupFailureReason(reason)
    ? rest
    : { ...rest, startup_failure_reason: reason };
}

export function stockMessage(message: LhcMessage): SDKMessage {
  switch (message.type) {
    case "user":
      return withStockOrigin(message);
    case "result":
      return message.subtype === "success" ? withStockOrigin(message) : stockResultError(message);
    default:
      return message;
  }
}

function stockResult(result: IteratorResult<LhcMessage, void>): IteratorResult<SDKMessage, void> {
  return result.done === true ? result : { done: false, value: stockMessage(result.value) };
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
