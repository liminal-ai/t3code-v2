import type { GroupChatGroupId, GroupChatMember, GroupChatMemberId } from "@t3tools/contracts";
import { ArrowUpIcon } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Textarea } from "../components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { attempt, dispatchGroupChat } from "./api";
import {
  completeMention,
  type Draft,
  loadRecipients,
  mentionAtCaret,
  saveRecipients,
  sendCommand,
  suggestions,
  draftAfterSend,
  tickedAfterTyping,
} from "./composer";
import { MemberDot, memberColor } from "./MemberChip";
import { type GroupView, noteMessage, openDeliveryByMember } from "./store";

function StatusDot({ tone, label }: { tone: "warning" | "muted"; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "size-1.5 rounded-full",
              tone === "warning" ? "bg-warning" : "bg-muted-foreground/60",
            )}
            data-testid={tone === "warning" ? "composer-needs-answer" : "composer-busy"}
          />
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export function Composer({
  groupId,
  members,
  view,
}: {
  groupId: GroupChatGroupId;
  members: ReadonlyArray<GroupChatMember>;
  view: GroupView;
}) {
  const [draft, setDraft] = useState<Draft>({ groupId, text: "" });
  const text = draft.groupId === groupId ? draft.text : "";
  const setText = (value: string) => setDraft({ groupId, text: value });
  const [ticked, setTicked] = useState<ReadonlyArray<GroupChatMemberId>>(() =>
    loadRecipients(groupId),
  );
  const [tickedGroup, setTickedGroup] = useState(groupId);
  if (tickedGroup !== groupId) {
    setTickedGroup(groupId);
    setTicked(loadRecipients(groupId));
    setText("");
  }
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [sendingGroups, setSendingGroups] = useState<ReadonlySet<GroupChatGroupId>>(new Set());
  const sending = sendingGroups.has(groupId);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const activeIds = new Set(members.map((m) => m.id));
  const tickedActive = ticked.filter((id) => activeIds.has(id));
  const openByMember = openDeliveryByMember(view);

  const updateTicked = (next: ReadonlyArray<GroupChatMemberId>) => {
    setTicked(next);
    saveRecipients(groupId, next);
  };

  const partial = mentionAtCaret(text, caret);
  const menu = partial === null || menuDismissed ? [] : suggestions(members, partial);
  const menuOpen = menu.length > 0;

  const onChange = (value: string, position: number) => {
    setText(value);
    setCaret(position);
    setMenuIndex(0);
    setMenuDismissed(false);
    const next = tickedAfterTyping(tickedActive, value, members);
    if (next !== tickedActive) updateTicked(next);
  };

  const pick = (member: GroupChatMember) => {
    const completed = completeMention(text, caret, member);
    setText(completed.text);
    setCaret(completed.caret);
    if (!tickedActive.includes(member.id)) updateTicked([...tickedActive, member.id]);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(completed.caret, completed.caret);
    });
  };

  const send = async () => {
    if (text.trim() === "" || sending) return;
    const submitted: Draft = { groupId, text };
    setSendingGroups((groups) => new Set(groups).add(groupId));
    setText("");
    setCaret(0);
    const result = await attempt(() =>
      dispatchGroupChat(sendCommand(groupId, submitted.text, tickedActive, members)),
    );
    setSendingGroups((groups) => {
      const next = new Set(groups);
      next.delete(submitted.groupId);
      return next;
    });
    if (result?._tag === "message") noteMessage(result.message);
    setDraft((draftNow) => draftAfterSend(draftNow, submitted, result !== undefined));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setMenuIndex((i) => (i + (event.key === "ArrowDown" ? 1 : menu.length - 1)) % menu.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(menu[menuIndex % menu.length]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const hint =
    tickedActive.length === 0
      ? "Nobody ticked: the message is only logged in the group, no member is asked to reply."
      : `Sends one catch-up envelope to ${
          tickedActive.length === members.length
            ? "everyone"
            : tickedActive.map((id) => `@${members.find((m) => m.id === id)?.handle}`).join(", ")
        }. Ticks stay after sending.`;

  return (
    <div className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-1.5">
      {menuOpen ? (
        <ul
          role="listbox"
          aria-label="Mention a member"
          data-testid="mention-menu"
          className="absolute bottom-full left-3 z-30 mb-2 w-64 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {menu.map((member, i) => {
            const selected = i === menuIndex % menu.length;
            return (
              <li key={member.id} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(member);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                    selected ? "bg-accent" : "hover:bg-accent",
                  )}
                >
                  <MemberDot member={member} />
                  <span className="font-medium" style={{ color: memberColor(member.color) }}>
                    @{member.handle}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {member.thread.title}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex flex-col gap-2 rounded-2xl border bg-background p-2 shadow-xs">
        <Textarea
          ref={textarea}
          unstyled
          size="sm"
          value={text}
          rows={2}
          aria-label="Message"
          placeholder="Message the group. Type @ to address a member."
          onChange={(event) => onChange(event.target.value, event.target.selectionStart)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => updateTicked(members.map((m) => m.id))}
              >
                Tick all
              </Button>
              <Button size="xs" variant="ghost-muted" onClick={() => updateTicked([])}>
                Clear
              </Button>
            </div>
            <div
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5"
              data-testid="recipients"
            >
              {members.map((member) => {
                const on = tickedActive.includes(member.id);
                const open = openByMember.get(member.id);
                const wait = open?.wait?._tag;
                return (
                  <label
                    key={member.id}
                    className="flex cursor-pointer items-center gap-1.5 text-sm select-none"
                  >
                    <Checkbox
                      checked={on}
                      aria-label={`Address @${member.handle}`}
                      onCheckedChange={(checked) =>
                        updateTicked(
                          checked
                            ? [...tickedActive, member.id]
                            : tickedActive.filter((id) => id !== member.id),
                        )
                      }
                    />
                    <span style={{ color: on ? memberColor(member.color) : undefined }}>
                      @{member.handle}
                    </span>
                    {wait === "waiting_on_question" || wait === "waiting_on_approval" ? (
                      <StatusDot
                        tone="warning"
                        label="Waiting on you: see its pending reply above"
                      />
                    ) : wait === "busy_with_own_run" ? (
                      <StatusDot tone="muted" label="Busy with its own run" />
                    ) : null}
                  </label>
                );
              })}
            </div>
          </div>
          <Button
            size="icon-sm"
            aria-label="Send"
            onClick={() => void send()}
            disabled={text.trim() === "" || sending}
          >
            <ArrowUpIcon />
          </Button>
        </div>
      </div>
      <p className="px-3 text-2xs text-muted-foreground" data-testid="recipient-hint">
        {hint}
      </p>
    </div>
  );
}
