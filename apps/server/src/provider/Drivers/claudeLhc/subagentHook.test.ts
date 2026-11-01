// @effect-diagnostics nodeBuiltinImport:off -- runs the hook command through real shells and reads a live run's transcripts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type {
  HookCallbackMatcher,
  SDKMessage,
  SDKResultMessage,
  SDKTaskStartedMessage,
  SDKUserMessage,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2EngineBinding,
} from "@t3tools/contracts";
import { engineContinuationKey } from "@t3tools/provider-core/server/driver";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ClaudeAdapterV2 from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as PortScanner from "../../../preview/PortScanner.ts";
import * as ClaudeLhcClient from "./client.ts";
import type { ClaudeLhcQueryOptions, ClaudeRunnerQuery } from "./client.ts";
import { resolveClaudeLhcRuntime } from "./runtime.ts";
import { makeClaudeLhcSeam, type ClaudeLhcSeamClient } from "./seam.ts";
import { SUBAGENT_DEVICE_HOOK_COMMAND, withSubagentDeviceHook } from "./subagentHook.ts";

const unix = HostProcess.Platform.defaultValue() !== "win32";
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

// Claude LHC runs only on Linux and macOS, so the hook runs only in a POSIX shell.
describe.runIf(unix)("the subagent device hook command", () => {
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
});

