// @effect-diagnostics nodeBuiltinImport:off - the adapter's methods run with no FileSystem service.
/**
 * Runs the Claude threads of an instance whose `limbaseHome` is set on Limbase. Each such thread gets
 * one Limbase thread, whose id rides on the provider-thread row, and its SDK `query` goes through
 * Limbase's Agent SDK host: every message is captured, the SDK's own compaction is off, and the
 * session moves to a compacted view when one is due. A thread on any other instance is untouched.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { createSdkMcpServer, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSettings, OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { connectLimbase, createAgentSdkHost, threadCalls } from "@limbase/host-agent-sdk";
import hostPackage from "@limbase/host-agent-sdk/package.json" with { type: "json" };
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// zod is external to the CLI bundle; a single-executable loads it from disk only with require.
const zod = NodeModule.createRequire(import.meta.url)("zod") as typeof import("zod");

/** Limbase compacts a thread at the trigger, down to a view of about the target, in tokens. */
const COMPACT_POLICY = { trigger: 700_000, target: 100_000 } as const;

/** The Claude Code version whose session-file format the vendored host writes. */
export const TESTED_CLAUDE_CODE = hostPackage.limbase.claudeCode;

export class LimbaseThreadError extends Schema.TaggedError<LimbaseThreadError>()(
  "LimbaseThreadError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Limbase: ${this.detail}`;
  }
}

type Sdk = { readonly query: typeof query; readonly createSdkMcpServer: typeof createSdkMcpServer };
type Connection = Awaited<ReturnType<typeof connectLimbase>>;

const connections = new Map<string, Promise<Connection>>();

const connectionFor = (socketPath: string) => {
  let connection = connections.get(socketPath);
  if (connection === undefined) {
    connection = connectLimbase(socketPath);
    connections.set(socketPath, connection);
    connection.catch(() => connections.delete(socketPath));
  }
  return connection;
};

const homeOf = (settings: ClaudeSettings | undefined) => {
  const limbaseHome = settings?.limbaseHome ?? "";
  return limbaseHome === ""
    ? Effect.undefined
    : Effect.map(HostProcess.HomeDirectory, (home) => expandHomePath(limbaseHome, home));
};

const decodeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ socketPath: Schema.String })),
);

/** The service of a Limbase home, through the socket its config names. */
const connect = (home: string) => {
  const unreachable = (cause: unknown) =>
    new LimbaseThreadError({ detail: `could not reach the Limbase home ${home}`, cause });
  return Effect.tryPromise({
    try: () => NodeFSP.readFile(NodePath.join(home, "config", "membase.json"), "utf8"),
    catch: unreachable,
  }).pipe(
    Effect.flatMap((config) => Effect.mapError(decodeConfig(config), unreachable)),
    Effect.flatMap(({ socketPath }) =>
      Effect.tryPromise({ try: () => connectionFor(socketPath), catch: unreachable }),
    ),
  );
};

/**
 * The native metadata a new provider thread starts with: on a Limbase instance, a Limbase thread.
 * A row that already has one keeps it, so a fresh native session continues the same history.
 */
export const ensureThread = Effect.fn("Limbase.ensureThread")(function* (input: {
  readonly settings: ClaudeSettings | undefined;
  readonly existing: OrchestrationV2ProviderThread | undefined;
  readonly title: string | undefined;
  readonly cwd: string | null;
}) {
  const home = yield* homeOf(input.settings);
  if (home === undefined) return {};
  const kept = input.existing?.nativeMetadata?.limbaseThreadId;
  if (kept !== undefined) return { nativeMetadata: { limbaseThreadId: kept } };
  const connection = yield* connect(home);
  const thread = yield* Effect.tryPromise({
    try: () =>
      connection.call((c) =>
        c.CreateThread({
          ...(input.title === undefined
            ? {}
            : { title: input.title.replace(/\s+/g, " ").slice(0, 200) }),
          ...(input.cwd === null ? {} : { cwd: input.cwd }),
          compactPolicy: COMPACT_POLICY,
        }),
      ),
    catch: (cause) =>
      new LimbaseThreadError({
        detail: `the service did not create a thread (${(cause as Error).message})`,
        cause,
      }),
  });
  return { nativeMetadata: { limbaseThreadId: thread.threadId } };
});

/**
 * What to do after Limbase failed a step of a query an edit opened at a place, before the place took
 * hold. Resending in that query fails again, and only an edit opens a new one: at an earlier place
 * when Limbase cannot keep this one, or at the same place otherwise.
 */
const wayOutOfPlace = (what: string) =>
  what.startsWith("rollback refused: anchor") || what.startsWith("rollback refused: overBound")
    ? "Edit an earlier message to go on."
    : "Edit the message again to retry.";

/** A step Limbase failed: where, and the host's words for why. */
type FailedStep = { readonly where: string; readonly what: string };

/**
 * The CLI ends a step that Limbase failed with a successful `result`: at a prompt its text is the
 * hook's reason, and at a tool boundary it is empty with `terminal_reason: "hook_stopped"`. As an
 * error result carrying the host's reason, the run fails instead of ending as done. In a query an
 * edit opened at a place that no step has run from yet, the error also says which edit gets past it.
 */
const asFailedStep = (
  message: SDKMessage,
  failed: FailedStep | undefined,
  placed: boolean,
): SDKMessage => {
  const reason = failed === undefined ? "" : `limbase: stopped at ${failed.where}: ${failed.what}`;
  if (
    failed === undefined ||
    message.type !== "result" ||
    message.subtype !== "success" ||
    !(message.terminal_reason === "hook_stopped" || message.result.endsWith(reason))
  )
    return message;
  const { result: _result, ...rest } = message;
  return {
    ...rest,
    subtype: "error_during_execution" as const,
    is_error: true,
    errors: [placed ? `${reason}. ${wayOutOfPlace(failed.what)}` : reason],
  };
};

