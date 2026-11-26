/* oxlint-disable t3code/no-untranslated-copy -- fork copy stays English, so the catalogs stay upstream's */
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
  type ResolvedCompaction,
} from "@t3tools/contracts";

export interface CompactionNotice {
  readonly tone: "error" | "warning";
  readonly text: string;
}

export const COMPACTION_FIELDS = [
  { field: "compactAt", label: "Compact at" },
  { field: "downTo", label: "Down to" },
] as const satisfies ReadonlyArray<{ field: CompactionField; label: string }>;

const PROFILE_LABELS: Record<LimbaseProfileName, string> = {
  haiku: "Haiku models",
  standard: "200k models",
  "1m": "1M models",
};

const resolveThreadCompaction = (view: LimbaseCompactionThreadView, value: LimbaseCompaction) =>
  resolveLimbaseCompaction({
    thread: value,
    instance: view.instance,
    defaults: view.profile === null ? undefined : view.defaults.profiles[view.profile],
    contextWindow: view.contextWindow,
    hardLimit: view.hardLimit,
    coldReturnSize: view.defaults.coldReturnSize,
  });

/** The policy Limbase holds, or before the thread has a Limbase thread, the one T3 would create it with. */
export const threadPolicyShown = (view: LimbaseCompactionThreadView) =>
  view.applied ?? resolveThreadCompaction(view, view.value).policy ?? null;

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

/** What a blank field falls back to: the instance's value, Limbase's default for the model, or both. */
export const threadBlankHint = (view: LimbaseCompactionThreadView) => {
  const inherited = resolveThreadCompaction(view, {});
  const sources = new Set(
    COMPACTION_FIELDS.map(({ field }) => inherited[field]?.source ?? "default"),
  );
  if (!sources.has("default")) return "Blank uses the instance setting.";
  if (!sources.has("instance")) return "Blank uses Limbase's default for the model.";
  return "Blank uses the instance setting, or Limbase's default for the model.";
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

export const warningNotices = (resolved: ResolvedCompaction): ReadonlyArray<CompactionNotice> =>
  resolved.problems
    .filter((problem) => problem.severity === "warning")
    .map(({ message }) => ({ tone: "warning", text: message }));

export const threadNotices = (
  view: LimbaseCompactionThreadView,
): ReadonlyArray<CompactionNotice> => {
  const savedValueRefusals = threadBlockingMessages(view, view.value);
  const kept =
    view.applied === null
      ? "Limbase uses its own default"
      : `Limbase keeps ${formatTokens(view.applied.trigger)} → ${formatTokens(view.applied.target)}`;
  return [
    ...(savedValueRefusals.length === 0
      ? []
      : [
          {
            tone: "error" as const,
            text: `${savedValueRefusals.join(" ")} ${kept} until you change it.`,
          },
        ]),
    ...warningNotices(resolveThreadCompaction(view, view.value)),
  ];
};
