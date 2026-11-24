// @effect-diagnostics nodeBuiltinImport:off - the adapter's methods run with no FileSystem service.
/**
 * Runs the Claude threads of an instance whose `limbaseHome` is set on Limbase. Each such thread gets
 * one Limbase thread, whose id rides on the provider-thread row, and its SDK `query` goes through
 * Limbase's Agent SDK host: every message is captured, and when a view is due the running CLI
 * compacts onto it through the host's plugin. A thread on any other instance is untouched.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import {
  createSdkMcpServer,
  query,
  type SDKMessage,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ClaudeSettings,
  type CompactionProblem,
  type ForkSettingsError,
  type LimbaseCompaction,
  type LimbaseCompactionDefaults,
  type LimbaseCompactPolicy,
  type OrchestrationV2ProviderThread,
  resolveLimbaseCompaction,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  COLD_RETURN,
  connectLimbase,
  createAgentSdkHost,
  hardLimitOf,
  PROFILES,
  profileFor,
  threadCalls,
} from "@limbase/host-agent-sdk";
import hostPackage from "@limbase/host-agent-sdk/package.json" with { type: "json" };
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as LimbaseMigration from "./LimbaseMigration.ts";

// zod is external to the CLI bundle; a single-executable loads it from disk only with require.
const zod = NodeModule.createRequire(import.meta.url)("zod") as typeof import("zod");

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

/**
 * The settings without the instance's own compact window. The CLI ranks a window in its settings over
 * the one the host sets in its environment, and would compact on its own long before Limbase's trigger.
 */
const withoutCompactWindow = ({ autoCompactWindow: _window, env, ...settings }: Settings) => {
  if (env === undefined) return settings;
  const { CLAUDE_CODE_AUTO_COMPACT_WINDOW: _envWindow, ...kept } = env;
  return { ...settings, env: kept };
};

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

const policyOf = ({ trigger, target }: LimbaseCompactPolicy): LimbaseCompactPolicy => ({
  trigger,
  target,
});

export const COMPACTION_DEFAULTS: LimbaseCompactionDefaults = {
  profiles: {
    haiku: policyOf(PROFILES.haiku),
    standard: policyOf(PROFILES.standard),
    "1m": policyOf(PROFILES["1m"]),
  },
  coldReturnSize: COLD_RETURN.size,
};

export const FIXED_COMPACTION_BEFORE_SETTINGS: LimbaseCompaction = {
  compactAt: { tokens: 700_000 },
  downTo: { tokens: 100_000 },
};

const PROFILE_NAMES = Object.keys(PROFILES) as ReadonlyArray<keyof typeof PROFILES>;

const profileNameFor = (model: string, contextWindow: number | null) => {
  if (contextWindow === null) return null;
  const profile = profileFor(model, contextWindow);
  return PROFILE_NAMES.find((name) => PROFILES[name] === profile) ?? null;
};

export const resolveCompaction = (input: {
  readonly thread: LimbaseCompaction;
  readonly instance: LimbaseCompaction;
  readonly model: string;
  readonly contextWindow: number | null;
}) =>
  resolveLimbaseCompaction({
    thread: input.thread,
    instance: input.instance,
    defaults:
      input.contextWindow === null
        ? undefined
        : policyOf(profileFor(input.model, input.contextWindow)),
    contextWindow: input.contextWindow,
    hardLimit: input.contextWindow === null ? null : hardLimitOf(input.contextWindow),
    coldReturnSize: COLD_RETURN.size,
  });

export interface Compaction {
  readonly settings: Effect.Effect<
    { readonly thread: LimbaseCompaction; readonly instance: LimbaseCompaction },
    ForkSettingsError
  >;
  readonly model: string;
  readonly claudeContextWindow: () => number | null;
}

type PolicyDecision =
  | { readonly _tag: "Apply"; readonly policy: LimbaseCompactPolicy }
  | { readonly _tag: "AwaitWindow" }
  | { readonly _tag: "Refused"; readonly problems: ReadonlyArray<CompactionProblem> };

