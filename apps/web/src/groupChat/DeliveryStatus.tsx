import type { GroupChatDelivery, GroupChatPageDelivery, GroupChatMember } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { cn } from "../lib/utils";
import { attempt, dispatchGroupChat, fetchDelivery } from "./api";
import { AnswerBox, MemberLabel, ThreadLink } from "./MemberChip";

export type DeliveryTone = "muted" | "info" | "warning" | "error" | "success";

export interface DeliveryView {
  readonly label: string;
  readonly tone: DeliveryTone;
  readonly detail: string | null;
  readonly retry: boolean;
  readonly threadLink: boolean;
  readonly answerable: boolean;
  /**
   * Stop withdraws an envelope that has not replied yet, or abandons one that T3 stopped so a
   * discussion round moves on. It is the way back out of a send.
   */
  readonly stoppable: boolean;
}

const WAIT_LABEL: Record<NonNullable<GroupChatPageDelivery["wait"]>["_tag"], string> = {
  lane_busy: "waiting for its earlier envelope",
  busy_with_own_run: "busy with its own run",
  queue_held: "queue held in T3",
  waiting_on_question: "waiting on a question",
  waiting_on_approval: "waiting on an approval in T3",
  stopped_in_t3: "stopped in T3",
};

const DISPATCH_LABEL: Record<GroupChatPageDelivery["dispatch"], string> = {
  unsent: "waiting to send",
  sending: "sending",
  unknown: "sent, outcome unknown",
  accepted: "received",
  rejected: "refused",
};

/**
 * What a delivery shows. A wait reason names the row whatever the run state, since a member can
 * ask a question mid-run, and every wait but the lane's own points at the member's thread.
 */
export function describeDelivery(d: GroupChatPageDelivery): DeliveryView {
  const wait = d.wait;
  const open = d.state === "pending" || d.state === "queued" || d.state === "running";
  const retry = d.retryable && (d.state === "failed" || wait?._tag === "stopped_in_t3");
  const stoppable = open || (d.state === "failed" && wait?._tag === "stopped_in_t3");
  if (wait !== null && open) {
    return {
      stoppable,
      label: WAIT_LABEL[wait._tag],
      tone:
        wait._tag === "stopped_in_t3" || wait._tag === "queue_held"
          ? "warning"
          : wait._tag === "waiting_on_question" || wait._tag === "waiting_on_approval"
            ? "info"
            : "muted",
      detail: wait._tag === "queue_held" ? wait.note : d.state === "pending" ? d.error : null,
      retry,
      threadLink: wait._tag !== "lane_busy",
      answerable: wait._tag === "waiting_on_question",
    };
  }
  switch (d.state) {
    case "pending":
      return {
        label: DISPATCH_LABEL[d.dispatch],
        tone: d.dispatch === "unknown" ? "warning" : "muted",
        detail: d.error,
        retry,
        threadLink: false,
        answerable: false,
        stoppable,
      };
    case "queued":
      return {
        label: "queued in the thread",
        tone: "muted",
        detail: null,
        retry: false,
        threadLink: true,
        answerable: false,
        stoppable,
      };
    case "running":
      return {
        label: "responding",
        tone: "info",
        detail: null,
        retry: false,
        threadLink: false,
        answerable: false,
        stoppable,
      };
    case "replied":
      return {
        label: "replied",
        tone: "success",
        detail: null,
        retry: false,
        threadLink: false,
        answerable: false,
        stoppable,
      };
    case "failed":
      return {
        label: wait?._tag === "stopped_in_t3" ? WAIT_LABEL.stopped_in_t3 : "failed",
        tone: "error",
        detail: d.error,
        retry,
        threadLink: wait?._tag === "stopped_in_t3",
        answerable: false,
        stoppable,
      };
    case "cancelled":
      return {
        label: "cancelled",
        tone: "muted",
        detail: d.error,
        retry: false,
        threadLink: false,
        answerable: false,
        stoppable,
      };
  }
}

const TONE_BADGE: Record<DeliveryTone, "outline" | "info" | "warning" | "error" | "success"> = {
  muted: "outline",
  info: "info",
  warning: "warning",
  error: "error",
  success: "success",
};

const retryDelivery = (d: GroupChatPageDelivery) =>
  attempt(() => dispatchGroupChat({ _tag: "delivery.retry", deliveryId: d.id }));

const stopDelivery = (d: GroupChatPageDelivery) =>
  attempt(() => dispatchGroupChat({ _tag: "delivery.stop", deliveryId: d.id }));

function StopButton({ delivery }: { delivery: GroupChatPageDelivery }) {
  return (
    <Button size="xs" variant="ghost-muted" onClick={() => void stopDelivery(delivery)}>
      Stop
    </Button>
  );
}

function RetryButton({ delivery }: { delivery: GroupChatPageDelivery }) {
  return (
    <Button size="xs" variant="outline" onClick={() => void retryDelivery(delivery)}>
      Retry
    </Button>
  );
}

