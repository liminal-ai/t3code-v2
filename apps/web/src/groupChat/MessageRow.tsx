import type {
  GroupChatDiscussion,
  GroupChatPageDelivery,
  GroupChatMember,
  GroupChatMessage,
} from "@t3tools/contracts";
import { type ReactNode, useRef, useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { formatShortTimestamp } from "../timestampFormat";
import { DeliveryChip } from "./DeliveryStatus";
import { lateLabel, type RoundDivider, roundDivider } from "./discussion/discussionView";
import { MemberLabel } from "./MemberChip";
import { LONG_MESSAGE_CHARS, plainSnippet, previewOf } from "./messageText";
import type { TurnInfo } from "./store";

function Collapsible({ text, render }: { text: string; render: (text: string) => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  if (text.length <= LONG_MESSAGE_CHARS) return <>{render(text)}</>;
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next) root.current?.scrollIntoView({ block: "nearest" });
  };
  return (
    <div ref={root}>
      {render(expanded ? text : previewOf(text))}
      <Button
        size="xs"
        variant="link"
        onClick={toggle}
        data-testid="show-all"
        data-expanded={expanded || undefined}
      >
        {expanded ? "Show less" : `Show all (${text.length.toLocaleString()} characters)`}
      </Button>
    </div>
  );
}

const clock = (iso: string) => formatShortTimestamp(iso, "locale");

export function OperatorMessage({
  message,
  members,
  deliveries,
  discussion,
}: {
  message: GroupChatMessage;
  members: ReadonlyMap<string, GroupChatMember>;
  deliveries: ReadonlyArray<GroupChatPageDelivery>;
  discussion: GroupChatDiscussion | undefined;
}) {
  const divider = roundDivider(message, discussion);
  return (
    <div
      className="flex flex-col items-end gap-1"
      data-testid="operator-message"
      data-seq={message.seq}
      data-message-id={message.id}
    >
      {message.kind === "discussion_prompt" ? (
        <p className="me-1 text-2xs text-info-foreground">
          Discussion topic · {message.recipients.length} participants
          {discussion === undefined ? "" : ` · up to ${discussion.maxRounds} rounds`}
        </p>
      ) : null}
      <div className="max-w-[85%] rounded-2xl bg-message p-3 text-foreground" data-bubble>
        <Collapsible
          text={message.displayText}
          render={(text) => (
            <div className="text-sm leading-relaxed whitespace-pre-wrap">{text}</div>
          )}
        />
      </div>
      <div className="flex max-w-[85%] flex-wrap items-center justify-end gap-1 pe-1 text-2xs text-muted-foreground">
        {message.recipients.length === 0 ? (
          <span data-testid="logged-only">Logged only · nobody addressed</span>
        ) : (
          deliveries.map((d) => (
            <DeliveryChip key={d.id} delivery={d} member={members.get(d.memberId)} />
          ))
        )}
        <span className="ms-1 tabular-nums opacity-70">{clock(message.createdAt)}</span>
      </div>
      {divider?._tag === "round" ? <RoundDividerLine divider={divider} /> : null}
    </div>
  );
}

function ReplyContext({
  message,
  turn,
  prompt,
  onJump,
}: {
  message: GroupChatMessage;
  turn: TurnInfo | undefined;
  prompt: GroupChatMessage | undefined;
  onJump: (messageId: GroupChatMessage["id"]) => Promise<void>;
}) {
  const promptId = turn?.promptId ?? null;
  if (turn === undefined || promptId === null || promptId === message.id) return null;
  // The prompt may sit on a page not loaded yet; the jump pages back to it.
  return (
    <Button
      size="xs"
      variant="link"
      className="max-w-full justify-start"
      onClick={() => void onJump(promptId)}
      data-testid="reply-context"
    >
      <span className="truncate">
        ↳ {turn.label === null ? "" : `${turn.label} · `}
        {prompt === undefined ? "earlier message" : plainSnippet(prompt.displayText)}
      </span>
    </Button>
  );
}

export function MemberMessage({
  message,
  member,
  turn,
  prompt,
  discussion,
  onJump,
}: {
  message: GroupChatMessage;
  member: GroupChatMember | undefined;
  turn: TurnInfo | undefined;
  prompt: GroupChatMessage | undefined;
  discussion: GroupChatDiscussion | undefined;
  onJump: (messageId: GroupChatMessage["id"]) => Promise<void>;
}) {
  const late = lateLabel(message, discussion);
  return (
    <div
      className="flex flex-col gap-1 px-1 py-0.5"
      data-testid="member-message"
      data-handle={member?.handle}
      data-seq={message.seq}
      data-message-id={message.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <MemberLabel member={member} />
        {message.kind === "discussion_reply" ? (
          <Badge variant="info" size="sm">
            round {message.round}
          </Badge>
        ) : null}
        {message.kind === "inbound" ? (
          <Badge variant="outline" size="sm" data-testid="inbound-message">
            posted on its own
          </Badge>
        ) : null}
        {message.signOff ? (
          <Badge variant="warning" size="sm" data-testid="signed-off">
            signed off
          </Badge>
        ) : null}
        {late === null ? null : (
          <Badge variant="outline" size="sm" data-testid="late-reply">
            {late}
          </Badge>
        )}
        <span className="text-2xs tabular-nums text-muted-foreground/70">
          {clock(message.createdAt)}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 pl-5.5">
        <ReplyContext message={message} turn={turn} prompt={prompt} onJump={onJump} />
        <Collapsible
          text={message.displayText}
          render={(text) => <ChatMarkdown text={text} cwd={undefined} />}
        />
      </div>
    </div>
  );
}

function RoundDividerLine({ divider }: { divider: Extract<RoundDivider, { _tag: "round" }> }) {
  return (
    <div
      className="flex w-full items-center gap-3 text-xs text-muted-foreground"
      data-testid="round-divider"
      data-round={divider.round}
    >
      <span className="h-px flex-1 bg-border" />
      <Badge variant="info" size="sm">
        Round {divider.round} of {divider.maxRounds}
      </Badge>
      <span className="max-w-[70%] truncate">{divider.caption}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function DividerText({
  message,
  divider,
}: {
  message: GroupChatMessage;
  divider: RoundDivider | null;
}) {
  if (divider?._tag === "round") return <RoundDividerLine divider={divider} />;
  const ended = divider?._tag === "ended";
  return (
    <div className="flex w-full items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span
        className={cn("flex max-w-[80%] flex-col text-center", ended && "gap-0.5")}
        data-testid={ended ? "discussion-ended" : undefined}
      >
        <span className={cn(ended && "font-medium text-foreground/75")}>
          {ended ? divider.endSentence : message.displayText}
        </span>
        {ended && divider.note !== null ? <span>{divider.note}</span> : null}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function SystemDivider({
  message,
  members,
  deliveries,
  divider,
}: {
  message: GroupChatMessage;
  members: ReadonlyMap<string, GroupChatMember>;
  deliveries: ReadonlyArray<GroupChatPageDelivery>;
  divider: RoundDivider | null;
}) {
  return (
    <div
      className="flex flex-col items-center gap-1"
      data-testid="system-message"
      data-message-id={message.id}
    >
      <DividerText message={message} divider={divider} />
      {deliveries.length === 0 ? null : (
        <div className="flex flex-wrap justify-center gap-1">
          {deliveries.map((d) => (
            <DeliveryChip key={d.id} delivery={d} member={members.get(d.memberId)} />
          ))}
        </div>
      )}
    </div>
  );
}
