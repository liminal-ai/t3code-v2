// @effect-diagnostics nodeBuiltinImport:off - the adapter's methods run with no FileSystem service.
/**
 * Runs the Claude threads of an instance whose `limbaseHome` is set on Limbase. Each such thread gets
 * one Limbase thread, whose id rides on the provider-thread row, and its SDK `query` goes through
 * Limbase's Agent SDK host: every message is captured, the SDK's own compaction is off, and the
 * session moves to a compacted view when one is due. A thread on any other instance is untouched.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSettings, OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { connectLimbase, createAgentSdkHost, threadCalls } from "@limbase/host-agent-sdk";
import hostPackage from "@limbase/host-agent-sdk/package.json" with { type: "json" };
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
    const session = createAgentSdkHost({
      ...sdk,
      limbase: threadCalls(connection, limbaseThreadId),
      alias: providerThread.id,
    }).query({ prompt, options: { ...rest, ...(settings === undefined ? {} : { settings }) } });
    const next = session.next.bind(session);
    const watched: typeof session = new Proxy(session, {
      get: (target, property) =>
        property === "next"
          ? async (...args: []) => {
              const result = await next(...args);
              const message = result.done === true ? undefined : result.value;
              if (
                message?.type === "system" &&
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
              return result;
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
  rollback: "Edit from here does not work on a Limbase thread yet.",
} as const;

/** An action a Limbase thread cannot take yet. Its message is written for the user. */
export class LimbaseRefusal extends Schema.TaggedError<LimbaseRefusal>()("LimbaseRefusal", {
  action: Schema.Literals(["fork", "rollback"]),
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

const isRefusal = Schema.is(LimbaseRefusal);

/** The refusal's message when `error` was caused by one, for a client that shows only known causes. */
export const refusalIn = (error: unknown): string | undefined => {
  for (let cause = error; typeof cause === "object" && cause !== null;) {
    if (isRefusal(cause)) return cause.message;
    cause = (cause as { readonly cause?: unknown }).cause;
  }
  return undefined;
};

/**
 * An install moves the live CLI process to a new session id, which the row then stores as the one
 * to resume. A turn on that row while the process still runs keeps the process's first id, which
 * the adapter's live state is keyed by, so the turn goes to the running process.
 */
export const onLiveSession = <
  Input extends { readonly providerThread: OrchestrationV2ProviderThread },
>(
  input: Input,
  live: { readonly nativeThreadId: string; readonly stopping: boolean } | null,
  moved: ReadonlyMap<string, string>,
): Input => {
  const ref = input.providerThread.nativeThreadRef;
  if (
    input.providerThread.nativeMetadata?.limbaseThreadId === undefined ||
    ref === null ||
    live === null ||
    live.stopping ||
    moved.get(live.nativeThreadId) !== ref.nativeId
  )
    return input;
  return {
    ...input,
    providerThread: {
      ...input.providerThread,
      nativeThreadRef: { ...ref, nativeId: live.nativeThreadId },
    },
  };
};
