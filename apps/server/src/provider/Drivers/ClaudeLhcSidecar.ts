// @effect-diagnostics globalTimers:off nodeBuiltinImport:off
/**
 * The query seam for claude-lhc instances. Each Claude session runs inside the claude-lhc sidecar,
 * a Node process that runs the Claude Agent SDK, records the thread into LHC, and forwards the
 * native SDK stream unchanged over JSONL stdio. The wire and the launch contract are claude-lhc's
 * `src/protocol.ts` and README.
 *
 * @module provider/Drivers/ClaudeLhcSidecar
 */
import type {
  McpServerConfig,
  McpSetServersResult,
  Options as ClaudeQueryOptions,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { ProviderInstanceId } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import sidecarPin from "../../../../../lhc/sidecar.json" with { type: "json" };

import type {
  ClaudeCreateQuery,
  ClaudeQueryRuntime,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
} from "../ClaudeModelCatalog.ts";

type SidecarFrame =
  | { readonly type: "msg"; readonly message: SDKMessage }
  | {
      readonly type: "req";
      readonly id: number;
      readonly method: "canUseTool" | "onUserDialog";
      readonly params: Record<string, unknown>;
    }
  | { readonly type: "res"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "res"; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly type: "abort"; readonly id: number }
  | { readonly type: "error"; readonly message: string };

type DriverControlMethod =
  | "interrupt"
  | "setModel"
  | "setPermissionMode"
  | "setMcpServers"
  | "applyFlagSettings"
  | "stopTask"
  | "backgroundTasks";

type DriverFrame =
  | { readonly type: "start"; readonly options: Record<string, unknown> }
  | { readonly type: "user"; readonly message: SDKUserMessage }
  | {
      readonly type: "req";
      readonly id: number;
      readonly method: DriverControlMethod;
      readonly params: unknown;
    }
  | { readonly type: "res"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "res"; readonly id: number; readonly ok: false; readonly error: string };

export interface SidecarPin {
  readonly package: string;
  readonly version: string;
}

export interface ClaudeLhcLaunch {
  readonly node: string;
  readonly entry: string;
  readonly home: string;
  readonly version: string;
}

export type ClaudeLhcSidecarResolution =
  | { readonly _tag: "ready"; readonly launch: ClaudeLhcLaunch }
  | { readonly _tag: "unavailable"; readonly reason: string };

export const CLAUDE_LHC_NODE_ENV = "CLAUDE_LHC_NODE";
export const CLAUDE_LHC_SIDECAR_ENV = "CLAUDE_LHC_SIDECAR";
const MIN_NODE_RANGE = ">=24.3.0";
const ROLLBACK_SIDECAR_RANGE = ">=0.2.0";
const CLOSE_GRACE_MS = 5_000;
const KILL_GRACE_MS = 5_000;

const NON_WIRE_OPTIONS = new Set([
  "abortController",
  "canUseTool",
  "executable",
  "executableArgs",
  "hooks",
  "onUserDialog",
  "sessionStore",
  "spawnClaudeCodeProcess",
  "stderr",
]);

/** Each T3 install keeps its LHC store beside its base dir, so two installs never share one. */
export function claudeLhcHome(baseDir: string): string {
  return `${NodePath.resolve(baseDir).replace(/[\\/]+$/, "")}-lhc`;
}

/** A sidecar that records a host rollback in LHC (claude-lhc 0.2.0, U11). */
export const sidecarHonorsRollback = (version: string): boolean =>
  satisfiesSemverRange(version, ROLLBACK_SIDECAR_RANGE);

function readNodeVersion(node: string): string | undefined {
  try {
    return NodeChildProcess.execFileSync(node, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    }).trim();
  } catch {
    return undefined;
  }
}

function readStagedPackage(entry: string): { name?: string; version?: string } | undefined {
  try {
    return JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(NodePath.dirname(NodePath.dirname(entry)), "package.json"),
        "utf8",
      ),
    ) as { name?: string; version?: string };
  } catch {
    return undefined;
  }
}

/**
 * Reads the instance environment for an explicit Node binary and the compiled sidecar entry, and
 * checks the package beside the entry against the pin in `lhc/sidecar.json`.
 */
