// @effect-diagnostics nodeBuiltinImport:off
import type {
  Options as ClaudeQueryOptions,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { agentScopeCommand } from "@t3tools/shared/AgentScope";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  claudeLhcHome,
  fitLhcCompactionToContextWindow,
  lhcContextWindow,
  makeClaudeLhcCreateQuery,
  resolveClaudeLhcSidecar,
  sidecarHonorsRollback,
  type ClaudeLhcLaunch,
  type SidecarPin,
} from "./ClaudeLhcSidecar.ts";
import sidecarPin from "../../../../../lhc/sidecar.json" with { type: "json" };

const PIN: SidecarPin = { package: "claude-lhc", version: "9.9.9" };
const BASE_DIR = NodePath.join(NodeOS.tmpdir(), "t3-lhc-under-test", "userdata");
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-lhc-sidecar-test-"));
afterAll(() => NodeFS.rmSync(scratch, { recursive: true, force: true }));

const FAKE_SIDECAR = `
const readline = require("node:readline");
const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
let reqId = 0;
const pending = new Map();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "start") {
    if (frame.options.failStart) {
      write({ type: "error", message: "Claude session already names LHC thread t-1" });
      return;
    }
    write({ type: "msg", message: { type: "system", subtype: "init", start: frame.options,
      sidecarEnv: { home: process.env.T3CODE_LHC_HOME, thread: process.env.T3CODE_THREAD_ID,
        nodeMarker: process.env.FAKE_NODE_MARKER ?? null, wrapper: process.env.FAKE_WRAPPER ?? null } } });
  } else if (frame.type === "user") {
    const id = ++reqId;
    pending.set(id, frame.message.message.content);
    write({ type: "req", id, method: "canUseTool", params: { toolName: "Read", input: { file_path: "a.ts" }, toolUseID: "toolu_" + id } });
  } else if (frame.type === "res") {
    write({ type: "msg", message: { type: "assistant", prompt: pending.get(frame.id), approval: frame.ok ? frame.value : { error: frame.error } } });
  } else if (frame.type === "req") {
    const known = { setModel: null, setPermissionMode: null, interrupt: null,
      setMcpServers: { added: Object.keys(frame.params.servers ?? {}), removed: [], errors: {} } };
    if (frame.method in known) write({ type: "res", id: frame.id, ok: true, value: known[frame.method] });
    else write({ type: "res", id: frame.id, ok: false, error: "unknown control " + frame.method });
  }
}).on("close", () => process.exit(0));
`;

function stageSidecar(version = PIN.version): string {
  const packageDir = NodeFS.mkdtempSync(NodePath.join(scratch, "claude-lhc-"));
  NodeFS.mkdirSync(NodePath.join(packageDir, "dist"));
  NodeFS.writeFileSync(
    NodePath.join(packageDir, "package.json"),
    JSON.stringify({ name: PIN.package, version }),
  );
  const entry = NodePath.join(packageDir, "dist", "sidecar.js");
  NodeFS.writeFileSync(entry, FAKE_SIDECAR);
  return entry;
}

let launchers = 0;
function nodeLauncher(version?: string): string {
  const launcher = NodePath.join(scratch, `node-${version ?? "marked"}-${++launchers}.sh`);
  NodeFS.writeFileSync(
    launcher,
    version === undefined
      ? `#!/bin/sh\nFAKE_NODE_MARKER=configured exec "${process.execPath}" "$@"\n`
      : `#!/bin/sh\necho ${version}\n`,
    { mode: 0o755 },
  );
  return launcher;
}

const readyLaunch = (): ClaudeLhcLaunch => {
  const resolution = resolveClaudeLhcSidecar(
    { CLAUDE_LHC_NODE: nodeLauncher(), CLAUDE_LHC_SIDECAR: stageSidecar() },
    BASE_DIR,
    PIN,
  );
  if (resolution._tag !== "ready") throw new Error(resolution.reason);
  return resolution.launch;
};

const userMessage = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

async function* prompts(...messages: ReadonlyArray<SDKUserMessage>) {
  yield* messages;
  await new Promise(() => {});
}