const decidePolicy = Effect.fn("Limbase.decidePolicy")(function* (
  compaction: Compaction,
): Effect.fn.Return<PolicyDecision, ForkSettingsError> {
  const contextWindow = compaction.claudeContextWindow();
  if (contextWindow === null) return { _tag: "AwaitWindow" };
  const settings = yield* compaction.settings;
  const resolved = resolveCompaction({ ...settings, model: compaction.model, contextWindow });
  return resolved.policy === undefined
    ? {
        _tag: "Refused",
        problems: resolved.problems.filter((problem) => problem.severity === "error"),
      }
    : { _tag: "Apply", policy: resolved.policy };
});

type LimbaseThreadId = Parameters<Parameters<Connection["call"]>[0]>[0] extends {
  readonly GetThread: (input: { readonly threadId: infer Id }) => unknown;
}
  ? Id
  : never;

const setPolicy = (
  connection: Connection,
  limbaseThreadId: string,
  policy: LimbaseCompactPolicy,
) => {
  const threadId = limbaseThreadId as LimbaseThreadId;
  return Effect.tryPromise({
    try: async () => {
      const held = (await connection.call((c) => c.GetThread({ threadId }))).compactPolicy;
      if (held?.trigger === policy.trigger && held.target === policy.target) return;
      await connection.call((c) => c.SetCompactPolicy({ threadId, compactPolicy: policy }));
    },
    catch: (cause) =>
      new LimbaseThreadError({
        detail: `the service refused the compaction policy (${(cause as Error).message})`,
        cause,
      }),
  });
};

const reconcileCompaction = (
  connection: Connection,
  limbaseThreadId: string,
  compaction: Compaction,
) =>
  decidePolicy(compaction).pipe(
    Effect.flatMap((decision) =>
      decision._tag === "Apply"
        ? setPolicy(connection, limbaseThreadId, decision.policy)
        : decision._tag === "Refused"
          ? Effect.logWarning("limbase.compaction-refused", { problems: decision.problems })
          : Effect.void,
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("limbase.compaction-not-applied", { limbaseThreadId, cause }),
    ),
  );

const heldPolicy = Effect.fn("Limbase.heldPolicy")(
  function* (settings: ClaudeSettings | undefined, limbaseThreadId: string) {
    const home = yield* homeOf(settings);
    if (home === undefined) return null;
    const connection = yield* connect(home);
    const threadId = limbaseThreadId as LimbaseThreadId;
    const held = yield* Effect.tryPromise({
      try: () => connection.call((c) => c.GetThread({ threadId })),
      catch: (cause) =>
        new LimbaseThreadError({ detail: "the service did not read the thread", cause }),
    }).pipe(Effect.map((thread) => thread.compactPolicy));
    return held === undefined ? null : policyOf(held);
  },
  Effect.orElseSucceed(() => null),
);

export const threadCompactionView = Effect.fn("Limbase.threadCompactionView")(function* (input: {
  readonly settings: ClaudeSettings | undefined;
  readonly limbaseThreadId: string | undefined;
  readonly value: LimbaseCompaction;
  readonly instance: LimbaseCompaction;
  readonly model: string;
  readonly contextWindow: number | null;
}) {
  return {
    value: input.value,
    instance: input.instance,
    model: input.model,
    contextWindow: input.contextWindow,
    hardLimit: input.contextWindow === null ? null : hardLimitOf(input.contextWindow),
    profile: profileNameFor(input.model, input.contextWindow),
    defaults: COMPACTION_DEFAULTS,
    applied:
      input.limbaseThreadId === undefined
        ? null
        : yield* heldPolicy(input.settings, input.limbaseThreadId),
  };
});

export const applyPolicy = Effect.fn("Limbase.applyPolicy")(function* (
  settings: ClaudeSettings | undefined,
  limbaseThreadId: string,
  policy: LimbaseCompactPolicy,
) {
  const home = yield* homeOf(settings);
  if (home === undefined) return;
  yield* setPolicy(yield* connect(home), limbaseThreadId, policy);
});

/**
 * The native metadata a new provider thread starts with: on a Limbase instance, a Limbase thread.
 * A row that already has one keeps it, so a fresh native session continues the same history.
 */
