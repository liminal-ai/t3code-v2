import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type LimbaseCompaction,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { SettingsRow } from "../../components/settings/settingsLayout";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { instanceSettingsQuery, refusalOf, setInstanceSettings } from "./forkSettingsState";
import { LimbaseCompactionFields } from "./LimbaseCompactionFields";
import {
  instanceBlockingMessages,
  instancePlaceholders,
  resolveInstanceCompaction,
} from "./limbaseCompaction";

const DESCRIPTIONS = {
  compactAt:
    "Limbase compacts a thread once it passes this many tokens (700k) or this share of the model's window (70%). A thread's own setting wins, and a change reaches each thread at its next turn. Empty uses Limbase's default for the model.",
  downTo:
    "How large a view a compaction leaves, at least 24k and below compact at. Empty uses Limbase's default for the model.",
} as const;

const limbaseHomeOf = (config: unknown) =>
  typeof config === "object" && config !== null && "limbaseHome" in config
    ? String(config.limbaseHome).trim()
    : "";

/** The instance-level Limbase compaction, which every thread on the instance inherits. */
export function LimbaseInstanceCompaction(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly config: unknown;
}) {
  if (limbaseHomeOf(props.config) === "") return null;
  return (
    <LimbaseInstanceCompactionRows
      environmentId={props.environmentId}
      instanceId={props.instanceId}
    />
  );
}

function LimbaseInstanceCompactionRows(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const query = useEnvironmentQuery(
    instanceSettingsQuery({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId },
    }),
  );
  const canManage = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  const save = useAtomCommand(setInstanceSettings, { reportFailure: false });
  const compaction = query.data?.limbaseCompaction;
  if (compaction === undefined) return null;

  const onSave = async (next: LimbaseCompaction) => {
    const result = await save({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, settings: { limbaseCompaction: next } },
    });
    if (result._tag === "Success") query.refresh();
    return refusalOf(result);
  };

  return (
    <div data-testid="instance-limbase-compaction">
      <LimbaseCompactionFields
        idPrefix={`provider-instance-${props.instanceId}-limbase-compaction`}
        value={compaction.value}
        placeholders={instancePlaceholders(compaction.defaults)}
        warnings={resolveInstanceCompaction(compaction.defaults, compaction.value).problems.filter(
          (problem) => problem.severity === "warning",
        )}
        disabled={!canManage}
        blockingMessages={(next) => instanceBlockingMessages(compaction.defaults, next)}
        onSave={onSave}
        messagesClassName="px-4 pb-3 sm:px-5"
        renderRow={({ field, label, inputId, input }) => (
          <SettingsRow
            key={field}
            title={<label htmlFor={inputId}>Limbase: {label.toLowerCase()}</label>}
            description={DESCRIPTIONS[field]}
            control={
              <div className="flex w-full min-w-0 @min-[32rem]/settings-row:w-56">{input}</div>
            }
          />
        )}
      />
    </div>
  );
}