const nextMessage = async (runtime: AsyncIterator<SDKMessage>) => {
  const result = await runtime.next();
  if (result.done) throw new Error("sidecar stream ended");
  return result.value as unknown as Record<string, unknown>;
};

const openQuery = (
  launch: ClaudeLhcLaunch,
  options: Record<string, unknown>,
  ...messages: ReadonlyArray<SDKUserMessage>
) =>
  makeClaudeLhcCreateQuery({
    launch,
    windows: { autoCompactWindow: "700000", lhcLowerBound: "120000" },
    environment: { PATH: process.env.PATH },
  })({
    prompt: prompts(...messages),
    options: { model: "claude-haiku-4-5", ...options } as ClaudeQueryOptions,
    threadId: ThreadId.make("thread-lhc-test"),
  });

describe("resolveClaudeLhcSidecar", () => {
  it("needs an explicit Node 24.3+ binary and a staged sidecar that matches the pin", () => {
    const entry = stageSidecar();
    expect(resolveClaudeLhcSidecar({ CLAUDE_LHC_SIDECAR: entry }, BASE_DIR, PIN)).toMatchObject({
      _tag: "unavailable",
      reason: expect.stringMatching(/Set CLAUDE_LHC_NODE/),
    });
    expect(
      resolveClaudeLhcSidecar(
        { CLAUDE_LHC_NODE: nodeLauncher("v22.11.0"), CLAUDE_LHC_SIDECAR: entry },
        BASE_DIR,
        PIN,
      ),
    ).toMatchObject({ reason: expect.stringMatching(/Node v22.11.0; claude-lhc needs 24.3.0/) });
    expect(
      resolveClaudeLhcSidecar({ CLAUDE_LHC_NODE: nodeLauncher() }, BASE_DIR, PIN),
    ).toMatchObject({ reason: expect.stringMatching(/Set CLAUDE_LHC_SIDECAR/) });
    expect(
      resolveClaudeLhcSidecar(
        { CLAUDE_LHC_NODE: nodeLauncher(), CLAUDE_LHC_SIDECAR: stageSidecar("0.1.1") },
        BASE_DIR,
        PIN,
      ),
    ).toMatchObject({
      reason: expect.stringMatching(/is claude-lhc@0.1.1; this build needs claude-lhc@9.9.9/),
    });
    expect(readyLaunch()).toMatchObject({ entry: expect.any(String), version: PIN.version });
  });

  it("keeps each install's LHC store beside its base dir", () => {
    expect(claudeLhcHome("/srv/t3/data/")).toBe("/srv/t3/data-lhc");
    expect(readyLaunch().home).toBe(`${BASE_DIR}-lhc`);
  });

  it("advertises rollback only from a sidecar that records host rollbacks, which the pin does", () => {
    expect(sidecarHonorsRollback("0.1.1")).toBe(false);
    expect(sidecarHonorsRollback("0.2.0")).toBe(true);
    expect(sidecarHonorsRollback(sidecarPin.version)).toBe(true);
  });
});

describe("compaction windows", () => {
  it("sizes each model the way Claude Code does", () => {
    expect(lhcContextWindow("claude-opus-5-5")).toBe(1_000_000);
    expect(lhcContextWindow("claude-haiku-4-5")).toBe(200_000);
    expect(lhcContextWindow("claude-sonnet-4-6[1m]")).toBe(1_000_000);
    expect(lhcContextWindow("glm-5.3")).toBe(200_000);
    expect(lhcContextWindow("")).toBeUndefined();
  });

  it("drops a trigger that would overflow the window to 80%, and the view to at most half of it", () => {
    expect(
      fitLhcCompactionToContextWindow({
        autoCompactWindow: 700_000,
        lhcLowerBound: 120_000,
        contextWindow: 200_000,
      }),
    ).toEqual({ autoCompactWindow: 160_000, lhcLowerBound: 80_000 });
    expect(
      fitLhcCompactionToContextWindow({
        autoCompactWindow: 700_000,
        lhcLowerBound: 120_000,
        contextWindow: 1_000_000,
      }),
    ).toEqual({ autoCompactWindow: 700_000, lhcLowerBound: 120_000 });
  });
});