export const ensureThread = Effect.fn("Limbase.ensureThread")(function* (input: {
  readonly settings: ClaudeSettings | undefined;
  readonly existing: OrchestrationV2ProviderThread | undefined;
  readonly title: string | undefined;
  readonly cwd: string | null;
  readonly compaction: Compaction | undefined;
}) {
  const home = yield* homeOf(input.settings);
  if (home === undefined) return {};
  const kept = input.existing?.nativeMetadata?.limbaseThreadId;
  if (kept !== undefined) return { nativeMetadata: { limbaseThreadId: kept } };
  const connection = yield* connect(home);
  const decision =
    input.compaction === undefined
      ? undefined
      : yield* decidePolicy(input.compaction).pipe(
          Effect.catchCause((cause) =>
            Effect.as(Effect.logWarning("limbase.compaction-not-read", { cause }), undefined),
          ),
        );
  const compactPolicy = decision?._tag === "Apply" ? decision.policy : undefined;
  const thread = yield* Effect.tryPromise({
    try: () =>
      connection.call((c) =>
        c.CreateThread({
          ...(input.title === undefined
            ? {}
            : { title: input.title.replace(/\s+/g, " ").slice(0, 200) }),
          ...(input.cwd === null ? {} : { cwd: input.cwd }),
          ...(compactPolicy === undefined ? {} : { compactPolicy }),
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
    compaction: undefined,
  });
});

/**
 * The SDK `query` for a thread on a Limbase instance, or undefined for a plain one. A thread that
 * began before the instance had a Limbase home has no Limbase thread and stays plain.
 */
export const queryFor = Effect.fn("Limbase.queryFor")(function* (
  settings: ClaudeSettings | undefined,
  providerThread: OrchestrationV2ProviderThread,
  compaction: Compaction | undefined,
  sdk: Sdk = { query, createSdkMcpServer },
) {
  const home = yield* homeOf(settings);
  const limbaseThreadId = providerThread.nativeMetadata?.limbaseThreadId;
  if (home === undefined || limbaseThreadId === undefined) return undefined;
  const connection = yield* connect(home);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const reconcile =
    compaction === undefined
      ? Effect.void
      : reconcileCompaction(connection, limbaseThreadId, compaction);
  let awaitingWindow = compaction !== undefined && compaction.claudeContextWindow() === null;
  if (!awaitingWindow) yield* reconcile;
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
    }).query({
      prompt,
      options: {
        ...rest,
        ...(settings === undefined ? {} : { settings: withoutCompactWindow(settings) }),
      },
    });
    const next = session.next.bind(session);
    const watched: typeof session = new Proxy(session, {
      get: (target, property) =>
        property === "next"
          ? async (...args: []) => {
              if (awaitingWindow && compaction?.claudeContextWindow() !== null) {
                awaitingWindow = false;
                runFork(reconcile);
              }
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

export const sessionFileHoldsUnsentLines = (providerThread: OrchestrationV2ProviderThread) =>
  providerThread.nativeMetadata?.limbaseThreadId !== undefined;

/**
 * Whether the row's first query resumes its session though T3 has run no turn on it: a row bound to
 * a migrated Limbase thread. Its session file does not exist yet, and only a resume makes the host
 * write it from Limbase before the CLI starts; a new session would start without the history.
 */
export const resumesMigratedHistory = (providerThread: OrchestrationV2ProviderThread) =>
  LimbaseMigration.migratedThroughRunOrdinal(providerThread) !== undefined;

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

/**
 * The turn a Resume starts. The CLI's native resume continues the cut turn from an empty prompt, and
 * the host fails that step and refuses every later one at the view seam, so a Limbase thread is sent
 * the prompt Resume sent before upstream resumed natively.
 */
export const resumeTurnInput = (
  input: ProviderAdapter.ProviderAdapterV2ResumeTurnInput,
): ProviderAdapter.ProviderAdapterV2TurnInput => {
  if (input.providerThread.nativeMetadata?.limbaseThreadId === undefined) {
    return ProviderAdapter.resumeTurnInput(input);
  }
  const { messageId, ...turn } = input;
  return {
    ...turn,
    message: {
      messageId,
      text: "Continue where you left off.",
      attachments: [],
      createdBy: "user",
      creationSource: "server",
    },
  };
};