export function resolveClaudeLhcSidecar(
  environment: NodeJS.ProcessEnv,
  baseDir: string,
  pin: SidecarPin = sidecarPin,
): ClaudeLhcSidecarResolution {
  const unavailable = (reason: string) => ({ _tag: "unavailable" as const, reason });
  const setting = (name: string) =>
    expandHomePath(environment[name]?.trim() ?? "", NodeOS.homedir());
  const node = setting(CLAUDE_LHC_NODE_ENV);
  if (node === "") {
    return unavailable(
      `Set ${CLAUDE_LHC_NODE_ENV} to a Node ${MIN_NODE_RANGE.slice(2)} or later binary.`,
    );
  }
  const nodeVersion = readNodeVersion(node);
  if (nodeVersion === undefined) {
    return unavailable(`${CLAUDE_LHC_NODE_ENV} names no runnable Node binary: ${node}`);
  }
  if (!satisfiesSemverRange(nodeVersion, MIN_NODE_RANGE)) {
    return unavailable(
      `${CLAUDE_LHC_NODE_ENV} is Node ${nodeVersion}; claude-lhc needs ${MIN_NODE_RANGE.slice(2)} or later.`,
    );
  }
  const entry = setting(CLAUDE_LHC_SIDECAR_ENV);
  if (entry === "") {
    return unavailable(
      `Set ${CLAUDE_LHC_SIDECAR_ENV} to the claude-lhc sidecar's dist/sidecar.js.`,
    );
  }
  if (!NodeFS.existsSync(entry)) {
    return unavailable(`${CLAUDE_LHC_SIDECAR_ENV} names a file that does not exist: ${entry}`);
  }
  const staged = readStagedPackage(entry);
  if (staged?.name !== pin.package || staged.version !== pin.version) {
    return unavailable(
      `The sidecar at ${entry} is ${staged?.name ?? "unknown"}@${staged?.version ?? "unknown"}; this build needs ${pin.package}@${pin.version}.`,
    );
  }
  return {
    _tag: "ready",
    launch: { node, entry, home: claudeLhcHome(baseDir), version: pin.version },
  };
}

export const UNCATALOGUED_CONTEXT_WINDOW = 200_000;

/**
 * The window Claude Code gives the model a query opens with. A model change opens a new query, so
 * each query sizes its own model. A model the catalog doesn't know gets Claude Code's own fallback:
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS when set, else 200k.
 */
export function lhcContextWindow(model: string, env: NodeJS.ProcessEnv): number | undefined {
  if (model === "") return undefined;
  if (model.endsWith("[1m]")) return 1_000_000;
  const known = resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, {
    instanceId: ProviderInstanceId.make("claude-lhc"),
    model,
  });
  if (known !== undefined) return known;
  const declared = Number(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  return Number.isInteger(declared) && declared > 0 ? declared : UNCATALOGUED_CONTEXT_WINDOW;
}

/**
 * The sidecar turns off Claude Code's auto-compact and compacts only at its trigger, so a trigger
 * at or above the model's window overflows first (the 700k default on a 200k model). Such a
 * trigger drops to 80% of the window, leaving room for one more tool result, and the rebuilt view
 * to at most half of that.
 */
export function fitLhcCompactionToContextWindow(input: {
  readonly autoCompactWindow: number;
  readonly lhcLowerBound: number;
  readonly contextWindow: number | undefined;
}): { readonly autoCompactWindow: number; readonly lhcLowerBound: number } {
  const { autoCompactWindow, lhcLowerBound, contextWindow } = input;
  if (contextWindow === undefined) return { autoCompactWindow, lhcLowerBound };
  const maxTrigger = Math.floor(contextWindow * 0.8);
  if (autoCompactWindow <= maxTrigger) return { autoCompactWindow, lhcLowerBound };
  return {
    autoCompactWindow: maxTrigger,
    lhcLowerBound: Math.min(lhcLowerBound, Math.floor(maxTrigger / 2)),
  };
}

export interface ClaudeLhcWindows {
  readonly autoCompactWindow: string;
  readonly lhcLowerBound: string;
}

interface SidecarLaunchCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly claudeBinary: string | undefined;
}

/**
 * The runner wraps the Claude binary in the agent's scope: the wrapper is the executable and the
 * binary is the last executable argument. The sidecar spawns Claude Code itself, so the wrapper
 * moves to the sidecar process and the wire carries the real binary.
 */
function sidecarLaunchCommand(
  options: ClaudeQueryOptions,
  launch: ClaudeLhcLaunch,
): SidecarLaunchCommand {
  const wrapperArgs = options.executableArgs ?? [];
  const wrapper = options.pathToClaudeCodeExecutable;
  if (wrapper === undefined || wrapperArgs.length === 0) {
    return { command: launch.node, args: [launch.entry], claudeBinary: wrapper };
  }
  return {
    command: wrapper,
    args: [...wrapperArgs.slice(0, -1), launch.node, launch.entry],
    claudeBinary: wrapperArgs.at(-1),
  };
}

