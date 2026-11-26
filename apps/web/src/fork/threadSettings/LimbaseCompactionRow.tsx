/* oxlint-disable t3code/no-untranslated-copy -- fork copy stays English, so the catalogs stay upstream's */
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  formatTokens,
  type LimbaseCompactionPatch,
  type LimbaseCompactionThreadView,
  type ThreadId,
} from "@t3tools/contracts";
import { ArrowRightIcon, ChevronRightIcon } from "lucide-react";

import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { THREAD_DETAILS_FOOT_ROW_CLASS } from "../threadDetailsFootStyles";
import { setThreadSettings, threadSettingsQuery, useThreadOnLimbase } from "./forkSettingsState";
import { LimbaseCompactionFields } from "./LimbaseCompactionFields";
import {
  threadBlankHint,
  threadBlockingMessages,
  threadNotices,
  threadPlaceholders,
  threadPolicyShown,
} from "./limbaseCompaction";
import { useAcknowledgedWrites, type WriteStatus } from "./useAcknowledgedWrites";

/** One foot row of the details card on a Limbase thread. It opens the thread's compaction fields. */
export function LimbaseCompactionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const onLimbase = useThreadOnLimbase(props.environmentId, props.threadId);
  if (!onLimbase) return null;
  return (
    <OwnedLimbaseCompactionRow
      key={`${props.environmentId}\n${props.threadId}`}
      environmentId={props.environmentId}
      threadId={props.threadId}
    />
  );
}

function OwnedLimbaseCompactionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const save = useAtomCommand(setThreadSettings, { reportFailure: false });
  const { data, status, write } = useAcknowledgedWrites(
    threadSettingsQuery({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
    (settings) =>
      save({ environmentId: props.environmentId, input: { threadId: props.threadId, settings } }),
  );
  const view = data?.limbaseCompaction;
  if (view === undefined) return null;

  const policy = threadPolicyShown(view);
  const notices = threadNotices(view);
  const tone = notices.some((notice) => notice.tone === "error")
    ? "error"
    : notices.length > 0
      ? "warning"
      : null;
  // A value the thread sets itself reads in the foreground; an inherited one stays muted.
  const amountClass = (own: boolean) =>
    tone === "error"
      ? "text-error-foreground"
      : tone === "warning"
        ? "text-warning-foreground"
        : own
          ? "text-foreground/80"
          : "text-muted-foreground";

  const rowProps = {
    "aria-label":
      policy === null
        ? "Limbase compaction: Limbase default"
        : `Limbase compaction: ${formatTokens(policy.trigger)} to ${formatTokens(policy.target)}`,
    "data-testid": "thread-settings-limbase-compaction",
    // The usage rows' size, with the hover, focus and open fill of the panel's other rows.
    className: cn(
      THREAD_DETAILS_FOOT_ROW_CLASS,
      "group cursor-pointer gap-2 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]",
    ),
  };
  return (
    <Popover>
      <PopoverTrigger render={<button type="button" {...rowProps} />}>
        <span className="min-w-0 flex-1 truncate text-start text-muted-foreground group-hover:text-foreground group-data-popup-open:text-foreground">
          Limbase compaction
        </span>
        {policy === null ? (
          <span className="shrink-0 font-medium text-muted-foreground">Limbase default</span>
        ) : (
          <span className="flex shrink-0 items-center gap-1 font-medium tabular-nums">
            <span className={amountClass(view.value.compactAt !== undefined)}>
              {formatTokens(policy.trigger)}
            </span>
            <ArrowRightIcon aria-hidden className="size-3 text-muted-foreground/80" />
            <span className={amountClass(view.value.downTo !== undefined)}>
              {formatTokens(policy.target)}
            </span>
          </span>
        )}
        {/* A 16px box, so the chevron centres under the panel's 16px chevrons above. */}
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
          <ChevronRightIcon className="size-3.5 text-muted-foreground" />
        </span>
      </PopoverTrigger>
      {/* Rows sit 8px inside the card; clear its edge, as the usage rows' tooltips do. */}
      <PopoverPopup side="left" align="end" sideOffset={16} className="w-88">
        <LimbaseCompactionEditor
          threadId={props.threadId}
          view={view}
          disabled={!canOperate}
          status={status}
          write={(limbaseCompaction) => write({ limbaseCompaction })}
        />
      </PopoverPopup>
    </Popover>
  );
}

function LimbaseCompactionEditor(props: {
  readonly threadId: ThreadId;
  readonly view: LimbaseCompactionThreadView;
  readonly disabled: boolean;
  readonly status: WriteStatus;
  readonly write: (patch: LimbaseCompactionPatch) => Promise<string | null>;
}) {
  const { view } = props;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <PopoverTitle>Limbase compaction</PopoverTitle>
        <p className="text-xs text-muted-foreground">
          {view.model} ·{" "}
          {view.contextWindow === null
            ? "window unknown"
            : `${formatTokens(view.contextWindow)} window`}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-2">
        <LimbaseCompactionFields
          idPrefix={`thread-settings-${props.threadId}`}
          value={view.value}
          placeholders={threadPlaceholders(view)}
          notices={threadNotices(view)}
          disabled={props.disabled}
          blockingMessages={(next) => threadBlockingMessages(view, next)}
          status={props.status}
          write={props.write}
          inputSize="compact"
          messagesClassName="col-span-2"
          renderRow={({ field, label, inputId, input }) => (
            <label key={field} htmlFor={inputId} className="grid min-w-0 gap-1">
              <span className="text-xs text-muted-foreground">{label}</span>
              {input}
            </label>
          )}
        />
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        {view.contextWindow === null
          ? "Nothing you save reaches Limbase until Claude reports the window. "
          : ""}
        {threadBlankHint(view)}
      </p>
    </div>
  );
}
