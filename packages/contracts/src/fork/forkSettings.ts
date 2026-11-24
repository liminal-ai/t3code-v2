import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import { PositiveInt, ThreadId } from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";

export const TokenAmount = Schema.Union([
  Schema.Struct({ tokens: PositiveInt }),
  Schema.Struct({
    percent: Schema.Finite.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(100)),
  }),
]);
export type TokenAmount = typeof TokenAmount.Type;

export const LimbaseCompaction = Schema.Struct({
  compactAt: Schema.optionalKey(TokenAmount),
  downTo: Schema.optionalKey(TokenAmount),
});
export type LimbaseCompaction = typeof LimbaseCompaction.Type;

/** Every group, by key. A group left out of a write keeps its value; an empty group inherits. */
export const ForkSettingsGroups = Schema.Struct({
  limbaseCompaction: Schema.optionalKey(LimbaseCompaction),
});
export type ForkSettingsGroups = typeof ForkSettingsGroups.Type;

/** A field it names takes the amount, or inherits again at null. A field it leaves out keeps its value. */
export const LimbaseCompactionPatch = Schema.Struct({
  compactAt: Schema.optionalKey(Schema.NullOr(TokenAmount)),
  downTo: Schema.optionalKey(Schema.NullOr(TokenAmount)),
});
export type LimbaseCompactionPatch = typeof LimbaseCompactionPatch.Type;

export const ForkSettingsPatch = Schema.Struct({
  limbaseCompaction: Schema.optionalKey(LimbaseCompactionPatch),
});
export type ForkSettingsPatch = typeof ForkSettingsPatch.Type;

export const patchLimbaseCompaction = (
  value: LimbaseCompaction,
  patch: LimbaseCompactionPatch,
): LimbaseCompaction => {
  const next: { -readonly [K in keyof LimbaseCompaction]: LimbaseCompaction[K] } = { ...value };
  for (const field of ["compactAt", "downTo"] as const) {
    const amount = patch[field];
    if (amount === null) delete next[field];
    else if (amount !== undefined) next[field] = amount;
  }
  return next;
};

/** What Limbase stores for a thread, in tokens. */
export const LimbaseCompactPolicy = Schema.Struct({ trigger: PositiveInt, target: PositiveInt });
export type LimbaseCompactPolicy = typeof LimbaseCompactPolicy.Type;

export const LimbaseProfileName = Schema.Literals(["haiku", "standard", "1m"]);
export type LimbaseProfileName = typeof LimbaseProfileName.Type;

export const LimbaseCompactionDefaults = Schema.Struct({
  profiles: Schema.Struct({
    haiku: LimbaseCompactPolicy,
    standard: LimbaseCompactPolicy,
    "1m": LimbaseCompactPolicy,
  }),
  /** Limbase turns cold return off for a target at or above this size. */
  coldReturnSize: PositiveInt,
});
export type LimbaseCompactionDefaults = typeof LimbaseCompactionDefaults.Type;

export const LimbaseCompactionThreadView = Schema.Struct({
  value: LimbaseCompaction,
  instance: LimbaseCompaction,
  /** The model of the thread's last turn, and its context window once known. */
  model: Schema.NullOr(Schema.String),
  contextWindow: Schema.NullOr(PositiveInt),
  /** Where Limbase compacts in that window whatever the trigger: the window less its reserve. */
  hardLimit: Schema.NullOr(PositiveInt),
  /** Limbase's profile for that model, which a field neither the thread nor the instance sets gets. */
  profile: Schema.NullOr(LimbaseProfileName),
  defaults: LimbaseCompactionDefaults,
  /** The policy Limbase holds for the thread now, or null before it has a Limbase thread. */
  applied: Schema.NullOr(LimbaseCompactPolicy),
});
export type LimbaseCompactionThreadView = typeof LimbaseCompactionThreadView.Type;

export const LimbaseCompactionInstanceView = Schema.Struct({
  value: LimbaseCompaction,
  defaults: LimbaseCompactionDefaults,
});
export type LimbaseCompactionInstanceView = typeof LimbaseCompactionInstanceView.Type;

