import type { GroupChatMemberId } from "@t3tools/contracts";
import { useId, useState } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Label } from "../../components/ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../../components/ui/number-field";
import { Textarea } from "../../components/ui/textarea";
import { dispatchGroupChat } from "../api";
import { memberColor } from "../MemberChip";
import { Refusal, useRefusal } from "../refusal";
import type { GroupView } from "../store";

const SIGN_OFF_MARKER = "[[SIGN-OFF]]";
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 20;
const DEFAULT_ROUNDS = 3;

export function StartDiscussionDialog({ view, onClose }: { view: GroupView; onClose: () => void }) {
  const members = [...view.members.values()]
    .filter((m) => m.removedAt === null)
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  const [ticked, setTicked] = useState<ReadonlyArray<GroupChatMemberId>>(() =>
    members.map((m) => m.id),
  );
  const [topic, setTopic] = useState("");
  const [rounds, setRounds] = useState<number | null>(DEFAULT_ROUNDS);
  const [busy, setBusy] = useState(false);
  const { refusal, run } = useRefusal();
  const topicId = useId();
  const roundsId = useId();
  const participants = ticked.filter((id) => members.some((m) => m.id === id));
  const roundsValid =
    rounds !== null && Number.isInteger(rounds) && rounds >= MIN_ROUNDS && rounds <= MAX_ROUNDS;
  const valid = participants.length >= 2 && topic.trim() !== "" && roundsValid;

  const start = async () => {
    if (busy || rounds === null || !valid) return;
    setBusy(true);
    const result = await run(() =>
      dispatchGroupChat({
        _tag: "discussion.start",
        groupId: view.group.id,
        participants,
        topic: topic.trim(),
        maxRounds: rounds,
      }),
    );
    setBusy(false);
    if (result !== undefined) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-2xl" data-testid="start-discussion-dialog">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <DialogHeader>
            <DialogTitle>Discuss among yourselves</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Participants (two or more)
              </span>
              <div
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
                data-testid="discussion-participants"
              >
                {members.map((member) => {
                  const on = participants.includes(member.id);
                  return (
                    <label
                      key={member.id}
                      className="flex cursor-pointer items-center gap-1.5 text-sm select-none"
                    >
                      <Checkbox
                        checked={on}
                        aria-label={`Participant @${member.handle}`}
                        onCheckedChange={(checked) =>
                          setTicked(
                            checked
                              ? [...participants, member.id]
                              : participants.filter((id) => id !== member.id),
                          )
                        }
                      />
                      <span style={{ color: on ? memberColor(member.color) : undefined }}>
                        @{member.handle}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={topicId}>Topic</Label>
              <Textarea
                id={topicId}
                rows={3}
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                aria-label="Discussion topic"
                placeholder="What should they discuss?"
              />
            </div>
            <div className="w-40">
              <NumberField
                id={roundsId}
                min={MIN_ROUNDS}
                max={MAX_ROUNDS}
                value={rounds}
                onValueChange={(value) => setRounds(value)}
              >
                <Label htmlFor={roundsId}>Maximum rounds</Label>
                <NumberFieldGroup>
                  <NumberFieldDecrement aria-label="Fewer rounds" />
                  <NumberFieldInput aria-label="Maximum rounds" />
                  <NumberFieldIncrement aria-label="More rounds" />
                </NumberFieldGroup>
              </NumberField>
            </div>
            <Refusal text={refusal} />
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Each round every participant gets one envelope at the same time: round 1 carries the
              topic, later rounds carry the other participants' previous replies. A participant
              signs off by ending its reply with{" "}
              <code className="rounded bg-muted px-1 font-mono">{SIGN_OFF_MARKER}</code> on its own
              last line. The discussion ends when all sign off in the same round, after the last
              round, or when you press Stop. It runs on the server, so closing this tab does not
              stop it.
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !valid} data-testid="start-discussion">
              Start discussion
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
