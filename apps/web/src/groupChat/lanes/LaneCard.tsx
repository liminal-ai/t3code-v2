import type {
  GroupChatDiscussion,
  GroupChatMember,
  GroupChatMessage,
  GroupChatPageDelivery,
} from "@t3tools/contracts";
import { memo, useRef, useState } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { formatTimestamp } from "../../timestampFormat";
import { PendingReply } from "../DeliveryStatus";
import { lateLabel } from "../discussion/discussionView";
import { memberColor } from "../MemberChip";
import { LONG_MESSAGE_CHARS, previewOf } from "../messageText";
import type { Emphasis } from "./model";

export const ACCENT = "var(--primary)";

const CARD =
  "relative w-full cursor-pointer rounded-lg border border-border bg-card px-2.5 pt-2 pb-2.25 text-left text-xs leading-snug text-foreground transition-[box-shadow,background-color,border-color] duration-300 ease-out [overflow-wrap:anywhere]";

const EMPHASIS_CLASS: Record<Emphasis, string> = {
  anchor:
    "border-transparent bg-[color-mix(in_srgb,var(--primary)_22%,var(--card))] shadow-[0_0_0_2px_var(--primary),0_10px_30px_-12px_var(--primary)]",
  started:
    "shadow-[0_0_0_1.5px_var(--background),0_0_0_3px_color-mix(in_srgb,var(--primary)_45%,transparent)]",
  in: "shadow-[0_0_0_1.5px_var(--lc),0_8px_22px_-14px_var(--lc)]",
  round: "shadow-[0_0_0_1px_color-mix(in_srgb,var(--lc)_40%,transparent)]",
  selected: "shadow-[0_0_0_2px_var(--lc),0_10px_26px_-12px_var(--lc)]",
  source: "shadow-[0_0_0_1.5px_var(--lc)]",
  seen: "shadow-[0_0_0_1px_color-mix(in_srgb,var(--lc)_55%,transparent)]",
};

const CONTENT_OPACITY: Partial<Record<Emphasis, string>> = {
  round: "opacity-[.68]",
  seen: "opacity-[.78]",
};

const LaneMarkdown = memo(function LaneMarkdown({ text }: { text: string }) {
  return <ChatMarkdown text={text} cwd={undefined} className="text-xs leading-snug" />;
});

function Collapsible({ text, markdown }: { readonly text: string; readonly markdown: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const shown = expanded || text.length <= LONG_MESSAGE_CHARS ? text : previewOf(text);
  const body = markdown ? (
    <LaneMarkdown text={shown} />
  ) : (
    <p className="whitespace-pre-wrap">{shown}</p>
  );
  if (text.length <= LONG_MESSAGE_CHARS) return body;
  return (
    <div ref={root}>
      <div className={cn(!expanded && "max-h-72 overflow-hidden")}>{body}</div>
      <Button
        size="xs"
        variant="link"
        onClick={(event) => {
          event.stopPropagation();
          const next = !expanded;
          setExpanded(next);
          if (!next) root.current?.scrollIntoView({ block: "nearest" });
        }}
        data-testid="show-all"
        data-expanded={expanded || undefined}
      >
        {expanded ? "Show less" : `Show all (${text.length.toLocaleString()} characters)`}
      </Button>
    </div>
  );
}

const clock = (iso: string) => formatTimestamp(iso, "locale");

export interface LaneCardProps {
  readonly message: GroupChatMessage;
  readonly member: GroupChatMember | undefined;
  readonly recipients: ReadonlyArray<GroupChatMember | undefined>;
  readonly discussion: GroupChatDiscussion | undefined;
  readonly emphasis: Emphasis | undefined;
  readonly dimmed: boolean;
  readonly lightDelayMs: number;
  readonly markdown: boolean;
  readonly onSelect: (message: GroupChatMessage) => void;
}

export const LaneCard = memo(function LaneCard({
  message,
  member,
  recipients,
  discussion,
  emphasis,
  dimmed,
  lightDelayMs,
  markdown,
  onSelect,
}: LaneCardProps) {
  const operator = message.author._tag === "operator";
  const color = member === undefined ? ACCENT : memberColor(member.color);
  const late = lateLabel(message, discussion);
  return (
    <div
      role="button"
      tabIndex={-1}
      data-testid="lane-message"
      data-message-id={message.id}
      data-turn={message.turnKey}
      data-highlighted={emphasis}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(message);
      }}
      className={cn(
        CARD,
        operator && "bg-secondary",
        emphasis === undefined ? "hover:border-foreground/15" : EMPHASIS_CLASS[emphasis],
        dimmed && "border-border/60",
      )}
      style={{ "--lc": color, transitionDelay: `${lightDelayMs}ms` } as React.CSSProperties}
    >
      <div
        className={cn(
          "transition-opacity duration-300",
          dimmed ? "opacity-50" : emphasis && CONTENT_OPACITY[emphasis],
        )}
      >
        <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs font-semibold leading-snug">
          <span
            className={cn(
              "max-w-full truncate",
              operator && emphasis !== "anchor" && "text-foreground/80",
            )}
            style={{ color: operator ? (emphasis === "anchor" ? ACCENT : undefined) : color }}
          >
            {member === undefined ? (operator ? "You" : "@removed") : `@${member.handle}`}
          </span>
          {message.kind === "discussion_prompt" ? (
            <Badge variant="info" size="sm">
              topic · {message.recipients.length} participants
              {discussion === undefined ? "" : ` · up to ${discussion.maxRounds} rounds`}
            </Badge>
          ) : null}
          {message.kind === "discussion_reply" && message.round !== null ? (
            <Badge variant="info" size="sm">
              round {message.round}
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
          {operator && message.kind === "chat" ? (
            <span className="min-w-0 truncate font-medium text-muted-foreground">
              {message.recipients.length === 0
                ? "logged only"
                : `→ ${recipients.map((r) => `@${r?.handle ?? "removed"}`).join(" ")}`}
            </span>
          ) : null}
          <span className="ms-auto font-medium tabular-nums text-muted-foreground/80">
            {clock(message.createdAt)}
          </span>
        </div>
        <Collapsible text={message.displayText} markdown={!operator && markdown} />
      </div>
    </div>
  );
});

export function PendingCard({
  delivery,
  member,
}: {
  readonly delivery: GroupChatPageDelivery;
  readonly member: GroupChatMember | undefined;
}) {
  return (
    <div
      className="w-full rounded-lg border border-dashed border-border px-2.5 py-1.5 text-2xs text-muted-foreground"
      data-testid="lane-pending"
      data-state={delivery.state}
    >
      <PendingReply delivery={delivery} member={member} />
    </div>
  );
}