export const ThreadSettingsView = Schema.Struct({
  limbaseCompaction: Schema.optionalKey(LimbaseCompactionThreadView),
});
export type ThreadSettingsView = typeof ThreadSettingsView.Type;

export const InstanceSettingsView = Schema.Struct({
  limbaseCompaction: Schema.optionalKey(LimbaseCompactionInstanceView),
});
export type InstanceSettingsView = typeof InstanceSettingsView.Type;

export class ForkSettingsError extends Schema.TaggedError<ForkSettingsError>()(
  "ForkSettingsError",
  { message: Schema.String },
) {}

export const FORK_SETTINGS_WS_METHODS = {
  getThread: "forkSettings.getThread",
  setThread: "forkSettings.setThread",
  getInstance: "forkSettings.getInstance",
  setInstance: "forkSettings.setInstance",
} as const;

export const FORK_SETTINGS_RPC_SCOPES = {
  [FORK_SETTINGS_WS_METHODS.getThread]: AuthOrchestrationReadScope,
  [FORK_SETTINGS_WS_METHODS.setThread]: AuthOrchestrationOperateScope,
  [FORK_SETTINGS_WS_METHODS.getInstance]: AuthOrchestrationReadScope,
  [FORK_SETTINGS_WS_METHODS.setInstance]: AuthProvidersManageScope,
} as const;

const rpcError = Schema.Union([ForkSettingsError, EnvironmentAuthorizationError]);

export const FORK_SETTINGS_RPCS = [
  Rpc.make(FORK_SETTINGS_WS_METHODS.getThread, {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: ThreadSettingsView,
    error: rpcError,
  }),
  Rpc.make(FORK_SETTINGS_WS_METHODS.setThread, {
    payload: Schema.Struct({ threadId: ThreadId, settings: ForkSettingsPatch }),
    success: ThreadSettingsView,
    error: rpcError,
  }),
  Rpc.make(FORK_SETTINGS_WS_METHODS.getInstance, {
    payload: Schema.Struct({ instanceId: ProviderInstanceId }),
    success: InstanceSettingsView,
    error: rpcError,
  }),
  Rpc.make(FORK_SETTINGS_WS_METHODS.setInstance, {
    payload: Schema.Struct({ instanceId: ProviderInstanceId, settings: ForkSettingsPatch }),
    success: InstanceSettingsView,
    error: rpcError,
  }),
] as const;

const LIMBASE_MIN_OVERLAY_TARGET = 24_000;

const SUFFIXES = { k: 1_000, m: 1_000_000 } as const;

export const parseTokenAmount = (text: string): TokenAmount | undefined => {
  const trimmed = text.trim().toLowerCase().replaceAll(",", "").replaceAll("_", "");
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(trimmed);
  if (percent !== null) {
    const value = Number(percent[1]);
    return value > 0 && value <= 100 ? { percent: value } : undefined;
  }
  const tokens = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(trimmed);
  if (tokens === null) return undefined;
  const value = Math.round(
    Number(tokens[1]) * (tokens[2] === undefined ? 1 : SUFFIXES[tokens[2] as "k" | "m"]),
  );
  return value >= 1 ? { tokens: value } : undefined;
};

export const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000 && tokens % 10_000 === 0
    ? `${tokens / 1_000_000}M`
    : tokens >= 1_000 && tokens % 100 === 0
      ? `${tokens / 1_000}k`
      : tokens.toLocaleString("en-US");

export const formatTokenAmount = (amount: TokenAmount): string =>
  "tokens" in amount ? formatTokens(amount.tokens) : `${amount.percent}%`;

const tokensOf = (amount: TokenAmount, contextWindow: number | null): number | null =>
  "tokens" in amount
    ? amount.tokens
    : contextWindow === null
      ? null
      : Math.round((contextWindow * amount.percent) / 100);

export type CompactionSource = "thread" | "instance" | "default";

