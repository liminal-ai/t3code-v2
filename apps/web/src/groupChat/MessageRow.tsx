import type { GroupChatDeliveryHead, GroupChatMember, GroupChatMessage } from "@t3tools/contracts";
import { type ReactNode, useRef, useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { formatTimestamp } from "../timestampFormat";
import { DeliveryChip } from "./DeliveryStatus";
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

const clock = (iso: string) => formatTimestamp(iso, "locale");

export function OperatorMessage({
  message,
  members,
  deliveries,
}: {
  message: GroupChatMessage;
  members: ReadonlyMap<string, GroupChatMember>;
  deliveries: ReadonlyArray<GroupChatDeliveryHead>;
}) {
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
  if (turn === undefined || prompt === undefined || prompt.id === message.id) return null;
  return (
    <Button
      size="xs"
      variant="link"
      className="max-w-full justify-start"
      onClick={() => void onJump(prompt.id)}
      data-testid="reply-context"
    >
      <span className="truncate">
        ↳ {turn.label} · {plainSnippet(prompt.displayText)}
      </span>
    </Button>
  );
}

export function MemberMessage({
  message,
  member,
  turn,
  prompt,
  onJump,
}: {
  message: GroupChatMessage;
  member: GroupChatMember | undefined;
  turn: TurnInfo | undefined;
  prompt: GroupChatMessage | undefined;
  onJump: (messageId: GroupChatMessage["id"]) => Promise<void>;
}) {
  const lateLabel =
    message.kind === "discussion_reply" ? "arrived after the round · not counted" : "late reply";
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
        {message.signOff ? (
          <Badge variant="warning" size="sm" data-testid="signed-off">
            signed off
          </Badge>
        ) : null}
        {message.late ? (
          <Badge variant="outline" size="sm" data-testid="late-reply">
            {lateLabel}
          </Badge>
        ) : null}
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

export function SystemDivider({
  message,
  members,
  deliveries,
}: {
  message: GroupChatMessage;
  members: ReadonlyMap<string, GroupChatMember>;
  deliveries: ReadonlyArray<GroupChatDeliveryHead>;
}) {
  return (
    <div
      className="flex flex-col items-center gap-1"
      data-testid="system-message"
      data-message-id={message.id}
    >
      <div className="flex w-full items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span
          className={cn(
            "max-w-[80%] text-center",
            message.displayText.startsWith("Discussion ended") && "font-medium text-foreground/75",
          )}
        >
          {message.displayText}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
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