export function DeliveryChip({
  delivery,
  member,
}: {
  delivery: GroupChatPageDelivery;
  member: GroupChatMember | undefined;
}) {
  const [open, setOpen] = useState(false);
  const view = describeDelivery(delivery);
  return (
    <>
      <Badge
        variant={TONE_BADGE[view.tone]}
        size="sm"
        render={<button type="button" onClick={() => setOpen(true)} />}
        title={view.detail ?? "Show the envelope this member received"}
        data-testid="delivery-chip"
        data-state={delivery.state}
      >
        @{member?.handle ?? "removed"} · {view.label}
      </Badge>
      {open ? (
        <EnvelopeDialog delivery={delivery} member={member} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

export function PendingReply({
  delivery,
  member,
}: {
  delivery: GroupChatPageDelivery;
  member: GroupChatMember | undefined;
}) {
  const view = describeDelivery(delivery);
  const wait = delivery.wait;
  return (
    <div
      className="flex flex-col gap-1.5 py-0.5"
      data-testid="pending-reply"
      data-state={delivery.state}
      data-wait={wait?._tag}
    >
      <div className="flex flex-wrap items-center gap-2">
        <MemberLabel member={member} />
        <Badge variant={TONE_BADGE[view.tone]} size="sm">
          {view.label}
        </Badge>
        {view.threadLink && member !== undefined ? (
          <ThreadLink member={member} className="text-2xs">
            Open the thread
          </ThreadLink>
        ) : null}
        {view.retry ? <RetryButton delivery={delivery} /> : null}
        {view.stoppable ? <StopButton delivery={delivery} /> : null}
      </div>
      {view.detail === null ? null : (
        <p
          className={cn(
            "pl-4 text-xs",
            view.tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
          data-testid="delivery-detail"
        >
          {view.detail}
        </p>
      )}
      {view.answerable && member !== undefined && wait?._tag === "waiting_on_question" ? (
        <div className="pl-4">
          {wait.questions.length === 0 ? (
            <p className="text-xs text-muted-foreground">Reading the question…</p>
          ) : (
            <AnswerBox member={member} wait={wait} />
          )}
        </div>
      ) : null}
    </div>
  );
}

interface EnvelopeRead {
  /** The delivery's `updatedAt` the read was for. A body shows for its own head only. */
  readonly head: string;
  readonly body: GroupChatDelivery | null;
  readonly failure: string | null;
}

/**
 * The envelope is built at send and the text that ran is stored when the run starts, so a head
 * that moved while the dialog is open means the body may have too, and is read again.
 */
export function useEnvelope(delivery: GroupChatPageDelivery) {
  const [read, setRead] = useState<EnvelopeRead | null>(null);
  useEffect(() => {
    let alive = true;
    const head = delivery.updatedAt;
    fetchDelivery(delivery.id)
      .then((fetched) => {
        // A read that raced an older head is not the body this head describes.
        if (alive && fetched.updatedAt >= head) setRead({ head, body: fetched, failure: null });
      })
      .catch((error: unknown) => {
        if (alive) {
          const failure = error instanceof Error ? error.message : String(error);
          setRead({ head, body: null, failure });
        }
      });
    return () => {
      alive = false;
    };
  }, [delivery.id, delivery.updatedAt]);
  const current = read?.head === delivery.updatedAt ? read : null;
  return { body: current?.body ?? null, failure: current?.failure ?? null };
}

function EnvelopeDialog({
  delivery,
  member,
  onClose,
}: {
  delivery: GroupChatPageDelivery;
  member: GroupChatMember | undefined;
  onClose: () => void;
}) {
  const { body, failure } = useEnvelope(delivery);
  const view = describeDelivery(delivery);
  const edited = body !== null && body.sentText !== null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Envelope sent to @{member?.handle ?? "removed"}</DialogTitle>
          <div className="flex flex-wrap items-center gap-2">
            <DialogDescription>
              {view.label}
              {delivery.attempt > 1 ? ` · attempt ${delivery.attempt}` : ""}
              {edited ? " · edited in T3" : ""}
            </DialogDescription>
            {view.retry ? <RetryButton delivery={delivery} /> : null}
          </div>
        </DialogHeader>
        <DialogPanel>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <dt>Dispatch</dt>
            <dd className="text-foreground" data-testid="envelope-dispatch">
              {DISPATCH_LABEL[delivery.dispatch]}
            </dd>
            <dt>Covers</dt>
            <dd className="text-foreground">
              {delivery.fromSeq === 0 && delivery.dispatch === "unsent"
                ? `up to #${delivery.toSeq}, built when sent`
                : `#${delivery.fromSeq} to #${delivery.toSeq}`}
            </dd>
            {delivery.runId === null ? null : (
              <>
                <dt>T3 run</dt>
                <dd className="font-mono text-foreground">{delivery.runId}</dd>
              </>
            )}
            {view.detail === null ? null : (
              <>
                <dt>Note</dt>
                <dd
                  className={
                    view.tone === "error" ? "text-destructive-foreground" : "text-foreground"
                  }
                >
                  {view.detail}
                </dd>
              </>
            )}
          </dl>
          {body === null ? (
            failure === null ? (
              <p className="text-xs text-muted-foreground">Reading the envelope…</p>
            ) : (
              <p className="text-sm text-destructive-foreground">{failure}</p>
            )
          ) : (
            <>
              {edited ? (
                <>
                  <p className="text-xs font-medium text-warning-foreground">
                    The text that ran, after an edit in T3
                  </p>
                  <pre
                    className="max-h-[32vh] overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
                    data-testid="sent-text"
                  >
                    {body.sentText}
                  </pre>
                  <p className="text-xs font-medium text-muted-foreground">The envelope as built</p>
                </>
              ) : null}
              <pre
                className="max-h-[48vh] overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
                data-testid="envelope-text"
              >
                {body.envelope === ""
                  ? "Not built yet. An envelope is built from everything this member has not seen at the moment it is sent."
                  : body.envelope}
              </pre>
            </>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