export interface ResolvedAmount {
  readonly amount: TokenAmount;
  readonly source: CompactionSource;
  readonly tokens: number | null;
}

export type CompactionField = keyof LimbaseCompaction;

export interface CompactionProblem {
  readonly fields: ReadonlyArray<CompactionField>;
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface ResolvedCompaction {
  readonly compactAt: ResolvedAmount | undefined;
  readonly downTo: ResolvedAmount | undefined;
  readonly policy: LimbaseCompactPolicy | undefined;
  readonly problems: ReadonlyArray<CompactionProblem>;
}

const notBelow = (low: ResolvedAmount, high: ResolvedAmount) =>
  low.tokens !== null && high.tokens !== null
    ? low.tokens >= high.tokens
    : "percent" in low.amount && "percent" in high.amount
      ? low.amount.percent >= high.amount.percent
      : false;

export const resolveLimbaseCompaction = (input: {
  readonly thread: LimbaseCompaction;
  readonly instance: LimbaseCompaction;
  readonly defaults: LimbaseCompactPolicy | undefined;
  readonly contextWindow: number | null;
  readonly hardLimit: number | null;
  readonly coldReturnSize: number;
}): ResolvedCompaction => {
  const resolve = (field: CompactionField, fallback: number | undefined) => {
    const own = input.thread[field];
    const inherited = input.instance[field];
    const [amount, source]: readonly [TokenAmount | undefined, CompactionSource] =
      own !== undefined
        ? [own, "thread"]
        : inherited !== undefined
          ? [inherited, "instance"]
          : [fallback === undefined ? undefined : { tokens: fallback }, "default"];
    return amount === undefined
      ? undefined
      : { amount, source, tokens: tokensOf(amount, input.contextWindow) };
  };
  const compactAt = resolve("compactAt", input.defaults?.trigger);
  const downTo = resolve("downTo", input.defaults?.target);
  const problems: CompactionProblem[] = [];
  const trigger = compactAt?.tokens ?? null;
  const target = downTo?.tokens ?? null;
  if (target !== null && target < LIMBASE_MIN_OVERLAY_TARGET) {
    problems.push({
      fields: ["downTo"],
      severity: "error",
      message: `Down to must be at least ${formatTokens(LIMBASE_MIN_OVERLAY_TARGET)}.`,
    });
  }
  if (compactAt !== undefined && downTo !== undefined && notBelow(downTo, compactAt)) {
    problems.push({
      fields: ["downTo", "compactAt"],
      severity: "error",
      message: `Down to (${formatTokenAmount(downTo.amount)}) must be below compact at (${formatTokenAmount(compactAt.amount)}).`,
    });
  }
  if (trigger !== null && input.contextWindow !== null && trigger > input.contextWindow) {
    problems.push(
      compactAt?.source === "thread"
        ? {
            fields: ["compactAt"],
            severity: "error",
            message: `Compact at (${formatTokens(trigger)}) must fit the model's ${formatTokens(input.contextWindow)} window.`,
          }
        : {
            fields: ["compactAt"],
            severity: "warning",
            message: `${formatTokens(trigger)} is past the model's ${formatTokens(input.contextWindow)} window, so Limbase compacts at its hard limit${input.hardLimit === null ? "" : `, ${formatTokens(input.hardLimit)}`}.`,
          },
    );
  }
  if (target !== null && target >= input.coldReturnSize) {
    problems.push({
      fields: ["downTo"],
      severity: "warning",
      message: `At ${formatTokens(input.coldReturnSize)} or more, Limbase turns cold return off.`,
    });
  }
  const policy =
    trigger !== null && target !== null && problems.every((problem) => problem.severity !== "error")
      ? { trigger, target }
      : undefined;
  return { compactAt, downTo, policy, problems };
};

export const blockingProblems = (resolved: ResolvedCompaction, level: CompactionSource) =>
  resolved.problems.filter(
    (problem) =>
      problem.severity === "error" &&
      problem.fields.some((field) => resolved[field]?.source === level),
  );
