import type { GroupChatDiscussion } from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { attempt, dispatchGroupChat } from "../api";
import { describeDelivery, PendingQuestion, RetryButton } from "../DeliveryStatus";
import { MemberDot, memberColor, ThreadLink } from "../MemberChip";
import type { GroupView } from "../store";
import { discussionView, type ParticipantRow, type ParticipantStatus } from "./discussionView";

const stopDiscussion = (discussion: GroupChatDiscussion) =>
  attempt(() => dispatchGroupChat({ _tag: "discussion.stop", discussionId: discussion.id }));

const handleOf = (row: ParticipantRow) => `@${row.member?.handle ?? "removed"}`;

function describeStatus(status: ParticipantStatus): {
  readonly word: string;
  readonly className: string;
} {
  switch (status._tag) {
    case "removed":
      return { word: "removed", className: "text-muted-foreground" };
    case "signed_off":
      return { word: "signed off", className: "text-success-foreground" };
    case "replied":
      return { word: "replied", className: "text-success-foreground" };
    case "late":
      return { word: "replied late, not counted", className: "text-muted-foreground" };
    case "open": {
      const label = describeDelivery(status.delivery).label;
      return {
        word: status.delivery.withdrawn === null ? label : `${label}, will not count`,
        className: "text-muted-foreground",
      };
    }
    case "paused":
      return { word: "stopped in T3", className: "text-warning-foreground" };
    case "failed":
      return { word: "failed", className: "text-destructive-foreground" };
    case "cancelled":
      return { word: "cancelled", className: "text-destructive-foreground" };
    case "no_delivery":
      return { word: "waiting", className: "text-muted-foreground" };
  }
}

function ParticipantChip({ row }: { row: ParticipantRow }) {
  const { member, status } = row;
  const { word, className } = describeStatus(status);
  const replied = status._tag === "replied" || status._tag === "signed_off";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-background/60 px-2 py-0.5 text-2xs",
        status._tag === "removed" && "text-muted-foreground line-through",
      )}
      data-testid="discussion-participant"
      data-handle={member?.handle}
      data-status={status._tag}
      data-replied={replied || undefined}
      data-signed-off={status._tag === "signed_off" || undefined}
    >
      {member === undefined ? null : <MemberDot member={member} />}
      <span style={{ color: member === undefined ? undefined : memberColor(member.color) }}>
        {handleOf(row)}
      </span>
      <span className={className}>{word}</span>
    </span>
  );
}

function WaitLine({ row }: { row: ParticipantRow }) {
  const { member, status } = row;
  if (member === undefined) return null;
  const handle = handleOf(row);
  if (status._tag === "paused") {
    return (
      <div
        className="flex flex-wrap items-center gap-2 text-2xs text-warning-foreground"
        data-testid="discussion-wait"
        data-handle={member.handle}
      >
        <span>
          {handle} · stopped in T3. Retry sends it to {handle} again. Stop ends the discussion.
        </span>
        <RetryButton delivery={status.delivery} />
        <ThreadLink member={member} className="text-2xs">
          Open the thread
        </ThreadLink>
      </div>
    );
  }
  if (status._tag !== "open") return null;
  const wait = status.delivery.wait;
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid="discussion-wait"
      data-handle={member.handle}
    >
      <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
        <span>
          {handle} · {describeDelivery(status.delivery).label}
        </span>
        <ThreadLink member={member} className="text-2xs">
          Open the thread
        </ThreadLink>
      </div>
      {wait?._tag === "waiting_on_question" ? (
        <PendingQuestion member={member} wait={wait} />
      ) : null}
    </div>
  );
}

function Names({ rows }: { rows: ReadonlyArray<ParticipantRow> }) {
  if (rows.length === 0) return <span className="text-muted-foreground">none</span>;
  return (
    <>
      {rows.map((row) => (
        <span
          key={row.memberId}
          className="me-1.5"
          style={{ color: row.member === undefined ? undefined : memberColor(row.member.color) }}
        >
          {handleOf(row)}
        </span>
      ))}
    </>
  );
}

export function DiscussionPanel({
  view,
  discussion,
  onDismiss,
}: {
  view: GroupView;
  discussion: GroupChatDiscussion;
  onDismiss: () => void;
}) {
  const projected = discussionView(view, discussion.id);
  if (projected === null) return null;
  const { running, round, maxRounds, participants } = projected;
  const failed = participants.filter(
    (row) => row.status._tag === "failed" || row.status._tag === "cancelled",
  );
  const { waitLines } = projected;
  const when = running ? "this round" : `in round ${round}`;
  return (
    <div
      className={cn(
        "mx-auto mb-2 flex max-h-[50dvh] w-full max-w-(--chat-content-max-width) flex-col gap-1.5 rounded-2xl border px-4 py-2.5 text-xs",
        running ? "border-info/24 bg-info/8" : "bg-muted",
      )}
      data-testid="discussion-panel"
      data-state={discussion.state}
      data-round={round}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {running ? <span className="size-1.5 rounded-full bg-info" /> : null}
        <span className="font-medium whitespace-nowrap">
          {running ? "Discussion" : "Discussion ended"}
        </span>
        <span className="text-muted-foreground whitespace-nowrap" data-testid="discussion-round">
          Round {round} of {maxRounds}
        </span>
        {running ? null : (
          <Badge variant="outline" size="sm" data-testid="discussion-end-reason">
            {discussion.endReason}
          </Badge>
        )}
        <div className="ms-auto">
          {running ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void stopDiscussion(discussion)}
              data-testid="discussion-stop"
            >
              Stop
            </Button>
          ) : (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss discussion summary"
              onClick={onDismiss}
              data-testid="discussion-dismiss"
            >
              <XIcon />
            </Button>
          )}
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={<p className="truncate text-2xs text-muted-foreground" />}
          data-testid="discussion-topic"
        >
          {discussion.topic}
        </TooltipTrigger>
        <TooltipPopup>{discussion.topic}</TooltipPopup>
      </Tooltip>
      <div className="flex flex-wrap gap-1.5">
        {participants.map((row) => (
          <ParticipantChip key={row.memberId} row={row} />
        ))}
      </div>
      {waitLines.length === 0 ? null : (
        <div className="flex min-h-0 flex-col gap-1 overflow-y-auto" data-testid="discussion-waits">
          {waitLines.map((row) => (
            <WaitLine key={row.memberId} row={row} />
          ))}
        </div>
      )}
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-2xs">
        <span className="text-muted-foreground">participants</span>
        <span>
          <Names rows={participants} />
        </span>
        <span className="text-muted-foreground">replied {when}</span>
        <span data-testid="discussion-replied">
          <Names rows={projected.replied} />
          {running && projected.waitingOn.length > 0 ? (
            <span className="text-muted-foreground">
              {" "}
              (waiting on {projected.waitingOn.map(handleOf).join(", ")})
            </span>
          ) : null}
        </span>
        <span className="text-muted-foreground">signed off {when}</span>
        <span data-testid="discussion-signed-off">
          <Names rows={projected.signedOff} />
        </span>
        {failed.length === 0 ? null : (
          <>
            <span className="text-destructive-foreground">failed or cancelled</span>
            <span className="text-destructive-foreground">{failed.map(handleOf).join(", ")}</span>
          </>
        )}
      </div>
      {running ? (
        <p className="text-2xs text-muted-foreground">
          You can still send messages: ticked members answer them as their own turn, and the other
          participants see them in their next round.
        </p>
      ) : null}
    </div>
  );
}
