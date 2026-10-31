import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as ClaudeLhcClient from "claude-lhc/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { claudeRunnerQuery, type ClaudeLhcQueryOptions, type ClaudeRunnerQuery } from "./compat.ts";

export type {
  LhcForkSessionOptions,
  LhcForkSessionResult,
  LhcOperationStore,
  LhcOptions,
  LhcSessionMessagesOptions,
  LhcSubagentMessagesOptions,
  SessionInspection,
  SidecarCommand,
  SidecarSpawnOptions,
} from "claude-lhc/client";
export type { ClaudeLhcQueryOptions, ClaudeRunnerQuery } from "./compat.ts";

const ClaudeLhcOperation = Schema.Literals([
  "forkSession",
  "getSessionMessages",
  "getSubagentMessages",
  "inspectSessions",
]);

export class ClaudeLhcOperationError extends Schema.TaggedError<ClaudeLhcOperationError>()(
  "ClaudeLhcOperationError",
  { operation: ClaudeLhcOperation, cause: Schema.Defect() },
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `claude-lhc ${this.operation} failed: ${detail}`;
  }
}

function operation<A>(
  name: typeof ClaudeLhcOperation.Type,
  run: () => Promise<A>,
): Effect.Effect<A, ClaudeLhcOperationError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new ClaudeLhcOperationError({ operation: name, cause }),
  }).pipe(Effect.withSpan(`claudeLhc.${name}`));
}

/** @public */
export function query(
  prompt: AsyncIterable<SDKUserMessage>,
  options: ClaudeLhcQueryOptions,
): ClaudeRunnerQuery {
  return claudeRunnerQuery(ClaudeLhcClient.query({ prompt, options }));
}

/** @public */
export const forkSession = (sessionId: string, options: ClaudeLhcClient.LhcForkSessionOptions) =>
  operation("forkSession", () => ClaudeLhcClient.forkSession(sessionId, options));

export const getSessionMessages = (
  sessionId: string,
  options: ClaudeLhcClient.LhcSessionMessagesOptions,
) => operation("getSessionMessages", () => ClaudeLhcClient.getSessionMessages(sessionId, options));

/** @public */
export const getSubagentMessages = (
  sessionId: string,
  agentId: string,
  options: ClaudeLhcClient.LhcSubagentMessagesOptions,
) =>
  operation("getSubagentMessages", () =>
    ClaudeLhcClient.getSubagentMessages(sessionId, agentId, options),
  );

export const inspectSessions = (
  sessionIds: ReadonlyArray<string>,
  options: ClaudeLhcClient.LhcOperationStore,
) => operation("inspectSessions", () => ClaudeLhcClient.inspectSessions(sessionIds, options));
