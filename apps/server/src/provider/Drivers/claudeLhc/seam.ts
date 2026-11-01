// @effect-diagnostics nodeBuiltinImport:off -- claude-lhc takes a Node ChildProcess for its sidecar.
import * as NodeChildProcess from "node:child_process";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  ClaudeAgentSdkQueryRunnerError,
  type ClaudeProgram,
  type ClaudeQuerySeam,
} from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ClaudeLhcClient from "./client.ts";
import type { ClaudeLhcRuntime, ClaudeLhcRuntimeProblem } from "./runtime.ts";
import { withSubagentDeviceHook } from "./subagentHook.ts";

export class ClaudeLhcOpenRefusedError extends Schema.TaggedError<ClaudeLhcOpenRefusedError>()(
  "ClaudeLhcOpenRefusedError",
  { appThreadId: ThreadId, reason: Schema.Literals(["unbound", "no-compact-policy"]) },
) {
  override get message(): string {
    return this.reason === "unbound"
      ? `Claude LHC cannot open thread ${this.appThreadId}, because it has no engine binding.`
      : `Claude LHC cannot open thread ${this.appThreadId}, because its engine binding has no compact policy.`;
  }
}

export type ClaudeLhcSeamClient = Pick<
  typeof ClaudeLhcClient,
  "query" | "forkSession" | "getSubagentMessages"
>;

export interface ClaudeLhcSeamInput {
  readonly runtime: Result.Result<ClaudeLhcRuntime, ClaudeLhcRuntimeProblem>;
  readonly stateDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly binaryPath: string;
  readonly client?: ClaudeLhcSeamClient;
}

const sidecarProgram = (runtime: ClaudeLhcRuntime): ClaudeProgram => ({
  command: runtime.node,
  args: [runtime.sidecar],
});

// LHC threads reopen after idle release, which outlasts Claude Code's default five-minute cache.
const withLhcPromptCacheTtl = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  env.CLAUDE_CODE_PROMPT_CACHE_TTL === undefined
    ? { ...env, CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }
    : env;

const sidecarCommand = (program: ClaudeProgram, env: NodeJS.ProcessEnv | undefined) => ({
  command: program.command,
  args: [...program.args],
  ...(env === undefined ? {} : { env }),
});

export const makeClaudeLhcSeam = Effect.fn("makeClaudeLhcSeam")(function* (
  input: ClaudeLhcSeamInput,
) {
  const path = yield* Path.Path;
  const home = path.join(input.stateDir, "lhc");
  const client = input.client ?? ClaudeLhcClient;
  const resolvedRuntime = (method: string) =>
    Effect.fromResult(input.runtime).pipe(
      Effect.mapError((cause) => new ClaudeAgentSdkQueryRunnerError({ method, cause })),
    );
  const operationStore = (runtime: ClaudeLhcRuntime, env: NodeJS.ProcessEnv) => ({
    env,
    pathToClaudeCodeExecutable: input.binaryPath,
    lhc: { home, spawn: sidecarCommand(sidecarProgram(runtime), env) },
  });

  const seam: ClaudeQuerySeam = {
    program: () =>
      Result.isSuccess(input.runtime) ? sidecarProgram(input.runtime.success) : undefined,
    createQuery: (prompt, { spawnClaudeCodeProcess, hooks, ...options }, thread, launch) => {
      if (Result.isFailure(input.runtime)) throw input.runtime.failure;
      const binding = thread.engineBinding;
      if (binding === null || binding.compact === null) {
        throw new ClaudeLhcOpenRefusedError({
          appThreadId: thread.appThreadId,
          reason: binding === null ? "unbound" : "no-compact-policy",
        });
      }
      const queryEnv = withLhcPromptCacheTtl(options.env ?? input.environment);
      return client.query(prompt, {
        ...options,
        env: queryEnv,
        // Callbacks cannot cross to the sidecar, and the adapter's only SubagentStart callback is
        // the one it adds for a thread with device instructions.
        ...(hooks?.SubagentStart === undefined
          ? {}
          : { settings: withSubagentDeviceHook(options.settings) }),
        lhc: {
          home,
          compact: binding.compact,
          spawn: sidecarCommand(launch ?? sidecarProgram(input.runtime.success), queryEnv),
          spawnProcess: ({ command, args, env, signal }) => {
            const child = spawnClaudeCodeProcess({ command, args, env, signal });
            if (!(child instanceof NodeChildProcess.ChildProcess)) {
              throw new Error("The Claude query runner did not spawn the claude-lhc sidecar.");
            }
            return child;
          },
        },
      });
    },
    forkSession: Effect.fnUntraced(function* ({ sessionId, options, environment }) {
      const { sessionStore: _sessionStore, ...forkOptions } = options;
      const result = yield* client
        .forkSession(sessionId, {
          ...forkOptions,
          ...operationStore(yield* resolvedRuntime("forkSession"), environment),
        })
        .pipe(
          Effect.mapError(
            (cause) => new ClaudeAgentSdkQueryRunnerError({ method: "forkSession", cause }),
          ),
        );
      return { result, inheritedHead: Effect.succeed(result.headMessageId) };
    }),
    subagentLaunchToolUseId: Effect.fnUntraced(function* ({ sessionId, agentId, dir }) {
      const messages = yield* client
        .getSubagentMessages(sessionId, agentId, {
          ...(dir === null ? {} : { dir }),
          limit: 1,
          ...operationStore(yield* resolvedRuntime("getSubagentMessages"), input.environment),
        })
        .pipe(
          Effect.mapError(
            (cause) => new ClaudeAgentSdkQueryRunnerError({ method: "getSubagentMessages", cause }),
          ),
        );
      return messages[0]?.parent_tool_use_id ?? null;
    }),
  };
  return seam;
});
