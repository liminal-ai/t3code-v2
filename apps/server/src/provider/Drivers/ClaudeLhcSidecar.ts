// @effect-diagnostics globalTimers:off nodeBuiltinImport:off
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
}

export type ClaudeLhcSidecarResolution =
  | { readonly _tag: "ready"; readonly launch: ClaudeLhcLaunch }
  | { readonly _tag: "unavailable"; readonly reason: string };

export const CLAUDE_LHC_NODE_ENV = "CLAUDE_LHC_NODE";
export const CLAUDE_LHC_SIDECAR_ENV = "CLAUDE_LHC_SIDECAR";
const MIN_NODE_RANGE = ">=24.3.0";
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

export function claudeLhcHome(baseDir: string): string {
  return `${NodePath.resolve(baseDir).replace(/[\\/]+$/, "")}-lhc`;
}

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
    launch: { node, entry, home: claudeLhcHome(baseDir) },
  };
}

export const UNCATALOGUED_CONTEXT_WINDOW = 200_000;
const ONE_MILLION_SUFFIX = "[1m]";
const MAX_TRIGGER_SHARE_OF_WINDOW = 0.8;
const MAX_VIEW_SHARE_OF_FITTED_TRIGGER = 0.5;

export function lhcContextWindow(apiModelId: string): number | undefined {
  if (apiModelId === "") return undefined;
  const oneMillion = apiModelId.endsWith(ONE_MILLION_SUFFIX);
  const known = resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, {
    instanceId: ProviderInstanceId.make("claude-lhc"),
    model: oneMillion ? apiModelId.slice(0, -ONE_MILLION_SUFFIX.length) : apiModelId,
    options: [{ id: "contextWindow", value: oneMillion ? "1m" : "200k" }],
  });
  return known ?? (oneMillion ? 1_000_000 : UNCATALOGUED_CONTEXT_WINDOW);
}

export function fitLhcCompactionToContextWindow(input: {
  readonly autoCompactWindow: number;
  readonly lhcLowerBound: number;
  readonly contextWindow: number | undefined;
}): { readonly autoCompactWindow: number; readonly lhcLowerBound: number } {
  const { autoCompactWindow, lhcLowerBound, contextWindow } = input;
  if (contextWindow === undefined) return { autoCompactWindow, lhcLowerBound };
  const maxTrigger = Math.floor(contextWindow * MAX_TRIGGER_SHARE_OF_WINDOW);
  if (autoCompactWindow <= maxTrigger) return { autoCompactWindow, lhcLowerBound };
  return {
    autoCompactWindow: maxTrigger,
    lhcLowerBound: Math.min(
      lhcLowerBound,
      Math.floor(maxTrigger * MAX_VIEW_SHARE_OF_FITTED_TRIGGER),
    ),
  };
}

export interface ClaudeLhcWindows {
  readonly autoCompactWindow: string;
  readonly lhcLowerBound: string;
}

function fittedWindows(model: string | undefined, windows: ClaudeLhcWindows) {
  return fitLhcCompactionToContextWindow({
    autoCompactWindow: Number(windows.autoCompactWindow),
    lhcLowerBound: Number(windows.lhcLowerBound),
    contextWindow: lhcContextWindow(model ?? ""),
  });
}

function wireOptions(
  options: ClaudeQueryOptions,
  windows: ClaudeLhcWindows,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (NON_WIRE_OPTIONS.has(key) || typeof value === "function" || value === undefined) continue;
    wire[key] = value;
  }
  const settings =
    typeof options.settings === "object" && options.settings !== null ? options.settings : {};
  return { ...wire, settings: { ...settings, ...fittedWindows(options.model, windows) } };
}

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
  const { options, program } = input;
  if (program === undefined || options.spawnClaudeCodeProcess === undefined) {
    throw new Error("claude-lhc needs the Claude query runner to scope and spawn its sidecar.");
  }
  const messages = new MessageQueue();
  const pendingControls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: Error) => void }
  >();
  const inflightRequests = new Map<number, AbortController>();
  let nextControlId = 0;
  let closed = false;
  let stdinOpen = true;

  const terminate = new AbortController();
  const child = options.spawnClaudeCodeProcess({
    command: program.command,
    args: [...program.args],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: {
      ...sidecar.environment,
      T3CODE_LHC_HOME: sidecar.launch.home,
      T3CODE_THREAD_ID: input.threadId,
    },
    signal: terminate.signal,
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const log = (line: string): void => {
    process.stderr.write(`[claude-lhc:${input.threadId}] ${line}\n`);
  };

  const send = (frame: DriverFrame): void => {
    if (!stdinOpen || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const endStdin = (): void => {
    if (!stdinOpen) return;
    stdinOpen = false;
    child.stdin.end();
  };
  const failAll = (cause: Error): void => {
    for (const waiter of pendingControls.values()) waiter.reject(cause);
    pendingControls.clear();
    for (const controller of inflightRequests.values()) controller.abort();
    inflightRequests.clear();
  };

  child.on("error", (cause) => {
    stdinOpen = false;
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
  child.stdin.on("error", (cause) => log(`stdin: ${cause.message}`));

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
    options: wireOptions(options, sidecar.windows),
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
    const term = setTimeout(() => terminate.abort(), CLOSE_GRACE_MS);
    const kill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode == null) child.kill("SIGKILL");
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
      await control("setModel", { model, settings: fittedWindows(model, sidecar.windows) });
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
