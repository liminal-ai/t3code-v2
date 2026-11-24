/* oxlint-disable t3code/no-untranslated-copy -- fork copy stays English, so the catalogs stay upstream's */
import {
  type CompactionField,
  formatTokenAmount,
  type LimbaseCompaction,
  parseTokenAmount,
} from "@t3tools/contracts";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { DraftInput } from "../../components/ui/draft-input";
import { COMPACTION_FIELDS, type CompactionNotice, withField } from "./limbaseCompaction";

const UNREADABLE = "Write tokens, like 700k, or a share of the window, like 70%.";

type ByField = Partial<Record<CompactionField, string>>;

const withEntry = (current: ByField, field: CompactionField, text: string | null): ByField => {
  const next = { ...current };
  if (text === null) delete next[field];
  else next[field] = text;
  return next;
};

function useDraftsUntilValueChanges(value: LimbaseCompaction) {
  const [drafts, setDrafts] = useState<ByField>({});
  const [refusals, setRefusals] = useState<ByField>({});
  const [seen, setSeen] = useState(value);
  if (JSON.stringify(seen) !== JSON.stringify(value)) {
    setSeen(value);
    setDrafts({});
    setRefusals({});
  }
  return { drafts, setDrafts, refusals, setRefusals };
}

export function LimbaseCompactionFields(props: {
  readonly idPrefix: string;
  readonly value: LimbaseCompaction;
  readonly placeholders: Record<CompactionField, string>;
  readonly notices: ReadonlyArray<CompactionNotice>;
  readonly disabled: boolean;
  readonly blockingMessages: (next: LimbaseCompaction) => ReadonlyArray<string>;
  /** Resolves with Limbase's or the server's refusal, else null once the saved value shows. */
  readonly onSave: (next: LimbaseCompaction) => Promise<string | null>;
  readonly messagesClassName?: string;
  readonly renderRow: (row: {
    readonly field: CompactionField;
    readonly label: string;
    readonly inputId: string;
    readonly input: React.ReactNode;
  }) => React.ReactNode;
}) {
  const { drafts, setDrafts, refusals, setRefusals } = useDraftsUntilValueChanges(props.value);
  const [saving, setSaving] = useState(false);

  const commit = async (field: CompactionField, text: string) => {
    const draft = (next: string | null) => setDrafts((current) => withEntry(current, field, next));
    const refuse = (message: string | null) =>
      setRefusals((current) => withEntry(current, field, message));
    const own = props.value[field];
    if (text.trim() === (own === undefined ? "" : formatTokenAmount(own))) {
      draft(null);
      refuse(null);
      return;
    }
    draft(text);
    const amount = text.trim() === "" ? undefined : parseTokenAmount(text);
    if (text.trim() !== "" && amount === undefined) return refuse(UNREADABLE);
    const next = withField(props.value, field, amount);
    const blocking = props.blockingMessages(next);
    if (blocking.length > 0) return refuse(blocking.join(" "));
    setSaving(true);
    const refused = await props.onSave(next);
    setSaving(false);
    if (refused === null) draft(null);
    refuse(refused);
  };

  const messages = [
    ...COMPACTION_FIELDS.flatMap(({ field }) => {
      const refusal = refusals[field];
      return refusal === undefined ? [] : [{ tone: "error" as const, text: refusal }];
    }),
    ...props.notices,
  ].filter((message, index, all) => all.findIndex(({ text }) => text === message.text) === index);

  return (
    <>
      {COMPACTION_FIELDS.map(({ field, label }) => {
        const inputId = `${props.idPrefix}-${field}`;
        const own = props.value[field];
        return props.renderRow({
          field,
          label,
          inputId,
          input: (
            <DraftInput
              id={inputId}
              size="sm"
              className="w-full min-w-0"
              value={drafts[field] ?? (own === undefined ? "" : formatTokenAmount(own))}
              placeholder={props.placeholders[field]}
              disabled={props.disabled}
              readOnly={saving}
              aria-invalid={refusals[field] !== undefined || undefined}
              onCommit={(next) => void commit(field, next)}
              spellCheck={false}
            />
          ),
        });
      })}
      {messages.length > 0 || saving ? (
        <div className={cn("flex flex-col gap-1", props.messagesClassName)}>
          {saving ? (
            <p role="status" className="text-2xs leading-snug text-muted-foreground">
              Saving…
            </p>
          ) : null}
          {messages.map((message) => (
            <p
              key={message.text}
              role={message.tone === "error" ? "alert" : undefined}
              className={cn(
                "text-2xs leading-snug",
                message.tone === "error" ? "text-destructive" : "text-warning",
              )}
            >
              {message.text}
            </p>
          ))}
        </div>
      ) : null}
    </>
  );
}
