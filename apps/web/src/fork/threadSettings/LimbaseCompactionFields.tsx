import {
  type CompactionField,
  type CompactionProblem,
  formatTokenAmount,
  type LimbaseCompaction,
  parseTokenAmount,
} from "@t3tools/contracts";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { DraftInput } from "../../components/ui/draft-input";
import { COMPACTION_FIELDS, withField } from "./limbaseCompaction";

const UNREADABLE = "Write tokens, like 700k, or a share of the window, like 70%.";

/**
 * "Compact at" and "Down to", each tokens or a share of the window. An empty field inherits, and
 * its placeholder says what it inherits. A refused write keeps the text and shows why.
 */
export function LimbaseCompactionFields(props: {
  readonly idPrefix: string;
  readonly value: LimbaseCompaction;
  readonly placeholders: Record<CompactionField, string>;
  readonly warnings: ReadonlyArray<CompactionProblem>;
  readonly disabled: boolean;
  readonly blockingMessages: (next: LimbaseCompaction) => ReadonlyArray<string>;
  /** Resolves to the server's refusal, or null once saved. */
  readonly onSave: (next: LimbaseCompaction) => Promise<string | null>;
  readonly messagesClassName?: string;
  readonly renderRow: (row: {
    readonly field: CompactionField;
    readonly label: string;
    readonly inputId: string;
    readonly input: React.ReactNode;
  }) => React.ReactNode;
}) {
  const [drafts, setDrafts] = useState<Partial<Record<CompactionField, string>>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A new value from the server replaces the drafts, without remounting the inputs and their focus.
  const [seen, setSeen] = useState(props.value);
  if (JSON.stringify(seen) !== JSON.stringify(props.value)) {
    setSeen(props.value);
    setDrafts({});
    setRefusal(null);
  }

  const commit = async (field: CompactionField, text: string) => {
    const shown = props.value[field] === undefined ? "" : formatTokenAmount(props.value[field]);
    if (text.trim() === shown) {
      setDrafts((current) => ({ ...current, [field]: undefined }));
      return;
    }
    const amount = text.trim() === "" ? undefined : parseTokenAmount(text);
    setDrafts((current) => ({ ...current, [field]: text }));
    if (saving) return;
    if (text.trim() !== "" && amount === undefined) {
      setRefusal(UNREADABLE);
      return;
    }
    const next = withField(props.value, field, amount);
    const blocking = props.blockingMessages(next);
    if (blocking.length > 0) {
      setRefusal(blocking.join(" "));
      return;
    }
    setSaving(true);
    const refused = await props.onSave(next);
    setSaving(false);
    // A saved draft stays until the server's new value replaces these fields.
    setRefusal(refused);
  };

  const messages = [
    ...(refusal === null ? [] : [{ tone: "error" as const, text: refusal }]),
    ...props.warnings.map((warning) => ({ tone: "warning" as const, text: warning.message })),
  ];

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
              aria-invalid={(refusal !== null && drafts[field] !== undefined) || undefined}
              onCommit={(next) => void commit(field, next)}
              spellCheck={false}
            />
          ),
        });
      })}
      {messages.length > 0 ? (
        <div className={cn("flex flex-col gap-1", props.messagesClassName)}>
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