function wireOptions(
  options: ClaudeQueryOptions,
  claudeBinary: string | undefined,
  windows: ClaudeLhcWindows,
  environment: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (NON_WIRE_OPTIONS.has(key) || typeof value === "function" || value === undefined) continue;
    wire[key] = value;
  }
  const model = typeof options.model === "string" ? options.model : "";
  const fitted = fitLhcCompactionToContextWindow({
    autoCompactWindow: Number(windows.autoCompactWindow),
    lhcLowerBound: Number(windows.lhcLowerBound),
    contextWindow: lhcContextWindow(model, { ...environment, ...options.env }),
  });
  const settings =
    typeof options.settings === "object" && options.settings !== null ? options.settings : {};
  return {
    ...wire,
    ...(claudeBinary === undefined ? {} : { pathToClaudeCodeExecutable: claudeBinary }),
    settings: { ...settings, ...fitted },
  };
}

/** Messages the runtime iterator drains; `fail` rejects the pending pull and every later one. */
class MessageQueue {
  readonly #items: SDKMessage[] = [];
  #ended = false;
  #failure: Error | undefined;
  #wake: (() => void) | undefined;

  push(message: SDKMessage): void {
    this.#items.push(message);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  fail(cause: Error): void {
    this.#failure ??= cause;
    this.#ended = true;
    this.#wake?.();
  }

  async next(): Promise<IteratorResult<SDKMessage, void>> {
    for (;;) {
      const item = this.#items.shift();
      if (item !== undefined) return { done: false, value: item };
      if (this.#ended) {
        if (this.#failure !== undefined) throw this.#failure;
        return { done: true, value: undefined };
      }
      await new Promise<void>((resolve) => {
        this.#wake = () => {
          this.#wake = undefined;
          resolve();
        };
      });
    }
  }
}

export interface ClaudeLhcQueryInput {
  readonly launch: ClaudeLhcLaunch;
  readonly windows: ClaudeLhcWindows;
  readonly environment: NodeJS.ProcessEnv;
}

export function makeClaudeLhcCreateQuery(sidecar: ClaudeLhcQueryInput): ClaudeCreateQuery {
  return (input) => startSidecarQuery(input, sidecar);
}

