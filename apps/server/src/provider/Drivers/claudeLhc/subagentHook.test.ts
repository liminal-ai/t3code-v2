// @effect-diagnostics nodeBuiltinImport:off -- runs the hook command through real shells and hands the seam a Node ChildProcess.
import * as NodeChildProcess from "node:child_process";
import type { HookCallbackMatcher, SDKUserMessage, Settings } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2EngineBinding,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ClaudeAdapterV2 from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type { ClaudeLhcQueryOptions, ClaudeRunnerQuery } from "./client.ts";
import { makeClaudeLhcSeam, type ClaudeLhcSeamClient } from "./seam.ts";
import { SUBAGENT_DEVICE_HOOK_COMMAND, withSubagentDeviceHook } from "./subagentHook.ts";

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash"].filter((shell) => {
  try {
    NodeChildProcess.execFileSync(shell, ["-c", "true"]);
    return true;
  } catch {
    return false;
  }
});

const binding: OrchestrationV2EngineBinding = {
  providerInstanceId: ProviderInstanceId.make("claude-lhc"),
  engine: "claude-lhc",
  continuationKey: "claude-lhc:home:/homes/lhc",
  claudeHome: "/homes/lhc",
  compact: { trigger: 40_000, target: 20_000 },
  nativeContinuation: "required",
  compaction: "provider",
};

const idleQuery: ClaudeRunnerQuery = {
  next: () => Promise.resolve({ done: true, value: undefined }),
  [Symbol.asyncDispose]: () => Promise.resolve(),
  setMcpServers: () => Promise.resolve({ added: [], removed: [], errors: {} }),
  setModel: () => Promise.resolve(),
  applyFlagSettings: () => Promise.resolve(),
  setPermissionMode: () => Promise.resolve(),
  stopTask: () => Promise.resolve(),
  backgroundTasks: () => Promise.resolve(false),
  interrupt: () => Promise.resolve(undefined),
  close: () => {},
};

const prompt: AsyncIterable<SDKUserMessage> = (async function* () {})();
const DEFAULT_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

const stockOptions = (deviceToolsAvailable: boolean) =>
  ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: { instanceId: ProviderInstanceId.make("claude-lhc"), model: "claude-sonnet-5" },
    nativeThreadId: "native-session",
    resume: false,
    cwd: "/repo",
    settings: DEFAULT_SETTINGS,
    sdkSettings: { model: "opus" },
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1:1/mcp" } },
    deviceToolsAvailable,
  });

const stockHookOutput = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions) => {
  const [matcher] = options.hooks?.SubagentStart ?? [];
  const [callback] = (matcher as HookCallbackMatcher).hooks;
  return callback!(
    {
      hook_event_name: "SubagentStart",
      session_id: "native-session",
      transcript_path: "/homes/lhc/projects/repo/native-session.jsonl",
      cwd: "/repo",
      agent_id: "agent-1",
      agent_type: "general-purpose",
    },
    undefined,
    { signal: new AbortController().signal },
  );
};

const openThroughSeam = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions) =>
  Effect.gen(function* () {
    const queries: Array<ClaudeLhcQueryOptions> = [];
    const client = {
      query: (_prompt, queryOptions) => {
        queries.push(queryOptions);
        return idleQuery;
      },
    } as ClaudeLhcSeamClient;
    const seam = yield* makeClaudeLhcSeam({
      runtime: Result.succeed({ node: "/opt/lhc/node", sidecar: "/opt/lhc/sidecar.js" }),
      stateDir: "/srv/t3/userdata",
      environment: {},
      binaryPath: "/usr/local/bin/claude",
      client,
    }).pipe(Effect.provide(NodeServices.layer));
    seam.createQuery(
      prompt,
      {
        ...options,
        spawnClaudeCodeProcess: () => {
          throw new Error("The seam spawns the sidecar only when the client starts it.");
        },
      },
      { appThreadId: ThreadId.make("thread-lhc"), engineBinding: binding },
      undefined,
    );
    return queries[0]!;
  });

const commandHooks = (settings: ClaudeLhcQueryOptions["settings"]) =>
  typeof settings === "object"
    ? (settings.hooks?.SubagentStart ?? []).flatMap((matcher) =>
        matcher.hooks.flatMap((hook) => (hook.type === "command" ? [hook.command] : [])),
      )
    : [];

describe("withSubagentDeviceHook", () => {
  it.effect("prints exactly what the stock callback returns, through every shell here", () =>
    Effect.gen(function* () {
      assert.isNotEmpty(SHELLS);
      const stock = yield* Effect.promise(() => stockHookOutput(stockOptions(true)));
      for (const shell of SHELLS) {
        const printed = NodeChildProcess.execFileSync(shell, ["-c", SUBAGENT_DEVICE_HOOK_COMMAND], {
          encoding: "utf8",
        });
        assert.deepEqual(JSON.parse(printed), stock, `${shell} prints the stock output`);
      }
    }),
  );

  it("keeps T3's flag settings and the user's own hooks beside the device hook", () => {
    const userHook = { matcher: "*", hooks: [{ type: "command" as const, command: "notify" }] };
    const settings: Settings = {
      showThinkingSummaries: true,
      hooks: { SubagentStart: [userHook], Stop: [userHook] },
    };
    const merged = withSubagentDeviceHook(settings);
    assert.deepEqual(JSON.parse(JSON.stringify(merged)), {
      showThinkingSummaries: true,
      hooks: {
        SubagentStart: [
          userHook,
          { hooks: [{ type: "command", command: SUBAGENT_DEVICE_HOOK_COMMAND }] },
        ],
        Stop: [userHook],
      },
    });
    assert.deepEqual(settings.hooks?.SubagentStart, [userHook], "the input is left as it was");
  });

  it("adds only the hook when there are no flag settings, and leaves a settings file path alone", () => {
    assert.deepEqual(withSubagentDeviceHook(undefined), {
      hooks: {
        SubagentStart: [{ hooks: [{ type: "command", command: SUBAGENT_DEVICE_HOOK_COMMAND }] }],
      },
    });
    assert.equal(withSubagentDeviceHook("/repo/settings.json"), "/repo/settings.json");
  });
});

describe("the Claude LHC seam's subagent device hook", () => {
  it.effect(
    "sends a thread with device instructions the command hook instead of the callback",
    () =>
      Effect.gen(function* () {
        const sent = yield* openThroughSeam(stockOptions(true));
        assert.notProperty(sent, "hooks");
        assert.deepEqual(commandHooks(sent.settings), [SUBAGENT_DEVICE_HOOK_COMMAND]);
        assert.equal((sent.settings as Settings).model, "opus");
        assert.isTrue((sent.settings as Settings).showThinkingSummaries);
      }),
  );

  it.effect("sends a thread without device instructions no subagent hook", () =>
    Effect.gen(function* () {
      const options = stockOptions(false);
      const sent = yield* openThroughSeam(options);
      assert.notProperty(sent, "hooks");
      assert.deepEqual(commandHooks(sent.settings), []);
      assert.deepEqual(sent.settings, options.settings);
    }),
  );
});
