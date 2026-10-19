import type { GroupChatDelivery, GroupChatDeliveryHead, GroupChatMember } from "@t3tools/contracts";
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
import { Spinner } from "../components/ui/spinner";
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
}

const WAIT_LABEL: Record<NonNullable<GroupChatDeliveryHead["wait"]>["_tag"], string> = {
  lane_busy: "waiting for its earlier envelope",
  busy_with_own_run: "busy with its own run",
  queue_held: "queue held in T3",
  waiting_on_question: "waiting on a question",
  waiting_on_approval: "waiting on an approval in T3",
  stopped_in_t3: "stopped in T3",
};

const DISPATCH_LABEL: Record<GroupChatDeliveryHead["dispatch"], string> = {
  unsent: "waiting to send",
  sending: "sending",
  unknown: "sent, outcome unknown",
  accepted: "received",
  rejected: "refused",
};

function describeDelivery(d: GroupChatDeliveryHead): DeliveryView {
  const wait = d.wait;
  const retry = d.retryable && (d.state === "failed" || wait?._tag === "stopped_in_t3");
  switch (d.state) {
    case "pending":
      if (wait !== null) {
        return {
          label: WAIT_LABEL[wait._tag],
          tone: wait._tag === "stopped_in_t3" ? "warning" : "muted",
          detail: wait._tag === "queue_held" ? wait.note : d.error,
          retry,
          threadLink: wait._tag !== "lane_busy",
          answerable: wait._tag === "waiting_on_question",
        };
      }
      return {
        label: DISPATCH_LABEL[d.dispatch],
        tone: d.dispatch === "unknown" ? "warning" : "muted",
        detail: d.error,
        retry,
        threadLink: false,
        answerable: false,
      };
    case "queued":
      return {
        label: wait === null ? "queued in the thread" : WAIT_LABEL[wait._tag],
        tone: wait?._tag === "queue_held" ? "warning" : "muted",
        detail: wait?._tag === "queue_held" ? wait.note : null,
        retry: false,
        threadLink: true,
        answerable: wait?._tag === "waiting_on_question",
      };
    case "running":
      return {
        label: "responding",
        tone: "info",
        detail: null,
        retry: false,
        threadLink: false,
        answerable: false,
      };
    case "replied":
      return {
        label: "replied",
        tone: "success",
        detail: null,
        retry: false,
        threadLink: false,
        answerable: false,
      };
    case "failed":
      return {
        label: "failed",
        tone: "error",
        detail: d.error,
        retry,
        threadLink: wait?._tag === "stopped_in_t3",
        answerable: false,
      };
    case "cancelled":
      return {
        label: "cancelled",
        tone: "muted",
        detail: d.error,
        retry: false,
        threadLink: false,
        answerable: false,
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

const retryDelivery = (d: GroupChatDeliveryHead) =>
  attempt(() => dispatchGroupChat({ _tag: "delivery.retry", deliveryId: d.id }));

function RetryButton({ delivery }: { delivery: GroupChatDeliveryHead }) {
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
  delivery: GroupChatDeliveryHead;
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
  delivery: GroupChatDeliveryHead;
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
        {delivery.state === "running" ? <Spinner size="xs" /> : null}
        {view.threadLink && member !== undefined ? (
          <ThreadLink member={member} className="text-2xs">
            Open the thread
          </ThreadLink>
        ) : null}
        {view.retry ? <RetryButton delivery={delivery} /> : null}
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
          <AnswerBox member={member} wait={wait} />
        </div>
      ) : null}
    </div>
  );
}

function EnvelopeDialog({
  delivery,
  member,
  onClose,
}: {
  delivery: GroupChatDeliveryHead;
  member: GroupChatMember | undefined;
  onClose: () => void;
}) {
  const [body, setBody] = useState<GroupChatDelivery | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchDelivery(delivery.id)
      .then((fetched) => {
        if (alive) setBody(fetched);
      })
      .catch((error: unknown) => {
        if (alive) setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
    };
  }, [delivery.id]);
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
          <DialogDescription>
            {view.label}
            {delivery.attempt > 1 ? ` · attempt ${delivery.attempt}` : ""}
            {edited ? " · edited in T3" : ""}
          </DialogDescription>
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
              <Spinner size="sm" />
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