/**
 * The native metadata of the row an edit from the first message starts: a new Limbase thread when
 * the old row had one, so the history the edit removed is not served again.
 */
export const threadAfterReset = Effect.fn("Limbase.threadAfterReset")(function* (input: {
  readonly settings: ClaudeSettings | undefined;
  readonly reset: OrchestrationV2ProviderThread;
  readonly cwd: string | null;
}) {
  if (input.reset.nativeMetadata?.limbaseThreadId === undefined) return {};
  return yield* ensureThread({
    settings: input.settings,
    existing: undefined,
    title: undefined,
    cwd: input.cwd,
  });
});

/**
 * The SDK `query` for a thread on a Limbase instance, or undefined for a plain one. A thread that
 * began before the instance had a Limbase home has no Limbase thread and stays plain.
 */
export const queryFor = Effect.fn("Limbase.queryFor")(function* (
  settings: ClaudeSettings | undefined,
  providerThread: OrchestrationV2ProviderThread,
  sdk: Sdk = { query, createSdkMcpServer },
) {
  const home = yield* homeOf(settings);
  const limbaseThreadId = providerThread.nativeMetadata?.limbaseThreadId;
  if (home === undefined || limbaseThreadId === undefined) return undefined;
  const connection = yield* connect(home);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const hosted: typeof query = ({ prompt, options }) => {
    const { settings, ...rest } = options ?? {};
    if (typeof prompt === "string" || typeof settings === "string") {
      throw new Error("Limbase needs prompts as a stream and settings as an object.");
    }
    /** The reason of the step Limbase last failed, which the next `result` ends on. */
    let failedStep: FailedStep | undefined;
    /** Whether this query was opened at a place that no step has yet run from. */
    let placed = rest.resumeSessionAt !== undefined;
    const session = createAgentSdkHost({
      ...sdk,
      limbase: threadCalls(connection, limbaseThreadId),
      alias: providerThread.id,
      zod: zod.z,
      onEvent: (event) => {
        if (event.kind === "failOut") failedStep = { where: event.where, what: event.what };
      },
    }).query({ prompt, options: { ...rest, ...(settings === undefined ? {} : { settings }) } });
    const next = session.next.bind(session);
    const watched: typeof session = new Proxy(session, {
      get: (target, property) =>
        property === "next"
          ? async (...args: []) => {
              const result = await next(...args);
              if (result.done === true) return result;
              const message = asFailedStep(result.value, failedStep, placed);
              if (message.type === "result") failedStep = undefined;
              if (message.type === "result" && message.subtype === "success") placed = false;
              if (
                message.type === "system" &&
                message.subtype === "init" &&
                message.claude_code_version !== TESTED_CLAUDE_CODE
              ) {
                runFork(
                  Effect.logWarning("limbase.claude-code-version", {
                    running: message.claude_code_version,
                    tested: TESTED_CLAUDE_CODE,
                  }),
                );
              }
              return { ...result, value: message };
            }
          : property === Symbol.asyncIterator
            ? () => watched
            : Reflect.get(target, property),
    });
    return watched;
  };
  return hosted;
});

const REFUSALS = {
  fork: "Limbase does not fork threads yet",
} as const;

/** An action a Limbase thread cannot take yet. Its message is written for the user. */
export class LimbaseRefusal extends Schema.TaggedError<LimbaseRefusal>()("LimbaseRefusal", {
  action: Schema.Literals(["fork"]),
}) {
  override get message(): string {
    return REFUSALS[this.action];
  }
}

/** Refuses an action that a Limbase thread cannot take yet. */
export const refuse = (
  providerThread: OrchestrationV2ProviderThread,
  action: keyof typeof REFUSALS,
) =>
  providerThread.nativeMetadata?.limbaseThreadId === undefined
    ? Effect.void
    : Effect.fail(new LimbaseRefusal({ action }));

type LiveQuery = { readonly nativeThreadId: string; readonly stopping: boolean } | null;

/**
 * The session id the adapter's live state knows a row by. An install that had to close the CLI
 * process moves it to a new session id, which the row then stores as the one to resume, while the
 * adapter keeps the process's state under its first id. For a Limbase row whose stored id is the
 * one the running process moved to, that first id; otherwise the stored id.
 */
export const liveNativeId = (
  providerThread: OrchestrationV2ProviderThread,
  live: LiveQuery,
  moved: ReadonlyMap<string, string>,
) => {
  const stored = providerThread.nativeThreadRef?.nativeId;
  return providerThread.nativeMetadata?.limbaseThreadId !== undefined &&
    live !== null &&
    !live.stopping &&
    stored != null &&
    moved.get(live.nativeThreadId) === stored
    ? live.nativeThreadId
    : stored;
};

/** A turn on a row an install moved, keyed as `liveNativeId` resolves it, so it goes to the running process. */
export const onLiveSession = <
  Input extends { readonly providerThread: OrchestrationV2ProviderThread },
>(
  input: Input,
  live: LiveQuery,
  moved: ReadonlyMap<string, string>,
): Input => {
  const ref = input.providerThread.nativeThreadRef;
  const nativeId = liveNativeId(input.providerThread, live, moved);
  if (ref == null || nativeId == null || nativeId === ref.nativeId) return input;
  return {
    ...input,
    providerThread: { ...input.providerThread, nativeThreadRef: { ...ref, nativeId } },
  };
};
