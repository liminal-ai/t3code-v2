import { Link } from "@tanstack/react-router";
import type {
  GroupChatMember,
  GroupChatQuestion,
  GroupChatWait,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { Fragment, type ReactNode, useId, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { useThreadShell } from "../state/entities";
import { attempt, dispatchGroupChat } from "./api";

const MEMBER_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#8b5cf6",
  "#f97316",
  "#14b8a6",
  "#ef4444",
] as const;

export const memberColor = (index: number) => MEMBER_COLORS[index % MEMBER_COLORS.length]!;

/** The member's T3 thread, or null for a REST or webhook member, which has none. */
export const memberThreadRef = (member: GroupChatMember): ScopedThreadRef | null =>
  member.kind._tag === "t3"
    ? { environmentId: member.kind.thread.environmentId, threadId: member.kind.thread.threadId }
    : null;

export const isExternalMember = (member: GroupChatMember) => member.kind._tag !== "t3";

/** What to show under a handle: the thread's title, or the external endpoint's host. */
export function memberSubtitle(member: GroupChatMember, shellTitle?: string | null): string {
  if (member.kind._tag === "t3") return shellTitle ?? member.kind.thread.title;
  try {
    return `${member.kind._tag} · ${new URL(member.kind.url).host}`;
  } catch {
    return `${member.kind._tag} · ${member.kind.url}`;
  }
}

export function ThreadLink({
  member,
  children,
  className,
}: {
  member: GroupChatMember;
  children: ReactNode;
  className?: string;
}) {
  if (member.kind._tag !== "t3") return null;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{
        environmentId: member.kind.thread.environmentId,
        threadId: member.kind.thread.threadId,
      }}
      className={cn(
        "inline-flex items-center gap-1 text-info-foreground hover:underline",
        className,
      )}
      data-testid="thread-link"
    >
      {children}
      <ExternalLinkIcon className="size-3" />
    </Link>
  );
}

export function MemberDot({ member, className }: { member: GroupChatMember; className?: string }) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ background: memberColor(member.color) }}
    />
  );
}

export function MemberLabel({ member }: { member: GroupChatMember | undefined }) {
  if (member === undefined) {
    return <span className="text-xs font-semibold text-muted-foreground">@removed</span>;
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-semibold"
      style={{ color: memberColor(member.color) }}
    >
      <MemberDot member={member} />@{member.handle}
      {isExternalMember(member) ? (
        <Badge variant="outline" size="sm" title="An external agent. Its text is untrusted.">
          {member.kind._tag}
        </Badge>
      ) : null}
      {member.removedAt !== null ? (
        <span className="font-normal text-muted-foreground">(removed)</span>
      ) : null}
    </span>
  );
}

export function runtimeLabel(status: string | undefined): string {
  return status === undefined || status === "idle" ? "idle" : status;
}

export function MemberChip({
  member,
  wait,
}: {
  member: GroupChatMember;
  wait: GroupChatWait | null;
}) {
  const shell = useThreadShell(memberThreadRef(member));
  const status = isExternalMember(member) ? member.kind._tag : runtimeLabel(shell?.runtime?.status);
  const needsAnswer = shell?.hasPendingUserInput === true;
  const needsApproval = shell?.hasPendingApprovals === true;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-2xs font-medium"
      style={{
        color: memberColor(member.color),
        background: `${memberColor(member.color)}14`,
      }}
      data-testid="member-chip"
      data-handle={member.handle}
      data-status={status}
    >
      @{member.handle}
      <Badge variant={status === "idle" || isExternalMember(member) ? "outline" : "info"} size="sm">
        {status}
      </Badge>
      {needsApproval ? (
        <ThreadLink member={member} className="text-2xs">
          approve in T3
        </ThreadLink>
      ) : needsAnswer && wait?._tag === "waiting_on_question" ? (
        <Badge variant="warning" size="sm">
          needs your answer
        </Badge>
      ) : needsAnswer ? (
        <ThreadLink member={member} className="text-2xs">
          answer in T3
        </ThreadLink>
      ) : null}
    </span>
  );
}

const OTHER = "\u0000other";
const OPTION_ROW = "flex cursor-pointer items-start gap-2 text-sm";