describe("makeClaudeLhcCreateQuery", () => {
  it("starts the configured Node on the sidecar with this install's store, the thread and fitted windows", async () => {
    const runtime = openQuery(readyLaunch(), {
      pathToClaudeCodeExecutable: "/opt/claude/bin/claude",
      settings: { fastMode: true },
      canUseTool: async () => ({ behavior: "allow" }),
    });
    const init = await nextMessage(runtime);
    const start = init.start as Record<string, unknown>;

    expect(init.sidecarEnv).toMatchObject({
      home: `${BASE_DIR}-lhc`,
      thread: "thread-lhc-test",
      nodeMarker: "configured",
    });
    expect(start.pathToClaudeCodeExecutable).toBe("/opt/claude/bin/claude");
    expect(start.settings).toEqual({
      fastMode: true,
      autoCompactWindow: 160_000,
      lhcLowerBound: 80_000,
    });
    expect(start).not.toHaveProperty("canUseTool");
    await runtime[Symbol.asyncDispose]();
  });

  it("runs the sidecar inside the agent wrapper the runner put around Claude Code", async () => {
    expect(agentScopeCommand({ command: "/opt/claude/bin/claude", args: [] }).args.at(-1)).toBe(
      "/opt/claude/bin/claude",
    );
    const wrapper = NodePath.join(scratch, "agent-wrapper.sh");
    NodeFS.writeFileSync(wrapper, '#!/bin/sh\nshift\nFAKE_WRAPPER="$1" exec "$@"\n', {
      mode: 0o755,
    });
    const runtime = openQuery(readyLaunch(), {
      pathToClaudeCodeExecutable: wrapper,
      executableArgs: ["--scope-flag", "/opt/claude/bin/claude"],
    });
    const init = await nextMessage(runtime);
    const start = init.start as Record<string, unknown>;

    expect(start.pathToClaudeCodeExecutable).toBe("/opt/claude/bin/claude");
    expect(start).not.toHaveProperty("executableArgs");
    expect(init.sidecarEnv).toMatchObject({ nodeMarker: "configured" });
    expect((init.sidecarEnv as Record<string, string>).wrapper).toMatch(/node-marked/);
    await runtime[Symbol.asyncDispose]();
  });

  it("answers the sidecar's tool approvals through the adapter's canUseTool", async () => {
    const asked: Array<string> = [];
    const runtime = openQuery(
      readyLaunch(),
      {
        canUseTool: async (toolName: string) => {
          asked.push(toolName);
          return { behavior: "allow", updatedInput: {} };
        },
      },
      userMessage("read a.ts"),
    );
    await nextMessage(runtime);
    const reply = await nextMessage(runtime);

    expect(asked).toEqual(["Read"]);
    expect(reply).toMatchObject({
      type: "assistant",
      prompt: "read a.ts",
      approval: { behavior: "allow" },
    });
    await runtime[Symbol.asyncDispose]();
  });

  it("forwards controls, including the MCP set, and surfaces the ones the sidecar refuses", async () => {
    const runtime = openQuery(readyLaunch(), {});
    await nextMessage(runtime);

    await expect(
      runtime.setMcpServers({ "t3-code": { type: "http", url: "http://127.0.0.1:1/mcp" } }),
    ).resolves.toEqual({ added: ["t3-code"], removed: [], errors: {} });
    await expect(runtime.setModel("claude-opus-5-5")).resolves.toBeUndefined();
    await expect(runtime.interrupt()).resolves.toBeUndefined();
    await expect(runtime.applyFlagSettings({ fastMode: true })).rejects.toThrow(
      "unknown control applyFlagSettings",
    );
    await runtime[Symbol.asyncDispose]();
    await expect(runtime.setModel("claude-opus-5-5")).rejects.toThrow("closed");
  });

  it("ends the stream on close and fails it on a sidecar error frame", async () => {
    const closing = openQuery(readyLaunch(), {});
    await nextMessage(closing);
    closing.close();
    expect(await closing.next()).toEqual({ done: true, value: undefined });

    const refused = openQuery(readyLaunch(), { failStart: true });
    await expect(refused.next()).rejects.toThrow("already names LHC thread");
    await refused[Symbol.asyncDispose]();
  });
});
