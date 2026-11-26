/* oxlint-disable t3code/no-untranslated-copy -- fork copy stays English, so the catalogs stay upstream's */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import { ThreadAgentRow } from "./ThreadAgentRow";
import { LimbaseCompactionRow } from "./threadSettings/LimbaseCompactionRow";

/**
 * The fork's rows at the foot of the thread details card, under the context row.
 * `data-thread-details-fork` keeps them out of the card's density measure, so they never
 * push an upstream section out. Being last, they are the first rows a short card scrolls away.
 */
export function ThreadDetailsFootRows(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isDraft: boolean;
  /** Without the context row to join, the rows take a section of their own. */
  readonly standalone?: boolean;
}) {
  const rows = (
    <div
      className="col-span-3 flex flex-col empty:hidden"
      {...(props.standalone ? {} : { "data-thread-details-fork": "" })}
    >
      {props.isDraft ? null : (
        <LimbaseCompactionRow environmentId={props.environmentId} threadId={props.threadId} />
      )}
      {/* Thread status, set a little apart from the context and compaction pair. */}
      <ThreadAgentRow
        environmentId={props.environmentId}
        threadId={props.threadId}
        className={props.standalone ? "not-first:mt-1.5" : "mt-1.5"}
      />
    </div>
  );
  if (!props.standalone) return rows;
  return (
    <ThreadDetailsSection
      headingId="thread-details-fork-heading"
      title="Thread"
      showHeading={false}
      data-thread-details-fork=""
    >
      {rows}
    </ThreadDetailsSection>
  );
}