const answerFor = (
  question: GroupChatQuestion,
  picked: ReadonlyArray<string>,
  free: string,
): string | ReadonlyArray<string> => {
  const chosen = picked.filter((value) => value !== OTHER);
  const wantsOther = picked.includes(OTHER) || question.options.length === 0;
  const all = [...chosen, ...(wantsOther && free.trim() !== "" ? [free.trim()] : [])];
  return question.multiSelect ? all : (all[0] ?? "");
};

export function AnswerBox({
  member,
  wait,
}: {
  member: GroupChatMember;
  wait: Extract<GroupChatWait, { readonly _tag: "waiting_on_question" }>;
}) {
  const [picked, setPicked] = useState<Record<string, ReadonlyArray<string>>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const labelId = useId();
  const answers = Object.fromEntries(
    wait.questions.map((q) => [q.id, answerFor(q, picked[q.id] ?? [], free[q.id] ?? "")]),
  );
  const complete = wait.questions.every((q) => answers[q.id]!.length > 0);

  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true);
    const ok = await attempt(() =>
      dispatchGroupChat({
        _tag: "member.answer",
        memberId: member.id,
        requestId: wait.requestId,
        answers,
      }),
    );
    setBusy(false);
    if (ok !== undefined) {
      setPicked({});
      setFree({});
    }
  };

  const toggle = (question: GroupChatQuestion, value: string) =>
    setPicked((current) => {
      const now = current[question.id] ?? [];
      const on = now.includes(value);
      if (question.multiSelect) {
        return { ...current, [question.id]: on ? now.filter((v) => v !== value) : [...now, value] };
      }
      return { ...current, [question.id]: on ? [] : [value] };
    });

  return (
    <form
      className="flex min-h-40 max-w-xl flex-col gap-2 overflow-y-auto rounded-lg border border-warning/32 bg-warning-surface p-3 text-sm"
      data-testid="answer-box"
      data-request-id={wait.requestId}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="warning" size="sm">
          needs your answer
        </Badge>
        <span>@{member.handle}'s thread is waiting for you, so its reply cannot start.</span>
        <ThreadLink member={member} className="ms-auto text-xs">
          Open in T3
        </ThreadLink>
      </div>
      {wait.questions.map((question) => {
        const chosen = picked[question.id] ?? [];
        const options = [
          ...question.options.map((option) => ({
            value: option.value ?? option.label,
            label: option.label,
            description: option.description,
          })),
          { value: OTHER, label: "Other", description: "Type your own answer" },
        ];
        const showText = question.options.length === 0 || chosen.includes(OTHER);
        const textId = labelId + question.id;
        return (
          <Fragment key={question.id}>
            {question.header === null ? null : (
              <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                {question.header}
              </span>
            )}
            <p
              id={textId}
              className="max-h-[10lh] min-h-[1lh] overflow-y-auto whitespace-pre-wrap text-foreground"
              data-testid="pending-question"
            >
              {question.question}
            </p>
            {question.options.length === 0 ? null : question.multiSelect ? (
              <div role="group" aria-labelledby={textId} className="flex flex-col gap-1.5">
                {options.map((option) => (
                  <label key={option.value} className={OPTION_ROW}>
                    <Checkbox
                      checked={chosen.includes(option.value)}
                      onCheckedChange={() => toggle(question, option.value)}
                      aria-label={option.label}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span>{option.label}</span>
                      {option.description === null ? null : (
                        <span className="text-2xs text-muted-foreground">{option.description}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <RadioGroup
                aria-labelledby={textId}
                value={chosen[0] ?? ""}
                onValueChange={(value) => toggle(question, String(value))}
              >
                {options.map((option) => (
                  <label key={option.value} className={OPTION_ROW}>
                    <RadioGroupItem value={option.value} aria-label={option.label} />
                    <span className="flex min-w-0 flex-col">
                      <span>{option.label}</span>
                      {option.description === null ? null : (
                        <span className="text-2xs text-muted-foreground">{option.description}</span>
                      )}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            )}
            {showText ? (
              <Textarea
                size="sm"
                value={free[question.id] ?? ""}
                onChange={(event) =>
                  setFree((current) => ({ ...current, [question.id]: event.target.value }))
                }
                aria-label={`Answer for @${member.handle}`}
                placeholder="Your answer goes to the thread's question, not into the group."
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            ) : null}
          </Fragment>
        );
      })}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || !complete}>
          {busy ? "Answering…" : "Answer"}
        </Button>
        <span className="text-2xs text-muted-foreground">
          Goes to the thread's question in T3, not into the group.
        </span>
      </div>
    </form>
  );
}
