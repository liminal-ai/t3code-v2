/* oxlint-disable t3code/no-untranslated-copy -- fork copy stays English, so the catalogs stay upstream's */
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  formatTokens,
  type LimbaseCompaction,
  type LimbaseCompactionThreadView,
  type ThreadId,
} from "@t3tools/contracts";

import { ThreadDetailsSection } from "../../components/chat/ThreadDetailsSection";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { refusalOf, setThreadSettings, threadSettingsQuery, useReload } from "./forkSettingsState";
import { LimbaseCompactionFields } from "./LimbaseCompactionFields";
import { threadBlockingMessages, threadNotices, threadPlaceholders } from "./limbaseCompaction";

export function ThreadSettingsCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const atom = threadSettingsQuery({
    environmentId: props.environmentId,
    input: { threadId: props.threadId },
  });
  const query = useEnvironmentQuery(atom);
  const reload = useReload(atom);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const save = useAtomCommand(setThreadSettings, { reportFailure: false });
  const compaction = query.data?.limbaseCompaction;
  if (compaction === undefined) return null;

  const saveCompaction = async (next: LimbaseCompaction) => {
    const result = await save({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, settings: { limbaseCompaction: next } },
    });
    if (result._tag === "Success") await reload();
    return refusalOf(result);
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-thread-settings-heading"
      title="Thread settings"
      data-testid="thread-settings-card"
    >
      <div className="flex flex-col gap-2 px-2.5">
        <LimbaseCompactionGroup
          threadId={props.threadId}
          view={compaction}
          disabled={!canOperate}
          onSave={saveCompaction}
        />
      </div>
    </ThreadDetailsSection>
  );
}

function LimbaseCompactionGroup(props: {
  readonly threadId: ThreadId;
  readonly view: LimbaseCompactionThreadView;
  readonly disabled: boolean;
  readonly onSave: (next: LimbaseCompaction) => Promise<string | null>;
}) {
  const { view } = props;
  return (
    <div className="flex flex-col gap-1.5" data-testid="thread-settings-limbase-compaction">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground/80">Limbase compaction</span>
        {view.applied !== null ? (
          <span className="truncate text-2xs text-muted-foreground">
            {formatTokens(view.applied.trigger)} → {formatTokens(view.applied.target)}
          </span>
        ) : null}
      </div>
      <LimbaseCompactionFields
        idPrefix={`thread-settings-${props.threadId}`}
        value={view.value}
        placeholders={threadPlaceholders(view)}
        notices={threadNotices(view)}
        disabled={props.disabled}
        blockingMessages={(next) => threadBlockingMessages(view, next)}
        onSave={props.onSave}
        renderRow={({ field, label, inputId, input }) => (
          <label key={field} htmlFor={inputId} className="grid min-w-0 gap-1">
            <span className="text-2xs text-muted-foreground">{label}</span>
            {input}
          </label>
        )}
      />
      <p className="text-2xs leading-snug text-muted-foreground">
        {view.contextWindow === null
          ? "Shares and defaults resolve once the model reports its context window."
          : `${view.model}, ${formatTokens(view.contextWindow)} window.`}
      </p>
    </div>
  );
}