describe("withSubagentDeviceHook", () => {
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

const LIVE = process.env.T3_CLAUDE_LHC_LIVE === "1";
const EVIDENCE_DIR = process.env.T3_CLAUDE_LHC_EVIDENCE;
const MODEL = process.env.T3_CLAUDE_LHC_MODEL ?? "claude-haiku-5-5";
const DEVICE_HEADING = "## T3 Code devices";
const LIVE_CREDENTIALS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

const SUBAGENT_REQUEST =
  "Use the Agent tool once to launch a general-purpose subagent with exactly this task: " +
  '"Reply with only the first heading line of any additional context you were given when you started, or NONE." ' +
  "Then reply with only the subagent's answer.";

const PROBE_MCP = `
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result =
    request.method === "initialize"
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1.0.0" } }
      : request.method === "tools/list"
        ? { tools: [] }
        : {};
  send({ jsonrpc: "2.0", id: request.id, result });
});
`;

// The shared test setup deletes provider variables from process.env, so a live run reads its
// credentials from the environment this worker process started with.
const startedEnvironment = (): NodeJS.ProcessEnv => {
  const started = new Map(
    NodeFS.readFileSync("/proc/self/environ", "utf8")
      .split("\0")
      .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
  );
  return Object.fromEntries(
    LIVE_CREDENTIALS.flatMap((name) => {
      const value = process.env[name] ?? started.get(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
};

interface Timed {
  readonly at: number;
  readonly message: SDKMessage;
}

interface SubagentLaunch {
  readonly side: "stock" | "lhc";
  readonly label: string;
  readonly taskId: string;
  readonly startedToFirstMessageMs: number | null;
  readonly answer: string;
  readonly transcript: string;
}

const findFile = (root: string, name: string): string | undefined =>
  NodeFS.readdirSync(root, { recursive: true })
    .map(String)
    .filter((entry) => NodePath.basename(entry) === name)
    .map((entry) => NodePath.join(root, entry))[0];

describe.runIf(LIVE && unix)("a native subagent on a real model through the T10 runner", () => {
  it.live(
    "carries the device-tool text as hook context on LHC before and after a compact, at stock's speed",
    () =>
      Effect.gen(function* () {
        const root =
          EVIDENCE_DIR ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lhc-t11-"));
        const claudeHome = NodePath.join(root, "claude-home");
        const stateDir = NodePath.join(root, "userdata");
        const cwd = NodePath.join(root, "project");
        for (const directory of [claudeHome, stateDir, cwd]) {
          NodeFS.mkdirSync(directory, { recursive: true });
        }
        const mcpScript = NodePath.join(root, "probe-mcp.mjs");
        NodeFS.writeFileSync(mcpScript, PROBE_MCP);
        const { CLAUDE_LHC_NO_INFERENCE: _inherited, ...host } = process.env;
        const environment: NodeJS.ProcessEnv = {
          ...host,
          ...startedEnvironment(),
          CLAUDE_CONFIG_DIR: claudeHome,
        };
        const binaryPath = process.env.T3_CLAUDE_LHC_BIN ?? "claude";
        const lhcSeam = yield* makeClaudeLhcSeam({
          runtime: yield* Effect.result(resolveClaudeLhcRuntime(environment)),
          stateDir,
          environment,
          binaryPath,
        });
        const makeRunner = (seam?: ClaudeAdapterV2.ClaudeQuerySeam) =>
          ClaudeAdapterV2.makeClaudeAgentSdkQueryRunner(seam).pipe(
            Effect.provideService(ProviderEventLoggers, {
              native: undefined,
              canonical: undefined,
            }),
            Effect.provideService(AgentScope, AgentScope.defaultValue()),
            Effect.provide(PortScanner.layerTest),
          );
        const lhcBinding: OrchestrationV2EngineBinding = {
          ...binding,
          continuationKey: engineContinuationKey({ engine: "claude-lhc", claudeHome }),
          claudeHome,
        };

        const openSide = Effect.fn("openSide")(function* (side: SubagentLaunch["side"]) {
          const runner = yield* makeRunner(side === "lhc" ? lhcSeam : undefined);
          const nativeThreadId = yield* runner.allocateSessionId;
          const session = yield* runner.open({
            providerSessionId: ProviderSessionId.make(`session:t11:${side}`),
            thread: {
              appThreadId: ThreadId.make(`thread:t11:${side}`),
              engineBinding: side === "lhc" ? lhcBinding : null,
            },
            options: ClaudeAdapterV2.makeClaudeQueryOptions({
              modelSelection: { instanceId: ProviderInstanceId.make("claude-lhc"), model: MODEL },
              nativeThreadId,
              resume: false,
              cwd,
              settings: { ...DEFAULT_SETTINGS, binaryPath },
              environment,
              mcpServers: {
                probe: { type: "stdio", command: process.execPath, args: [mcpScript] },
              },
              deviceToolsAvailable: true,
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
            }),
          });
          const inbox = yield* Queue.unbounded<Timed>();
          yield* session.messages.pipe(
            Stream.runForEach((message) =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((at) => Queue.offer(inbox, { at, message })),
              ),
            ),
            Effect.forkScoped,
          );
          const exchange = Effect.fn("exchange")(function* (text: string) {
            yield* session.offer({
              type: "user",
              message: { role: "user", content: [{ type: "text", text }] },
              parent_tool_use_id: null,
            });
            const received: Array<Timed> = [];
            for (;;) {
              const next = yield* Queue.take(inbox);
              received.push(next);
              if (next.message.type === "result") return received;
            }
          });
          return { side, nativeThreadId, exchange };
        });

        const launch = Effect.fn("launch")(function* (
          opened: Effect.Success<ReturnType<typeof openSide>>,
          label: string,
        ) {
          const received = yield* opened.exchange(SUBAGENT_REQUEST);
          const started = received.find(
            (entry) => entry.message.type === "system" && entry.message.subtype === "task_started",
          );
          assert.isDefined(started, `${opened.side} ${label} launched a subagent`);
          const task = started!.message as SDKTaskStartedMessage;
          const first = received.find(
            (entry) =>
              entry.at >= started!.at &&
              "parent_tool_use_id" in entry.message &&
              entry.message.parent_tool_use_id === task.tool_use_id,
          );
          const result = received.at(-1)!.message as SDKResultMessage;
          const file = findFile(claudeHome, `agent-${task.task_id}.jsonl`);
          const lookedUp =
            opened.side === "lhc"
              ? yield* ClaudeLhcClient.getSubagentMessages(opened.nativeThreadId, task.task_id, {
                  dir: cwd,
                  env: environment,
                  pathToClaudeCodeExecutable: binaryPath,
                  lhc: { home: NodePath.join(stateDir, "lhc") },
                })
              : null;
          const launched: SubagentLaunch = {
            side: opened.side,
            label,
            taskId: task.task_id,
            startedToFirstMessageMs: first === undefined ? null : first.at - started!.at,
            answer: result.subtype === "success" ? result.result : result.subtype,
            transcript: file === undefined ? "" : NodeFS.readFileSync(file, "utf8"),
          };
          if (lookedUp !== null) {
            NodeFS.writeFileSync(
              NodePath.join(root, `subagent-${label}.json`),
              JSON.stringify(lookedUp, null, 2),
            );
          }
          return { launched, lookedUp: lookedUp === null ? "" : JSON.stringify(lookedUp) };
        });

        const stock = yield* openSide("stock");
        const lhc = yield* openSide("lhc");
        const launches: Array<SubagentLaunch> = [];
        const lookups = new Map<string, string>();
        for (const round of [1, 2, 3]) {
          launches.push((yield* launch(stock, `stock-${round}`)).launched);
          const label = round === 1 ? "before" : round === 2 ? "after" : `lhc-${round}`;
          const lhcLaunch = yield* launch(lhc, label);
          launches.push(lhcLaunch.launched);
          lookups.set(label, lhcLaunch.lookedUp);
          if (round === 1) yield* lhc.exchange("/compact");
        }

        const medianOf = (side: SubagentLaunch["side"]) => {
          const values = launches
            .filter((entry) => entry.side === side)
            .flatMap((entry) =>
              entry.startedToFirstMessageMs === null ? [] : [entry.startedToFirstMessageMs],
            )
            .toSorted((left, right) => left - right);
          return values[Math.floor(values.length / 2)];
        };
        const summary = {
          model: MODEL,
          stockMedianMs: medianOf("stock"),
          lhcMedianMs: medianOf("lhc"),
          launches: launches.map(({ transcript, ...entry }) => ({
            ...entry,
            transcriptCarriesDeviceText: transcript.includes(DEVICE_HEADING),
          })),
        };
        NodeFS.writeFileSync(NodePath.join(root, "perf.json"), JSON.stringify(summary, null, 2));

        for (const entry of launches) {
          assert.include(
            entry.transcript,
            DEVICE_HEADING,
            `${entry.side} ${entry.label} subagent transcript carries the device-tool text`,
          );
        }
        for (const label of ["before", "after"]) {
          assert.include(
            lookups.get(label),
            DEVICE_HEADING,
            `getSubagentMessages returns the device-tool text ${label} the compact`,
          );
        }
        assert.isDefined(summary.stockMedianMs, "stock subagents stream a first message");
        assert.isDefined(summary.lhcMedianMs, "LHC subagents stream a first message");
        assert.isAtMost(summary.lhcMedianMs! - summary.stockMedianMs!, 2_000);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