function startSidecarQuery(
  input: Parameters<ClaudeCreateQuery>[0],
  sidecar: ClaudeLhcQueryInput,
): ClaudeQueryRuntime {
  const { options } = input;
  const launchCommand = sidecarLaunchCommand(options, sidecar.launch);
  const messages = new MessageQueue();
  const pendingControls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: Error) => void }
  >();
  const inflightRequests = new Map<number, AbortController>();
  let nextControlId = 0;
  let closed = false;
  let stdinOpen = true;

  const child = NodeChildProcess.spawn(launchCommand.command, [...launchCommand.args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...sidecar.environment,
      T3CODE_LHC_HOME: sidecar.launch.home,
      T3CODE_THREAD_ID: input.threadId,
    },
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const log = (line: string): void => {
    process.stderr.write(`[claude-lhc:${child.pid ?? "?"}] ${line}\n`);
  };

  const send = (frame: DriverFrame): void => {
    if (!stdinOpen || child.stdin === null || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const endStdin = (): void => {
    if (!stdinOpen) return;
    stdinOpen = false;
    child.stdin?.end();
  };
  const failAll = (cause: Error): void => {
    for (const waiter of pendingControls.values()) waiter.reject(cause);
    pendingControls.clear();
    for (const controller of inflightRequests.values()) controller.abort();
    inflightRequests.clear();
  };

  child.on("error", (cause) => {
    messages.fail(
      new Error(`claude-lhc sidecar failed to start (${sidecar.launch.entry}): ${cause.message}`),
    );
    failAll(cause);
  });
  child.on("exit", (code, signal) => {
    stdinOpen = false;
    if (closed || code === 0) messages.end();
    else
      messages.fail(
        new Error(`claude-lhc sidecar exited (code ${code ?? "null"}, signal ${signal ?? "none"})`),
      );
    failAll(new Error("claude-lhc sidecar exited"));
  });
  child.stdin?.on("error", (cause) => log(`stdin: ${cause.message}`));
  if (child.stderr !== null) {
    NodeReadline.createInterface({ input: child.stderr }).on("line", log);
  }

  const answerRequest = async (frame: Extract<SidecarFrame, { type: "req" }>): Promise<void> => {
    const controller = new AbortController();
    inflightRequests.set(frame.id, controller);
    try {
      let value: unknown;
      if (frame.method === "canUseTool") {
        const { toolName, input: toolInput, ...rest } = frame.params;
        if (options.canUseTool === undefined) throw new Error("canUseTool is not configured");
        value = await options.canUseTool(
          String(toolName),
          (toolInput ?? {}) as Record<string, unknown>,
          { ...rest, signal: controller.signal } as Parameters<
            NonNullable<ClaudeQueryOptions["canUseTool"]>
          >[2],
        );
      } else {
        if (options.onUserDialog === undefined) throw new Error("onUserDialog is not configured");
        const { request, ...dialogOptions } = frame.params;
        value = await options.onUserDialog(
          request as Parameters<NonNullable<ClaudeQueryOptions["onUserDialog"]>>[0],
          {
            requestId: String(frame.id),
            ...dialogOptions,
            signal: controller.signal,
          } as Parameters<NonNullable<ClaudeQueryOptions["onUserDialog"]>>[1],
        );
      }
      if (!controller.signal.aborted) send({ type: "res", id: frame.id, ok: true, value });
    } catch (cause) {
      if (!controller.signal.aborted) {
        send({
          type: "res",
          id: frame.id,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    } finally {
      inflightRequests.delete(frame.id);
    }
  };

  if (child.stdout !== null) {
    NodeReadline.createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on(
      "line",
      (line) => {
        if (line.trim() === "") return;
        let frame: SidecarFrame;
        try {
          frame = JSON.parse(line) as SidecarFrame;
        } catch (cause) {
          log(`unreadable frame: ${cause instanceof Error ? cause.message : String(cause)}`);
          return;
        }
        switch (frame.type) {
          case "msg":
            messages.push(frame.message);
            return;
          case "req":
            void answerRequest(frame);
            return;
          case "res": {
            const waiter = pendingControls.get(frame.id);
            if (waiter === undefined) return;
            pendingControls.delete(frame.id);
            if (frame.ok) waiter.resolve(frame.value);
            else waiter.reject(new Error(frame.error));
            return;
          }
          case "abort":
            inflightRequests.get(frame.id)?.abort();
            return;
          case "error":
            messages.fail(new Error(frame.message));
            return;
        }
      },
    );
  }

  const control = (method: DriverControlMethod, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed || !stdinOpen) {
        reject(new Error("claude-lhc sidecar is closed"));
        return;
      }
      const id = ++nextControlId;
      pendingControls.set(id, { resolve, reject });
      send({ type: "req", id, method, params });
    });

  send({
    type: "start",
    options: wireOptions(options, launchCommand.claudeBinary, sidecar.windows, sidecar.environment),
  });

  void (async () => {
    try {
      for await (const message of input.prompt) {
        if (closed) break;
        send({ type: "user", message });
      }
    } catch (cause) {
      log(`prompt stream failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      endStdin();
    }
  })();

  const close = (): void => {
    if (closed) return;
    closed = true;
    endStdin();
    const term = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }, CLOSE_GRACE_MS);
    const kill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, CLOSE_GRACE_MS + KILL_GRACE_MS);
    void exited.then(() => {
      clearTimeout(term);
      clearTimeout(kill);
    });
    messages.end();
  };

  const runtime: ClaudeQueryRuntime = {
    next: () => messages.next(),
    return: async () => {
      close();
      return { done: true, value: undefined };
    },
    throw: async (cause?: unknown) => {
      close();
      throw cause;
    },
    [Symbol.asyncIterator]: () => runtime,
    [Symbol.asyncDispose]: async () => {
      close();
      await exited;
    },
    interrupt: async () => {
      await control("interrupt", {});
      return undefined;
    },
    setModel: async (model?: string) => {
      await control("setModel", { model });
    },
    setPermissionMode: async (mode: PermissionMode) => {
      await control("setPermissionMode", { mode });
    },
    setMcpServers: async (servers: Record<string, McpServerConfig>) =>
      (await control("setMcpServers", { servers })) as McpSetServersResult,
    applyFlagSettings: async (settings) => {
      await control("applyFlagSettings", { settings });
    },
    stopTask: async (taskId: string) => {
      await control("stopTask", { taskId });
    },
    backgroundTasks: async (toolUseId?: string) =>
      (await control("backgroundTasks", { toolUseId })) === true,
    close,
  };
  return runtime;
}
