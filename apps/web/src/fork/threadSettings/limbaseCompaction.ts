import {
  blockingProblems,
  type CompactionField,
  formatTokenAmount,
  formatTokens,
  type LimbaseCompaction,
  type LimbaseCompactionDefaults,
  type LimbaseCompactionThreadView,
  type LimbaseProfileName,
  resolveLimbaseCompaction,
  type ResolvedAmount,
  type TokenAmount,
} from "@t3tools/contracts";

export const COMPACTION_FIELDS = [
  { field: "compactAt", label: "Compact at" },
  { field: "downTo", label: "Down to" },
] as const satisfies ReadonlyArray<{ field: CompactionField; label: string }>;

const PROFILE_LABELS: Record<LimbaseProfileName, string> = {
  haiku: "Haiku models",
  standard: "200k models",
  "1m": "1M models",
};

/** `value` with `field` set to `amount`, or left out to inherit. */
export const withField = (
  value: LimbaseCompaction,
  field: CompactionField,
  amount: TokenAmount | undefined,
): LimbaseCompaction => {
  const next: { -readonly [K in CompactionField]?: TokenAmount } = { ...value };
  if (amount === undefined) delete next[field];
  else next[field] = amount;
  return next;
};

/** A thread's compaction as it would be with `value` as its own settings. */
export const resolveThreadCompaction = (
  view: LimbaseCompactionThreadView,
  value: LimbaseCompaction,
) =>
  resolveLimbaseCompaction({
    thread: value,
    instance: view.instance,
    defaults: view.profile === null ? undefined : view.defaults.profiles[view.profile],
    contextWindow: view.contextWindow,
    hardLimit: view.hardLimit,
    coldReturnSize: view.defaults.coldReturnSize,
  });

export const resolveInstanceCompaction = (
  defaults: LimbaseCompactionDefaults,
  value: LimbaseCompaction,
) =>
  resolveLimbaseCompaction({
    thread: {},
    instance: value,
    defaults: undefined,
    contextWindow: null,
    hardLimit: null,
    coldReturnSize: defaults.coldReturnSize,
  });

/** What a field left empty on the thread would get, for its placeholder. */
const inheritedLabel = (
  inherited: ResolvedAmount | undefined,
  profile: LimbaseProfileName | null,
) => {
  if (inherited === undefined) return "Limbase default, once the model reports its window";
  if (inherited.source === "default") {
    return `Default for ${profile === null ? "this model" : PROFILE_LABELS[profile]}: ${formatTokenAmount(inherited.amount)}`;
  }
  const tokens =
    "percent" in inherited.amount && inherited.tokens !== null
      ? ` (${formatTokens(inherited.tokens)})`
      : "";
  return `Instance: ${formatTokenAmount(inherited.amount)}${tokens}`;
};

export const threadPlaceholders = (view: LimbaseCompactionThreadView) => {
  const inherited = resolveThreadCompaction(view, {});
  return {
    compactAt: inheritedLabel(inherited.compactAt, view.profile),
    downTo: inheritedLabel(inherited.downTo, view.profile),
  } satisfies Record<CompactionField, string>;
};

export const instancePlaceholders = (defaults: LimbaseCompactionDefaults) => {
  const { profiles } = defaults;
  return {
    compactAt: `Default: ${formatTokens(profiles["1m"].trigger)} on 1M, ${formatTokens(profiles.standard.trigger)} on 200k`,
    downTo: `Default: ${formatTokens(profiles["1m"].target)} on 1M, ${formatTokens(profiles.standard.target)} on 200k`,
  } satisfies Record<CompactionField, string>;
};

export const threadBlockingMessages = (
  view: LimbaseCompactionThreadView,
  value: LimbaseCompaction,
) => blockingProblems(resolveThreadCompaction(view, value), "thread").map(({ message }) => message);

export const instanceBlockingMessages = (
  defaults: LimbaseCompactionDefaults,
  value: LimbaseCompaction,
) =>
  blockingProblems(resolveInstanceCompaction(defaults, value), "instance").map(
    ({ message }) => message,
  );
