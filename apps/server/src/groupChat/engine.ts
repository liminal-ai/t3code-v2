import {
  GROUP_CHAT_PAGE_SIZE,
  type GroupChatCommand,
  type GroupChatCommandError,
  type GroupChatDelivery,
  type GroupChatDeliveryHead,
  type GroupChatDeliveryId,
  type GroupChatDiscussion,
  GroupChatDiscussionId,
  type GroupChatDispatchResult,
  type GroupChatExternalConfig,
  type GroupChatExternalKind,
  type GroupChatGroupId,
  type GroupChatGroupPage,
  type GroupChatGroupQuery,
  type GroupChatPageDelivery,
  GroupChatInvalid,
  type GroupChatMember,
  type GroupChatMemberId,
  type GroupChatMemberThread,
  type GroupChatMessage,
  GroupChatNotFound,
  type GroupChatPendingInput,
  GroupChatRefused,
  type GroupChatSnapshot,
  type GroupChatStreamEvent,
  GroupChatThreadRefused,
  type GroupChatWait,
  type GroupChatWaitHead,
  GROUP_CHAT_TITLE_MAX_LENGTH,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient } from "effect/http";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { newId, randomHex } from "./domain.ts";
import { deriveHandle, nextColor, renderEnvelope } from "./envelope.ts";
import { GroupChatReach } from "./reach.ts";
import { countsAsSignOff, decideRound, gateSend, onWithdraw } from "./rounds.ts";
import {
  type CancelRow,
  type DeliveryRow,
  type ExternalDelivery,
  type GroupChatStore,
  type MemberRow,
  publicMember,
  type StoreError,
  type Tx,
} from "./store.ts";
import { handleProblem, stripLeadingHandle, withoutSignOffLine } from "./text.ts";
import {
  dispatchIds,
  GroupChatThreadPort,
  type PortReadError,
  type PortRun,
} from "./threadPort.ts";
import { capUntrusted, type OutboundInput, type SendFailure } from "./transports/http.ts";
import { deliverRest } from "./transports/rest.ts";
import { deliverWebhook, inboundUrl, replyUrl } from "./transports/webhook.ts";

export type EngineError = GroupChatCommandError | StoreError | PortReadError;

export class GroupChatEngine extends Context.Service<
  GroupChatEngine,
  {
    readonly snapshot: Effect.Effect<GroupChatSnapshot, StoreError>;
    readonly groupPage: (
      groupId: GroupChatGroupId,
      query: GroupChatGroupQuery,
    ) => Effect.Effect<GroupChatGroupPage, GroupChatNotFound | StoreError>;
    readonly delivery: (
      deliveryId: GroupChatDeliveryId,
    ) => Effect.Effect<GroupChatDelivery, GroupChatNotFound | StoreError>;
    readonly dispatch: (
      command: GroupChatCommand,
    ) => Effect.Effect<GroupChatDispatchResult, EngineError>;
    readonly events: Stream.Stream<GroupChatStreamEvent, StoreError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /**
     * A webhook member's callback. It lands once per delivery, even late, after a timeout or
     * after Stop, because a reply never vanishes. The hook route has already checked the token
     * and the signature.
     */
    readonly landReply: (
      deliveryId: GroupChatDeliveryId,
      text: string,
    ) => Effect.Effect<"landed" | "duplicate" | "not_found", StoreError>;
    /** An external member posting into the group on its own, through its inbound URL. */
    readonly postInbound: (
      memberId: GroupChatMemberId,
      text: string,
    ) => Effect.Effect<GroupChatMessage | null, StoreError>;
  }
>()("t3/groupChat/engine/GroupChatEngine") {}

/** The attempt budget and the waits for REST and webhook members. Tests shorten them. */
export class ExternalDeliveryConfig extends Context.Reference<{
  /** Requests per operator attempt before the delivery fails with Retry. */
  readonly maxAttempts: number;
  /** The wait before the second request; it doubles each time up to 30 seconds. */
  readonly backoffBase: Duration.Input;
  /** How long a webhook member may take to call back before its delivery fails. */
  readonly callbackTimeout: Duration.Input;
}>("t3/groupChat/engine/ExternalDeliveryConfig", {
  defaultValue: () => ({
    maxAttempts: 5,
    backoffBase: "1 second",
    callbackTimeout: "90 seconds",
  }),
}) {}

const BACKOFF_MAX_MS = 30_000;
const backoffMs = (tries: number, baseMs: number) =>
  Math.min(BACKOFF_MAX_MS, baseMs * 2 ** Math.max(0, tries - 1));

const DEFAULT_BODY_TEMPLATE = '{"text": "{{envelope}}"}';
const DEFAULT_REPLY_PATH = "reply";
const EXTERNAL_START: ExternalDelivery = {
  sends: 0,
  tries: 0,
  nextAttemptAt: null,
  callbackToken: null,
  acceptedAt: null,
};

/** A T3 thread's envelopes go out one at a time whatever group they come from; an external member is its own lane. */
type Lane =
  | { readonly _tag: "thread"; readonly threadId: ThreadId }
  | { readonly _tag: "member"; readonly memberId: GroupChatMemberId };

const laneOf = (member: GroupChatMember): Lane =>
  member.kind._tag === "t3"
    ? { _tag: "thread", threadId: member.kind.thread.threadId }
    : { _tag: "member", memberId: member.id };

const laneKey = (lane: Lane) =>
  lane._tag === "thread" ? `thread:${lane.threadId}` : `member:${lane.memberId}`;

const threadIdOf = (member: GroupChatMember): ThreadId | null =>
  member.kind._tag === "t3" ? member.kind.thread.threadId : null;

const OPEN = new Set<GroupChatDelivery["state"]>(["pending", "queued", "running"]);
const TERMINAL = new Set<PortRun["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

const MAX_RESENDS = 1;
type CancelOutcome = "settled" | "retry";
/** An open delivery whose dispatch left without a run id, so only its derived message id can find it. */
const dispatchUnresolved = (d: DeliveryRow) =>
  OPEN.has(d.state) && d.runId === null && d.messageId !== null;
const QUEUE_HELD_NOTE =
  "T3 is holding this thread's queue after a Stop. Resume thread in T3 releases the whole queue, this envelope included, in the order it was queued.";

/** How long a lane waits after a read or store failure before it looks at its envelope again. */
export class RetryDelay extends Context.Reference<Duration.Input>(
  "t3/groupChat/engine/RetryDelay",
  {
    defaultValue: () => "2 seconds",
  },
) {}

interface LaneState {
  readonly lane: Lane;
  readonly signal: Queue.Queue<void>;
}

type Work =
  | { readonly kind: "resolve"; readonly delivery: DeliveryRow }
  | { readonly kind: "follow"; readonly delivery: DeliveryRow }
  | { readonly kind: "send"; readonly delivery: DeliveryRow };

const retryRefusal = (
  delivery: DeliveryRow,
  member: GroupChatMember | null,
  discussion: GroupChatDiscussion | null,
): string | null => {
  if (member === null || member.removedAt !== null) {
    return "this member was removed from the group";
  }
  if (
    discussion !== null &&
    (discussion.state !== "running" || discussion.round !== delivery.round)
  ) {
    return "this discussion round is over";
  }
  if (delivery.state === "pending" && delivery.wait?._tag === "stopped_in_t3") return null;
  if (delivery.state === "pending" && delivery.dispatch === "unknown" && delivery.error !== null) {
    return null;
  }
  if (delivery.state === "failed") return null;
  switch (delivery.state) {
    case "queued":
    case "running":
      return "the thread still has this envelope";
    case "replied":
      return "this envelope already got its reply; send a new message instead";
    case "cancelled":
      return "this envelope was cancelled; send a new message instead";
    case "pending":
      return "this envelope is waiting to go out";
  }
};

export const makeEngine = (store: GroupChatStore) =>
  Effect.gen(function* () {
    const port = yield* GroupChatThreadPort;
    const reach = yield* GroupChatReach;
    const httpClient = yield* HttpClient.HttpClient;
    const retryDelay = yield* RetryDelay;
    const externalConfig = yield* ExternalDeliveryConfig;
    const scope = yield* Effect.scope;
    const lanes = new Map<string, LaneState>();
    const cancels = yield* Queue.make<void>({ capacity: 1, strategy: "sliding" });
    const resends = new Map<GroupChatDeliveryId, number>();
    /** Deliveries whose dispatch outcome stayed unknown this boot. Retry or the next boot looks again. */
    const stalled = new Set<GroupChatDeliveryId>();

    const notFound = (entity: GroupChatNotFound["entity"], id: string) =>
      new GroupChatNotFound({ entity, id });

    const decorate = (
      delivery: DeliveryRow,
      member: GroupChatMember | null,
      discussion: GroupChatDiscussion | null,
    ): GroupChatDelivery => {
      const { roster: _roster, external: _external, ...rest } = delivery;
      return { ...rest, retryable: retryRefusal(delivery, member, discussion) === null };
    };

    const waitHead = (wait: GroupChatWait | null): GroupChatWaitHead | null =>
      wait?._tag === "waiting_on_question"
        ? { _tag: "waiting_on_question", requestId: wait.requestId }
        : wait;

    /** The delivery as the group page carries it: no envelope, but the question's text. */
    const onPage = (decorated: GroupChatDelivery): GroupChatPageDelivery => {
      const { envelope: _envelope, sentText: _sentText, ...rest } = decorated;
      return rest;
    };

    /** The delivery as the stream carries it: no bodies at all. */
    const head = (decorated: GroupChatDelivery): GroupChatDeliveryHead => {
      const { wait, ...rest } = onPage(decorated);
      return { ...rest, wait: waitHead(wait) };
    };

    const decorateRead = (delivery: DeliveryRow): Effect.Effect<GroupChatDelivery, StoreError> =>
      Effect.gen(function* () {
        const member = yield* store.member(delivery.memberId);
        const discussion =
          delivery.discussionId === null ? null : yield* store.discussion(delivery.discussionId);
        return decorate(delivery, member, discussion);
      });

    const projectIdOf = (threadId: ThreadId): Effect.Effect<ProjectId | null, PortReadError> =>
      Effect.map(port.thread(threadId), (info) => info?.projectId ?? null);

    const laneState = (lane: Lane): Effect.Effect<LaneState> =>
      Effect.gen(function* () {
        const key = laneKey(lane);
        const existing = lanes.get(key);
        if (existing !== undefined) return existing;
        const signal = yield* Queue.make<void>({ capacity: 1, strategy: "sliding" });
        // Two first sends to one thread can both get past the lookup, and a second lane fiber
        // would send every envelope twice. After the yield the map decides, and the loser uses
        // the winner's lane.
        const raced = lanes.get(key);
        if (raced !== undefined) return raced;
        const created: LaneState = { lane, signal };
        lanes.set(key, created);
        yield* Effect.forkIn(runLane(created), scope);
        return created;
      });

    const kick = (lane: Lane): Effect.Effect<void> =>
      Effect.flatMap(laneState(lane), (l) => Queue.offer(l.signal, undefined));

    const laneDeliveries = (reads: Tx | GroupChatStore, lane: Lane) =>
      lane._tag === "thread"
        ? reads.deliveriesOfThread(lane.threadId)
        : reads.deliveriesOfMember(lane.memberId);

    /** Returns once the lane is kicked or the wait is over, so a sleeping lane still sees a Stop or a Retry. */
    const napUntil = (l: LaneState, untilMs: number): Effect.Effect<void> =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        untilMs <= now
          ? Effect.void
          : Effect.raceFirst(Effect.sleep(Duration.millis(untilMs - now)), Queue.take(l.signal)),
      );

    const nextWork = (l: LaneState): Effect.Effect<Work | null, StoreError> =>
      Effect.gen(function* () {
        const deliveries = yield* laneDeliveries(store, l.lane);
        const open = deliveries.filter((d) => OPEN.has(d.state));
        const unresolved = open.find((d) => d.dispatch === "sending" || d.dispatch === "unknown");
        if (unresolved !== undefined) {
          // A stalled send may still have committed, so it holds the lane until Retry, Stop or a
          // boot looks for it again. Letting later envelopes past it could run two at once.
          return stalled.has(unresolved.id) ? null : { kind: "resolve", delivery: unresolved };
        }
        const outstanding = open.find((d) => d.dispatch === "accepted" && d.state !== "pending");
        if (outstanding !== undefined) return { kind: "follow", delivery: outstanding };
        const pending = open.find(
          (d) =>
            d.state === "pending" && d.dispatch === "unsent" && d.wait?._tag !== "stopped_in_t3",
        );
        return pending === undefined ? null : { kind: "send", delivery: pending };
      });

    const runLane = (l: LaneState): Effect.Effect<never> =>
      Effect.gen(function* () {
        for (;;) {
          const work = yield* nextWork(l).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logError("group chat lane could not read its deliveries", {
                    lane: laneKey(l.lane),
                    cause,
                  }).pipe(Effect.as("read-failed" as const)),
            ),
          );
          if (work === "read-failed") {
            yield* Effect.sleep(retryDelay);
            continue;
          }
          if (work === null) {
            yield* Queue.take(l.signal);
            continue;
          }
          // A failure to read or record is never a verdict on the envelope: the delivery keeps its
          // state and the lane looks again after a pause, so an accepted run is never abandoned.
          yield* runWork(l, work).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logError("group chat lane paused after a failure", {
                    deliveryId: work.delivery.id,
                    lane: laneKey(l.lane),
                    cause,
                  }).pipe(Effect.andThen(Effect.sleep(retryDelay))),
            ),
          );
        }
      });

    const runWork = (l: LaneState, work: Work): Effect.Effect<void, StoreError | PortReadError> => {
      if (l.lane._tag === "member") {
        switch (work.kind) {
          case "send":
            return sendExternal(l, work.delivery);
          case "resolve":
            return resolveExternal(work.delivery);
          case "follow":
            return followExternal(l, work.delivery);
        }
      }
      switch (work.kind) {
        case "send":
          return send(work.delivery);
        case "resolve":
          return resolve(work.delivery);
        case "follow":
          return follow(work.delivery);
      }
    };

    /**
     * Pauses the lane and marks its waiting envelopes, in the transaction that records why. The
     * lane carries the pause too: a reply cut short by Stop can close the lane's last open
     * delivery, and the next envelope must still see the stop.
     */
    const markPaused = (tx: Tx, threadId: ThreadId): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        yield* tx.pauseLane(threadId);
        for (const d of yield* tx.deliveriesOfThread(threadId)) {
          if (d.state === "pending") {
            yield* tx.updateDelivery(d.id, { wait: { _tag: "stopped_in_t3" } });
          }
        }
      });

    /** Only a thread lane pauses, because only a T3 Stop pauses one. */
    const releaseLane = (lane: Lane): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        if (lane._tag !== "thread") return;
        yield* store.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.resumeLane(lane.threadId);
            for (const d of yield* tx.deliveriesOfThread(lane.threadId)) {
              if (d.state === "pending" && d.wait?._tag === "stopped_in_t3") {
                yield* tx.updateDelivery(d.id, { wait: null });
              }
            }
          }),
        );
      });

    const buildEnvelope = (tx: Tx, d: DeliveryRow) =>
      Effect.gen(function* () {
        const member = yield* tx.member(d.memberId);
        const group = yield* tx.group(d.groupId);
        const trigger = yield* tx.message(d.triggerMessageId);
        if (member === null || group === null || trigger === null) return null;
        const all = yield* tx.members(d.groupId, true);
        // A late message is one the group no longer counts, such as the text of a reply the
        // operator stopped; it stays on the page but is never put in front of another member.
        const shown = (m: GroupChatMessage) =>
          !m.late && !(m.author._tag === "member" && m.author.memberId === member.id);
        const discussion = d.discussionId === null ? null : yield* tx.discussion(d.discussionId);
        const previous =
          discussion !== null && d.round !== null && d.round > 1
            ? (yield* tx.messages(d.groupId)).filter(
                (m) =>
                  m.discussionId === discussion.id &&
                  m.kind === "discussion_reply" &&
                  m.round === d.round! - 1 &&
                  shown(m),
              )
            : [];
        const after = (yield* tx.messages(d.groupId, member.seenSeq)).filter(
          (m) => m.seq <= d.toSeq && shown(m),
        );
        const repeated = previous.filter((m) => m.seq <= member.seenSeq);
        const unseen = [...repeated, ...after].sort((a, b) => a.seq - b.seq);
        const active = (id: string) => all.some((m) => m.id === id && m.removedAt === null);
        const participants = discussion?.participants.filter(active) ?? [];
        const envelope = renderEnvelope({
          group,
          member,
          members: all,
          unseen,
          repeated: new Set(repeated.map((m) => m.id)),
          required: new Set(previous.map((m) => m.id)),
          expectedRepliers: discussion === null ? trigger.recipients : participants,
          footer:
            discussion === null
              ? "Reply to the operator's new message (the last section)."
              : d.round === 1
                ? "Discussion round 1: give your view on the topic."
                : `Discussion round ${d.round}: respond to the other participants' round ${d.round! - 1} replies above.`,
          discussion:
            discussion === null
              ? null
              : {
                  topic: discussion.topic,
                  round: d.round!,
                  maxRounds: discussion.maxRounds,
                  participants,
                },
        });
        const roster = Object.fromEntries(
          all.filter((m) => m.removedAt === null).map((m) => [m.id, m.handle]),
        );
        return { envelope, fromSeq: member.seenSeq + 1, roster, group };
      });

    /**
     * Takes an unsent envelope for the request that is about to leave. A T3 envelope gets its
     * derived ids. An external one counts the request now, so a crash mid-request still spends
     * one try, and a REST member reads as responding for the length of the call.
     */
    const claim = (deliveryId: GroupChatDeliveryId) =>
      store.transaction((tx) =>
        Effect.gen(function* () {
          const d = yield* tx.delivery(deliveryId);
          // Only an unsent envelope is this lane's to claim. Anything else moved since the lane
          // looked: Stop cancelled it, or it already went out and is being followed.
          if (d === null || d.state !== "pending" || d.dispatch !== "unsent") return null;
          const member = yield* tx.member(d.memberId);
          const discussion = d.discussionId === null ? null : yield* tx.discussion(d.discussionId);
          const gate = gateSend({
            state: d.state,
            withdrawn: d.withdrawn,
            memberRemoved: member === null || member.removedAt !== null,
            discussion,
            round: d.round,
          });
          if (!gate.send) {
            yield* tx.updateDelivery(d.id, { state: "cancelled", error: gate.reason, wait: null });
            return null;
          }
          let envelope = d.envelope;
          let group = yield* tx.group(d.groupId);
          let patch: Parameters<Tx["updateDelivery"]>[1] = { dispatch: "sending", wait: null };
          if (envelope === "") {
            const built = yield* buildEnvelope(tx, d);
            if (built === null) {
              yield* tx.updateDelivery(d.id, {
                state: "failed",
                error: "member or group no longer exists",
              });
              return null;
            }
            envelope = built.envelope;
            group = built.group;
            patch = { ...patch, envelope, fromSeq: built.fromSeq, roster: built.roster };
          }
          if (group === null) {
            yield* tx.updateDelivery(d.id, { state: "failed", error: "group no longer exists" });
            return null;
          }
          if (member!.kind._tag === "t3") {
            const ids = dispatchIds({
              groupMessageId: d.triggerMessageId,
              memberId: d.memberId,
              attempt: d.attempt,
            });
            const claimed = yield* tx.updateDelivery(d.id, { ...patch, messageId: ids.messageId });
            return { delivery: claimed, member: member!, ids, envelope, group };
          }
          const previous = d.external ?? EXTERNAL_START;
          const external: ExternalDelivery = {
            ...previous,
            sends: previous.sends + 1,
            tries: previous.tries + 1,
            nextAttemptAt: null,
            callbackToken:
              member!.kind._tag === "webhook" && previous.callbackToken === null
                ? randomHex(16)
                : previous.callbackToken,
          };
          const claimed = yield* tx.updateDelivery(d.id, {
            ...patch,
            messageId: null,
            external,
            ...(member!.kind._tag === "rest" ? { state: "running" } : {}),
          });
          return { delivery: claimed, member: member!, ids: null, envelope, group };
        }),
      );

    const sendExternal = (l: LaneState, d: DeliveryRow): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const member = yield* store.member(d.memberId);
        if (member === null || member.external === null || member.kind._tag === "t3") {
          yield* fail(d.id, "member or group no longer exists");
          return;
        }
        const at = d.external?.nextAttemptAt ?? null;
        if (at !== null) {
          // The lane sleeps through the backoff and lets the loop look again, so Stop, removal
          // and Retry during the wait all take effect before the next request leaves.
          const now = yield* Clock.currentTimeMillis;
          const until = Date.parse(at);
          if (until > now) {
            yield* napUntil(l, until);
            return;
          }
        }
        const claimed = yield* claim(d.id);
        if (claimed === null) return;
        const external = member.external;
        const origin = external.callbackOrigin === "" ? reach.origin : external.callbackOrigin;
        const bookkeeping = claimed.delivery.external ?? EXTERNAL_START;
        const input: OutboundInput = {
          member,
          groupTitle: claimed.group.title,
          deliveryId: d.id,
          envelope: claimed.envelope,
          attempt: bookkeeping.sends,
          callbackUrl:
            member.kind._tag === "webhook" && bookkeeping.callbackToken !== null
              ? replyUrl(origin, d.id, bookkeeping.callbackToken)
              : "",
          inboundUrl: inboundUrl(origin, member.id, external.inboundToken),
        };
        const outbound: Effect.Effect<
          { readonly _tag: "replied"; readonly text: string } | { readonly _tag: "accepted" },
          SendFailure,
          HttpClient.HttpClient
        > =
          member.kind._tag === "rest"
            ? Effect.map(deliverRest(external, input), (text) => ({ _tag: "replied", text }))
            : Effect.as(deliverWebhook(external, input), { _tag: "accepted" });
        const sent = yield* outbound.pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.result,
        );
        if (Result.isFailure(sent)) {
          yield* externalFailed(d.id, sent.failure);
          return;
        }
        const acceptedAt = DateTime.formatIso(yield* DateTime.now);
        yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx.delivery(d.id);
            if (current === null || !OPEN.has(current.state)) return;
            yield* tx.updateDelivery(d.id, {
              dispatch: "accepted",
              state: "running",
              error: null,
              wait: null,
              external: { ...(current.external ?? EXTERNAL_START), acceptedAt },
            });
            // The agent has the envelope, so the mark moves: its next envelope starts after this one.
            yield* tx.updateMember(current.memberId, {
              seenSeq: current.toSeq,
              introduced: true,
              ...(current.roster === null ? {} : { toldRoster: current.roster }),
            });
          }),
        );
        if (sent.success._tag === "replied")
          yield* ingestReply(d.id, capUntrusted(sent.success.text));
      });

    /**
     * A refusal fails the delivery until Retry. Anything else is tried again with the same
     * Idempotency-Key after a growing wait, up to the attempt budget.
     */
    const externalFailed = (
      deliveryId: GroupChatDeliveryId,
      failure: SendFailure,
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        if (failure._tag === "permanent") {
          yield* fail(deliveryId, failure.reason, { dispatch: "rejected" });
          return;
        }
        const current = yield* store.delivery(deliveryId);
        if (current === null || !OPEN.has(current.state)) return;
        const external = current.external ?? EXTERNAL_START;
        if (external.tries >= externalConfig.maxAttempts) {
          yield* fail(
            deliveryId,
            `Gave up after ${external.tries} attempt${external.tries === 1 ? "" : "s"}. Last error: ${failure.reason}`,
            { dispatch: "unknown" },
          );
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        const nextAttemptAt = DateTime.formatIso(
          DateTime.makeUnsafe(
            now + backoffMs(external.tries, Duration.toMillis(externalConfig.backoffBase)),
          ),
        );
        yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const again = yield* tx.delivery(deliveryId);
            if (again === null || !OPEN.has(again.state)) return;
            yield* tx.updateDelivery(deliveryId, {
              state: "pending",
              dispatch: "unsent",
              error: failure.reason,
              wait: { _tag: "retrying", nextAttemptAt },
              external: { ...external, nextAttemptAt },
            });
          }),
        );
      });

    /** A request was in flight when the server stopped, so its outcome is unknown; the next try carries the same key. */
    const resolveExternal = (d: DeliveryRow): Effect.Effect<void, StoreError> =>
      externalFailed(d.id, {
        _tag: "transient",
        reason: "the request's outcome is unknown after a restart",
      });

    /** Waits for a webhook member's callback, and fails the delivery once the callback window closes. */
    const followExternal = (l: LaneState, d: DeliveryRow): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const acceptedAt = d.external?.acceptedAt ?? null;
        if (acceptedAt === null) {
          yield* fail(d.id, "the delivery record is incomplete");
          return;
        }
        const timeout = Duration.toMillis(externalConfig.callbackTimeout);
        const deadline = Date.parse(acceptedAt) + timeout;
        if (deadline > (yield* Clock.currentTimeMillis)) {
          yield* napUntil(l, deadline);
          return;
        }
        const current = yield* store.delivery(d.id);
        if (
          current === null ||
          !OPEN.has(current.state) ||
          current.dispatch !== "accepted" ||
          current.external?.acceptedAt !== acceptedAt
        ) {
          return;
        }
        yield* fail(
          d.id,
          `No callback from the agent within ${Math.round(timeout / 1000)} s. It may have called back while the server was down. A late callback still lands; Retry sends the envelope again with the same Idempotency-Key.`,
        );
      });

    const send = (d: DeliveryRow): Effect.Effect<void, StoreError | PortReadError> =>
      Effect.gen(function* () {
        const member = yield* store.member(d.memberId);
        const threadId = member === null ? null : threadIdOf(member);
        if (threadId === null) {
          yield* fail(d.id, "member or group no longer exists");
          return;
        }
        const projectId = yield* projectIdOf(threadId);
        if (projectId === null) {
          yield* fail(d.id, "the member's thread no longer exists", { dispatch: "rejected" });
          return;
        }
        const claimed = yield* claim(d.id);
        if (claimed === null || claimed.ids === null) return;
        const dispatch = { threadId, messageId: claimed.ids.messageId };
        const sent = yield* port
          .send({
            threadId,
            projectId,
            text: claimed.envelope,
            commandId: claimed.ids.commandId,
            messageId: claimed.ids.messageId,
          })
          .pipe(Effect.result);
        if (Result.isFailure(sent)) {
          const error = sent.failure;
          if (error._tag === "GroupChatPortRejected") {
            const orphaned = yield* store.transaction((tx) =>
              Effect.gen(function* () {
                const current = yield* tx.delivery(d.id);
                if (current === null) return yield* tx.landCancel({ ...dispatch, runId: null });
                yield* tx.updateDelivery(d.id, {
                  dispatch: "rejected",
                  state: current.withdrawn === null ? "failed" : "cancelled",
                  error: error.reason,
                  wait: null,
                });
                return false;
              }),
            );
            if (orphaned) yield* kickCancels;
            yield* onTerminal(d.id);
            return;
          }
          yield* record(
            d.id,
            { dispatch: "unknown", error: error.message },
            { ...dispatch, runId: null },
          );
          return;
        }
        const runId = sent.success.runId;
        yield* record(
          d.id,
          { dispatch: "accepted", runId, state: "queued", error: null },
          { ...dispatch, runId },
        );
        resends.delete(d.id);
      });

    const record = (
      deliveryId: GroupChatDeliveryId,
      patch: Parameters<Tx["updateDelivery"]>[1],
      dispatch: Parameters<Tx["landCancel"]>[0],
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const cancelled = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx.delivery(deliveryId);
            if (current !== null) yield* tx.updateDelivery(deliveryId, patch);
            const orphaned = current === null;
            const withdrawnMeanwhile =
              current !== null && current.withdrawn !== null && dispatch.runId !== null;
            if (orphaned && !(yield* tx.landCancel(dispatch))) {
              yield* tx.insertCancel(
                dispatch.runId === null
                  ? { threadId: dispatch.threadId, messageId: dispatch.messageId, inFlight: false }
                  : { threadId: dispatch.threadId, runId: dispatch.runId },
              );
            }
            if (withdrawnMeanwhile) {
              yield* tx.insertCancel({ threadId: dispatch.threadId, runId: dispatch.runId! });
            }
            return orphaned || withdrawnMeanwhile;
          }),
        );
        if (cancelled) yield* kickCancels;
      });

    const adopt = (
      d: DeliveryRow,
      threadId: ThreadId,
      runId: RunId,
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const withdrawn = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx.delivery(d.id);
            const unchanged =
              current !== null && current.messageId === d.messageId && OPEN.has(current.state);
            if (!unchanged) return false;
            yield* tx.updateDelivery(d.id, {
              dispatch: "accepted",
              runId,
              state: current.state === "pending" ? "queued" : current.state,
              error: null,
            });
            if (current.withdrawn !== null) yield* tx.insertCancel({ threadId, runId });
            return current.withdrawn !== null;
          }),
        );
        if (withdrawn) yield* kickCancels;
      });

    const resolve = (d: DeliveryRow): Effect.Effect<void, StoreError | PortReadError> =>
      Effect.gen(function* () {
        const member = yield* store.member(d.memberId);
        const threadId = member === null ? null : threadIdOf(member);
        if (threadId === null || d.messageId === null) {
          yield* fail(d.id, "member or envelope record is incomplete");
          return;
        }
        if ((yield* port.thread(threadId)) === null) {
          yield* fail(d.id, "the member's thread no longer exists", { dispatch: "rejected" });
          return;
        }
        const found = yield* port.findMessage({ threadId, messageId: d.messageId });
        if (found !== null && found.runId !== null) {
          yield* adopt(d, threadId, found.runId);
          return;
        }
        const count = resends.get(d.id) ?? 0;
        if (count >= MAX_RESENDS) {
          resends.delete(d.id);
          stalled.add(d.id);
          yield* store.transaction((tx) =>
            tx.updateDelivery(d.id, {
              dispatch: "unknown",
              wait: null,
              error: `${d.error ?? "the send's outcome stayed unknown"}. Later envelopes to this thread wait behind it. Retry sends it again as a new attempt; a restart looks for it first.`,
            }),
          );
          return;
        }
        resends.set(d.id, count + 1);
        yield* store.transaction((tx) => tx.updateDelivery(d.id, { dispatch: "unsent" }));
      });

    const waitOf = (
      view: PortRun,
      blocking: { readonly runId: RunId; readonly pending: GroupChatPendingInput | null } | null,
      ownPending: GroupChatPendingInput | null,
    ): GroupChatWait | null => {
      if (view.started) {
        if (ownPending?._tag === "question") {
          return {
            _tag: "waiting_on_question",
            requestId: ownPending.requestId,
            questions: ownPending.questions,
          };
        }
        return ownPending?._tag === "approval" ? { _tag: "waiting_on_approval" } : null;
      }
      if (view.queueHeld) return { _tag: "queue_held", note: QUEUE_HELD_NOTE };
      if (blocking === null) return null;
      if (blocking.pending?._tag === "question") {
        return {
          _tag: "waiting_on_question",
          requestId: blocking.pending.requestId,
          questions: blocking.pending.questions,
        };
      }
      if (blocking.pending?._tag === "approval") return { _tag: "waiting_on_approval" };
      return { _tag: "busy_with_own_run", runId: blocking.runId };
    };

    const step = (
      deliveryId: GroupChatDeliveryId,
      threadId: ThreadId,
    ): Effect.Effect<"done" | "open" | PortRun, StoreError | PortReadError> =>
      Effect.gen(function* () {
        const d = yield* store.delivery(deliveryId);
        if (d === null || d.runId === null || !OPEN.has(d.state)) return "done" as const;
        const view = yield* port.run({ threadId, runId: d.runId });
        if (view === null) {
          yield* fail(d.id, "the thread's run no longer exists");
          return "done" as const;
        }
        const terminal = TERMINAL.has(view.status);
        const starting = view.started && d.state !== "running";
        const blocking =
          view.started || terminal ? null : yield* port.blockingRun({ threadId, runId: view.id });
        const ownPending = view.started && !terminal ? yield* port.pendingRequest(threadId) : null;
        const ran =
          starting && d.messageId !== null
            ? yield* port.findMessage({ threadId, messageId: d.messageId })
            : null;
        yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx.delivery(d.id);
            if (current === null || !OPEN.has(current.state)) return;
            const state = current.state === "running" || view.started ? "running" : "queued";
            const edited = ran !== null && ran.text !== current.envelope;
            yield* tx.updateDelivery(d.id, {
              runId: view.id,
              state,
              wait: terminal
                ? starting
                  ? null
                  : current.wait
                : waitOf(view, blocking, ownPending),
              ...(edited ? { sentText: ran.text } : {}),
            });
            if (starting) {
              yield* tx.updateMember(current.memberId, {
                seenSeq: current.toSeq,
                introduced: true,
                ...(current.roster === null ? {} : { toldRoster: current.roster }),
              });
            }
          }),
        );
        return terminal ? view : ("open" as const);
      });

    const follow = (d: DeliveryRow): Effect.Effect<void, StoreError | PortReadError> =>
      Effect.scoped(followScoped(d));

    const followScoped = (
      d: DeliveryRow,
    ): Effect.Effect<void, StoreError | PortReadError, Scope.Scope> =>
      Effect.gen(function* () {
        const member = yield* store.member(d.memberId);
        const threadId = member === null ? null : threadIdOf(member);
        if (threadId === null || d.runId === null) {
          yield* fail(d.id, "member or run record is incomplete");
          return;
        }
        const projectId = yield* projectIdOf(threadId);
        if (projectId === null) {
          yield* fail(d.id, "the member's thread no longer exists");
          return;
        }
        const changes = yield* port.changes(threadId);
        const first = yield* step(d.id, threadId);
        if (first === "done") return;
        // The run's verdict comes from awaitRun below, so a refresh that fails must never end the
        // follow: a read error skips one look, a lost stream is subscribed again after the delay.
        const refresh = (deliveryId: GroupChatDeliveryId): Effect.Effect<void> =>
          step(deliveryId, threadId).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logError("group chat lane could not refresh a delivery", {
                    deliveryId,
                    threadId,
                    cause,
                  }),
            ),
          );
        const refresher = yield* Effect.gen(function* () {
          let stream = changes;
          for (;;) {
            const ended = yield* stream.pipe(
              Stream.runForEach(() => refresh(d.id)),
              Effect.result,
            );
            yield* Effect.logError("group chat lane lost its thread's events; subscribing again", {
              deliveryId: d.id,
              threadId,
              cause: Result.isFailure(ended) ? ended.failure : "the stream ended",
            });
            yield* Effect.sleep(retryDelay);
            const again = yield* Effect.result(port.changes(threadId));
            if (Result.isSuccess(again)) {
              stream = again.success;
              yield* refresh(d.id);
            }
          }
        }).pipe(Effect.forkChild);
        // Only T3's own wait knows whether a restart continuation is still pending for a run that
        // reads as terminal, so the verdict always comes from it, even when the first look ended.
        const awaited = yield* port.awaitRun({ threadId, projectId, runId: d.runId }).pipe(
          Effect.catchTags({
            GroupChatPortThreadNotFound: () => Effect.succeed(null),
          }),
          Effect.onExit(() => Fiber.interrupt(refresher)),
        );
        if (awaited === null) {
          yield* fail(d.id, "the member's thread was deleted");
          return;
        }
        const last = yield* step(d.id, threadId);
        if (last === "done" || last === "open") return;
        yield* finish(d.id, threadId, last);
      });

    const finish = (
      deliveryId: GroupChatDeliveryId,
      threadId: ThreadId,
      run: PortRun,
    ): Effect.Effect<void, StoreError | PortReadError> =>
      Effect.gen(function* () {
        const d = yield* store.delivery(deliveryId);
        if (d === null || !OPEN.has(d.state)) return;
        if (run.status === "cancelled" && !run.started) {
          const found =
            d.messageId === null
              ? null
              : yield* port.findMessage({ threadId, messageId: d.messageId });
          if (found !== null && found.runId !== null && found.runId !== run.id) {
            yield* store.transaction((tx) => tx.updateDelivery(d.id, { runId: found.runId }));
            return;
          }
          yield* store.transaction((tx) =>
            tx.updateDelivery(d.id, {
              state: "cancelled",
              wait: null,
              error: d.withdrawn ?? "removed from the thread's queue in T3",
            }),
          );
          yield* onTerminal(d.id);
          return;
        }
        const reply = yield* finishedReply(threadId, run.id);
        const text = reply === null || reply.text.trim() === "" ? null : reply.text;
        if (run.status === "completed") {
          if (text === null) yield* fail(d.id, "the run ended without a text reply");
          else yield* ingestReply(d.id, text);
        } else if (run.status === "interrupted") {
          // A reply the operator stopped is never counted: the lane pauses, a discussion round
          // waits, and Retry asks again. What was written so far stays visible as a note.
          yield* fail(d.id, "T3 run interrupted", {
            wait: { _tag: "stopped_in_t3" },
            pause: threadId,
            partial: text === null ? null : `${text}\n\n_(run interrupted)_`,
          });
        } else if (text !== null) {
          yield* ingestReply(d.id, `${text}\n\n_(run ${run.status})_`);
        } else {
          yield* fail(d.id, `T3 run ${run.status}`);
        }
      });

    // The adapter closes the last message after the run's own event, so a terminal run can read
    // as still streaming for a moment. The reply is taken only once the message is closed, and
    // the wait is on the thread's message events, never on a timer.
    const finishedReply = (
      threadId: ThreadId,
      runId: RunId,
    ): Effect.Effect<
      { readonly text: string; readonly streaming: boolean } | null,
      PortReadError
    > =>
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* port.changes(threadId, { messages: true });
          const first = yield* port.readReply({ threadId, runId });
          if (first?.streaming !== true) return first;
          const closed = yield* changes.pipe(
            Stream.mapEffect(() => port.readReply({ threadId, runId })),
            Stream.takeUntil((reply) => reply?.streaming !== true),
            Stream.runLast,
          );
          return Option.getOrElse(closed, () => first);
        }),
      );

    const fail = (
      deliveryId: GroupChatDeliveryId,
      error: string,
      options: {
        readonly dispatch?: GroupChatDelivery["dispatch"];
        readonly wait?: GroupChatWait | null;
        /** The thread whose lane pauses, written in this same transaction. */
        readonly pause?: ThreadId | null;
        /** Text the run produced before it ended, kept as a note that counts for nothing. */
        readonly partial?: string | null;
      } = {},
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const failed = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const d = yield* tx.delivery(deliveryId);
            if (d === null || !OPEN.has(d.state)) return null;
            const updated = yield* tx.updateDelivery(deliveryId, {
              state: d.withdrawn === null ? "failed" : "cancelled",
              error,
              wait: options.wait ?? null,
              ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
            });
            if (options.partial != null) {
              const member = yield* tx.member(d.memberId);
              yield* tx.appendMessage({
                groupId: d.groupId,
                author: { _tag: "member", memberId: d.memberId },
                kind: d.discussionId === null ? "reply" : "discussion_reply",
                text: options.partial,
                displayText:
                  member === null
                    ? options.partial
                    : stripLeadingHandle(options.partial, [member.handle, ...member.handleHistory]),
                turnKey: d.turnKey,
                triggerMessageId: d.triggerMessageId,
                discussionId: d.discussionId,
                round: d.round,
                late: true,
              });
            }
            if (options.pause != null) yield* markPaused(tx, options.pause);
            yield* tx.touchMember(d.memberId);
            return updated;
          }),
        );
        if (failed !== null) yield* onTerminal(deliveryId);
      });

    const ingestReply = (
      deliveryId: GroupChatDeliveryId,
      raw: string,
    ): Effect.Effect<"landed" | "duplicate" | "not_found", StoreError> =>
      Effect.gen(function* () {
        const stored = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const d = yield* tx.delivery(deliveryId);
            if (d === null) return "not_found" as const;
            if (d.replyMessageId !== null || d.state === "replied") return "duplicate" as const;
            const member = yield* tx.member(d.memberId);
            const discussion =
              d.discussionId === null ? null : yield* tx.discussion(d.discussionId);
            const memberRemoved = member === null || member.removedAt !== null;
            const signOff = countsAsSignOff({
              discussion,
              replyRound: d.round,
              memberRemoved,
              withdrawn: d.withdrawn !== null,
              text: raw,
            });
            const late =
              d.withdrawn !== null ||
              memberRemoved ||
              (discussion !== null &&
                (discussion.state !== "running" || discussion.round !== d.round));
            const stripped =
              member === null
                ? raw
                : stripLeadingHandle(raw, [member.handle, ...member.handleHistory]);
            const reply = yield* tx.appendMessage({
              groupId: d.groupId,
              author: { _tag: "member", memberId: d.memberId },
              kind: d.discussionId === null ? "reply" : "discussion_reply",
              text: raw,
              displayText: signOff ? withoutSignOffLine(stripped) : stripped,
              turnKey: d.turnKey,
              triggerMessageId: d.triggerMessageId,
              discussionId: d.discussionId,
              round: d.round,
              signOff,
              late,
            });
            yield* tx.updateDelivery(d.id, {
              state: "replied",
              replyMessageId: reply.id,
              error: null,
              wait: null,
            });
            yield* tx.touchMember(d.memberId);
            return "landed" as const;
          }),
        );
        if (stored === "landed") yield* onTerminal(deliveryId);
        return stored;
      });

    const postInbound: GroupChatEngine["Service"]["postInbound"] = (memberId, raw) =>
      store.transaction((tx) =>
        Effect.gen(function* () {
          const member = yield* tx.member(memberId);
          if (member === null || member.removedAt !== null || member.kind._tag === "t3")
            return null;
          const text = capUntrusted(raw);
          return yield* tx.appendMessage({
            groupId: member.groupId,
            author: { _tag: "member", memberId: member.id },
            kind: "inbound",
            text,
            displayText: stripLeadingHandle(text, [member.handle, ...member.handleHistory]),
          });
        }),
      );

    const onTerminal = (deliveryId: GroupChatDeliveryId): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const d = yield* store.delivery(deliveryId);
        if (d?.discussionId) yield* advanceDiscussion(d.discussionId);
        const member = d === null ? null : yield* store.member(d.memberId);
        if (member !== null) yield* kick(laneOf(member));
      });

    const withdraw = (tx: Tx, d: DeliveryRow, reason: string): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        if (!OPEN.has(d.state)) {
          // A reply the operator stopped in T3 holds its round until Retry. Stop here abandons
          // it instead, so the round moves on without this member's reply.
          if (d.state === "failed" && d.wait?._tag === "stopped_in_t3") {
            yield* tx.updateDelivery(d.id, { wait: null, withdrawn: reason });
          }
          return;
        }
        const action = onWithdraw({ state: d.state, dispatch: d.dispatch });
        if (action === "cancel" || stalled.has(d.id)) {
          stalled.delete(d.id);
          yield* tx.updateDelivery(d.id, { state: "cancelled", error: reason, wait: null });
          return;
        }
        yield* tx.updateDelivery(d.id, { withdrawn: reason });
        if (action === "cancel-queued" && d.runId !== null) {
          const member = yield* tx.member(d.memberId);
          const threadId = member === null ? null : threadIdOf(member);
          if (threadId !== null) yield* tx.insertCancel({ threadId, runId: d.runId });
        }
      });

    const settlePending: Effect.Effect<CancelOutcome> = store.pendingCancels.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, settleCancel)),
      Effect.map((outcomes) => (outcomes.every((o) => o === "settled") ? "settled" : "retry")),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logError("group chat could not read its pending cancels", { cause }).pipe(
              Effect.as("retry" as const),
            ),
      ),
    );

    const kickCancels: Effect.Effect<void> = Effect.flatMap(settlePending, (outcome) =>
      outcome === "settled" ? Effect.void : Effect.asVoid(Queue.offer(cancels, undefined)),
    );

    const drainCancels: Effect.Effect<never> = Effect.gen(function* () {
      for (;;) {
        if ((yield* settlePending) === "settled") yield* Queue.take(cancels);
        else yield* Effect.sleep(retryDelay);
      }
    });

    const settleCancel = (row: CancelRow): Effect.Effect<CancelOutcome> =>
      Effect.gen(function* () {
        const found =
          row.messageId === null
            ? null
            : yield* port.findMessage({ threadId: row.threadId, messageId: row.messageId });
        const runId = row.runId ?? found?.runId ?? null;
        if (runId !== null) yield* port.cancelQueued({ threadId: row.threadId, runId });
        // T3 may still take the message from a send in flight; that send lands the row and kicks.
        else if (row.inFlight) return "settled" as const;
        yield* store.transaction((tx) => tx.deleteCancel(row.id));
        return "settled" as const;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.gen(function* () {
                const thread = yield* Effect.result(port.thread(row.threadId));
                if (Result.isSuccess(thread) && thread.success === null) {
                  yield* store
                    .transaction((tx) => tx.deleteCancel(row.id))
                    .pipe(Effect.ignoreCause({ log: true }));
                  return "settled" as const;
                }
                yield* Effect.logWarning("group chat cancel did not reach T3; trying again", {
                  ...row,
                  cause,
                });
                return "retry" as const;
              }),
        ),
      );

    const enqueueRound = (
      tx: Tx,
      discussion: GroupChatDiscussion,
      trigger: GroupChatMessage,
    ): Effect.Effect<void, StoreError> =>
      Effect.forEach(
        discussion.participants,
        (memberId) =>
          Effect.gen(function* () {
            const member = yield* tx.member(memberId);
            if (member === null || member.removedAt !== null) return;
            yield* enqueueEnvelope(tx, member, trigger, {
              turnKey: `${discussion.id}:r${discussion.round}`,
              discussionId: discussion.id,
              round: discussion.round,
            });
          }),
        { discard: true },
      );

    const enqueueEnvelope = (
      tx: Tx,
      member: GroupChatMember,
      trigger: GroupChatMessage,
      options: {
        readonly turnKey?: string;
        readonly discussionId?: GroupChatDiscussionId;
        readonly round?: number;
      } = {},
    ): Effect.Effect<DeliveryRow, StoreError> =>
      Effect.gen(function* () {
        const lane = laneOf(member);
        const outstanding = (yield* laneDeliveries(tx, lane)).find((d) => OPEN.has(d.state));
        const paused = lane._tag === "thread" ? yield* tx.lanePaused(lane.threadId) : false;
        return yield* tx.insertDelivery({
          groupId: member.groupId,
          memberId: member.id,
          triggerMessageId: trigger.id,
          turnKey: options.turnKey ?? trigger.turnKey,
          discussionId: options.discussionId ?? null,
          round: options.round ?? null,
          toSeq: trigger.seq,
          wait: paused
            ? { _tag: "stopped_in_t3" }
            : outstanding === undefined
              ? null
              : { _tag: "lane_busy", deliveryId: outstanding.id },
        });
      });

    const endDiscussion = (
      tx: Tx,
      discussion: GroupChatDiscussion,
      reason: string,
      note: string | null = null,
    ): Effect.Effect<GroupChatDiscussion, StoreError> =>
      Effect.gen(function* () {
        const ended = yield* tx.updateDiscussion(discussion.id, {
          state: "ended",
          endReason: reason,
        });
        const text = `Discussion ended: ${reason}.${note === null ? "" : ` ${note[0]!.toUpperCase()}${note.slice(1)}.`}`;
        yield* tx.appendMessage({
          groupId: discussion.groupId,
          author: { _tag: "system" },
          kind: "system",
          text,
          displayText: text,
          turnKey: `${discussion.id}:r${discussion.round}`,
          discussionId: discussion.id,
          round: discussion.round,
        });
        return ended;
      });

    const advanceDiscussion = (
      discussionId: GroupChatDiscussionId,
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const kicks = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const discussion = yield* tx.discussion(discussionId);
            if (discussion === null || discussion.state !== "running") return [];
            const members = yield* tx.members(discussion.groupId, true);
            const stillIn = discussion.participants.filter((id) =>
              members.some((m) => m.id === id && m.removedAt === null),
            );
            const deliveries = yield* tx.deliveriesOfRound(discussion.id, discussion.round);
            const withSignOff = yield* Effect.forEach(deliveries, (d) =>
              Effect.map(
                d.replyMessageId === null ? Effect.succeed(null) : tx.message(d.replyMessageId),
                (reply) => ({
                  memberId: d.memberId,
                  state: d.state,
                  signOff: reply?.signOff === true,
                  paused: d.wait?._tag === "stopped_in_t3",
                }),
              ),
            );
            const decision = decideRound({
              round: discussion.round,
              maxRounds: discussion.maxRounds,
              stillIn,
              signedOff: discussion.signedOff,
              deliveries: withSignOff,
            });
            if (decision.action === "wait") return [];
            const updated =
              "signedOff" in decision
                ? yield* tx.updateDiscussion(discussion.id, { signedOff: decision.signedOff })
                : discussion;
            if (decision.action === "end") {
              yield* endDiscussion(tx, updated, decision.reason);
              return [];
            }
            const next = yield* tx.updateDiscussion(discussion.id, { round: decision.round });
            const text = `Discussion round ${next.round} of ${next.maxRounds}.`;
            const marker = yield* tx.appendMessage({
              groupId: discussion.groupId,
              author: { _tag: "system" },
              kind: "system",
              text,
              displayText: text,
              turnKey: `${discussion.id}:r${next.round}`,
              triggerMessageId: discussion.promptMessageId,
              discussionId: discussion.id,
              round: next.round,
            });
            yield* enqueueRound(tx, next, marker);
            return members
              .filter((m) => next.participants.includes(m.id) && m.removedAt === null)
              .map(laneOf);
          }),
        );
        yield* Effect.forEach(kicks, kick, { discard: true });
      });

    const validHandle = (input: string, taken: ReadonlyArray<string>) => {
      const handle = input.trim().replace(/^@/, "").toLowerCase();
      const problem = handleProblem(handle);
      if (problem !== null) return Effect.fail(new GroupChatInvalid({ reason: problem }));
      if (taken.includes(handle)) {
        return Effect.fail(
          new GroupChatInvalid({ reason: `@${handle} is already used in this group` }),
        );
      }
      return Effect.succeed(handle);
    };

    const addThreadMember = (
      tx: Tx,
      groupId: GroupChatGroupId,
      thread: GroupChatMemberThread,
      batchTitles: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const members = yield* tx.members(groupId, true);
        const same = (m: GroupChatMember) => threadIdOf(m) === thread.threadId;
        if (members.some((m) => m.removedAt === null && same(m))) {
          return yield* new GroupChatRefused({
            reason: `${thread.title} is already in this group`,
          });
        }
        const active = members.filter((m) => m.removedAt === null);
        const taken = active.map((m) => m.handle);
        const activeTitles = active.flatMap((m) =>
          m.kind._tag === "t3" ? [m.kind.thread.title] : [],
        );
        const returning = members.findLast((m) => m.removedAt !== null && same(m));
        if (returning !== undefined) {
          const handle = taken.includes(returning.handle)
            ? deriveHandle(thread.title, taken, activeTitles)
            : returning.handle;
          const color = active.some((m) => m.color === returning.color)
            ? nextColor(members)
            : returning.color;
          return yield* tx.updateMember(returning.id, {
            removed: false,
            handle,
            color,
            threadTitle: thread.title,
          });
        }
        const handle = deriveHandle(thread.title, taken, [...batchTitles, ...activeTitles]);
        return yield* tx.addMember({
          groupId,
          handle,
          color: nextColor(members),
          source: { _tag: "t3", thread },
        });
      });

    const HTTP_URL = /^https?:\/\/\S+$/i;
    const ORIGIN = /^https?:\/\/[^/\s]+$/i;

    const addExternalMember = (
      groupId: GroupChatGroupId,
      handleInput: string,
      kind: GroupChatExternalKind,
      config: GroupChatExternalConfig,
    ) =>
      Effect.gen(function* () {
        const url = config.url.trim();
        if (!HTTP_URL.test(url)) {
          return yield* new GroupChatInvalid({ reason: "a http(s) URL is required" });
        }
        const callbackOrigin = config.callbackOrigin.trim().replace(/\/+$/, "");
        if (callbackOrigin !== "" && !ORIGIN.test(callbackOrigin)) {
          return yield* new GroupChatInvalid({
            reason: "the callback origin must be a http(s) origin with no path",
          });
        }
        if (config.secret === "" && (yield* reach.exposed)) {
          return yield* new GroupChatRefused({
            reason:
              "this server is reachable beyond this machine, so an external member needs a secret: without one its hook URLs would accept unsigned posts",
          });
        }
        return yield* store.transaction((tx) =>
          Effect.gen(function* () {
            yield* requireGroup(tx, groupId);
            const members = yield* tx.members(groupId, true);
            const taken = members.filter((m) => m.removedAt === null).map((m) => m.handle);
            const handle =
              handleInput.trim() === ""
                ? deriveHandle(`${kind} agent`, taken)
                : yield* validHandle(handleInput, taken);
            return yield* tx.addMember({
              groupId,
              handle,
              color: nextColor(members),
              source: {
                _tag: kind,
                external: {
                  url,
                  headers: config.headers,
                  bodyTemplate:
                    config.bodyTemplate.trim() === "" ? DEFAULT_BODY_TEMPLATE : config.bodyTemplate,
                  replyPath: config.replyPath.trim() === "" ? DEFAULT_REPLY_PATH : config.replyPath,
                  secret: config.secret,
                  callbackOrigin,
                  inboundToken: randomHex(16),
                },
              },
            });
          }),
        );
      });

    const inboundUrlOf = (memberId: GroupChatMemberId) =>
      Effect.gen(function* () {
        const member = yield* store.member(memberId);
        if (member === null) return yield* notFound("member", memberId);
        if (member.external === null) {
          return yield* new GroupChatInvalid({ reason: "a T3 thread member has no inbound URL" });
        }
        const origin =
          member.external.callbackOrigin === "" ? reach.origin : member.external.callbackOrigin;
        return inboundUrl(origin, member.id, member.external.inboundToken);
      });

    const threadOf = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const info = yield* port.thread(threadId);
        if (info === null) return yield* notFound("thread", threadId);
        if (info.readOnly) {
          return yield* new GroupChatThreadRefused({
            action: "add",
            threadId,
            reason: "T3 does not accept messages into a provider-native subagent thread",
          });
        }
        const environmentId = yield* port.environmentId;
        return { environmentId, threadId, title: info.title };
      });

    const requireGroup = (tx: Tx, groupId: GroupChatGroupId) =>
      Effect.flatMap(tx.group(groupId), (group) =>
        group === null ? notFound("group", groupId) : Effect.succeed(group),
      );
    const requireMember = (tx: Tx, memberId: GroupChatMemberId) =>
      Effect.flatMap(tx.member(memberId), (member) =>
        member === null ? notFound("member", memberId) : Effect.succeed(member),
      );

    const validTitle = (input: string) => {
      const title = input.trim();
      if (title === "") return Effect.fail(new GroupChatInvalid({ reason: "title is required" }));
      if (title.length > GROUP_CHAT_TITLE_MAX_LENGTH) {
        return Effect.fail(
          new GroupChatInvalid({
            reason: `title is longer than ${GROUP_CHAT_TITLE_MAX_LENGTH} characters`,
          }),
        );
      }
      return Effect.succeed(title);
    };

    const createGroup = (input: string, threadIds: ReadonlyArray<ThreadId>) =>
      Effect.gen(function* () {
        const title = yield* validTitle(input);
        const unique = [...new Set(threadIds)];
        if (unique.length === 0) {
          return yield* new GroupChatInvalid({ reason: "pick at least one thread" });
        }
        const threads = yield* Effect.forEach(unique, threadOf);
        return yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const group = yield* tx.createGroup(title);
            const titles = threads.map((t) => t.title);
            yield* Effect.forEach(
              threads,
              (thread) => addThreadMember(tx, group.id, thread, titles),
              {
                discard: true,
              },
            );
            return group;
          }),
        );
      });

    const removeMember = (
      memberId: GroupChatMemberId,
    ): Effect.Effect<MemberRow, GroupChatNotFound | StoreError> =>
      Effect.gen(function* () {
        const { member, discussions } = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* requireMember(tx, memberId);
            const removed = yield* tx.updateMember(memberId, { removed: true });
            yield* Effect.forEach(
              yield* tx.deliveriesOfMember(memberId),
              (d) => withdraw(tx, d, "member removed"),
              { discard: true },
            );
            const discussions = (yield* tx.runningDiscussions).filter(
              (x) => x.groupId === current.groupId && x.participants.includes(memberId),
            );
            return { member: removed, discussions };
          }),
        );
        yield* kickCancels;
        yield* Effect.forEach(discussions, (x) => advanceDiscussion(x.id), { discard: true });
        yield* kick(laneOf(member));
        return member;
      });

    const sendMessage = (
      groupId: GroupChatGroupId,
      text: string,
      recipientIds: ReadonlyArray<GroupChatMemberId>,
    ) =>
      Effect.gen(function* () {
        if (text.trim() === "") return yield* new GroupChatInvalid({ reason: "message is empty" });
        const { message, lanes } = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const group = yield* requireGroup(tx, groupId);
            const active = yield* tx.members(groupId, false);
            const recipients = [...new Set(recipientIds)].filter((id) =>
              active.some((m) => m.id === id),
            );
            if (group.settledAt !== null) yield* tx.updateGroup(groupId, { settled: false });
            const message = yield* tx.appendMessage({
              groupId,
              author: { _tag: "operator" },
              kind: "chat",
              text,
              displayText: text,
              recipients,
            });
            const lanes: Lane[] = [];
            for (const id of recipients) {
              const member = active.find((m) => m.id === id)!;
              yield* enqueueEnvelope(tx, member, message);
              lanes.push(laneOf(member));
            }
            return { message, lanes };
          }),
        );
        for (const lane of lanes) {
          yield* releaseLane(lane);
          yield* kick(lane);
        }
        return message;
      });

    const retryDelivery = (
      deliveryId: GroupChatDeliveryId,
    ): Effect.Effect<
      DeliveryRow,
      GroupChatNotFound | GroupChatRefused | StoreError | PortReadError
    > =>
      Effect.gen(function* () {
        const d = yield* store.delivery(deliveryId);
        if (d === null) return yield* notFound("delivery", deliveryId);
        const member = yield* store.member(d.memberId);
        const discussion = d.discussionId === null ? null : yield* store.discussion(d.discussionId);
        const refusal = retryRefusal(d, member, discussion);
        if (refusal !== null) return yield* new GroupChatRefused({ reason: refusal });
        const lane = laneOf(member!);
        if (lane._tag === "thread" && d.dispatch === "unknown" && d.messageId !== null) {
          const found = yield* port.findMessage({
            threadId: lane.threadId,
            messageId: d.messageId,
          });
          if (found !== null && found.runId !== null) {
            yield* adopt(d, lane.threadId, found.runId);
            stalled.delete(deliveryId);
            yield* kick(lane);
            return yield* new GroupChatRefused({
              reason:
                "the thread already has this envelope, so it is followed instead of sent again",
            });
          }
        }
        const delivery = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx.delivery(deliveryId);
            if (current === null) return yield* notFound("delivery", deliveryId);
            if (
              current.state !== d.state ||
              current.dispatch !== d.dispatch ||
              current.messageId !== d.messageId
            ) {
              return yield* new GroupChatRefused({
                reason: "this envelope changed while Retry looked at it; look again",
              });
            }
            return current.state === "failed" || current.dispatch === "unknown"
              ? yield* tx.updateDelivery(current.id, {
                  state: "pending",
                  dispatch: "unsent",
                  attempt: current.attempt + 1,
                  runId: null,
                  messageId: null,
                  sentText: null,
                  error: null,
                  wait: null,
                  withdrawn: null,
                  // A fresh try budget under the same Idempotency-Key and callback URL.
                  external:
                    current.external === null
                      ? null
                      : { ...current.external, tries: 0, nextAttemptAt: null, acceptedAt: null },
                })
              : current;
          }),
        );
        resends.delete(deliveryId);
        stalled.delete(deliveryId);
        yield* releaseLane(lane);
        yield* kick(lane);
        return delivery;
      });

    const stopDelivery = (
      deliveryId: GroupChatDeliveryId,
    ): Effect.Effect<DeliveryRow, GroupChatNotFound | StoreError> =>
      Effect.gen(function* () {
        const delivery = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const d = yield* tx.delivery(deliveryId);
            if (d === null) return yield* notFound("delivery", deliveryId);
            yield* withdraw(tx, d, "stopped by operator");
            return (yield* tx.delivery(deliveryId))!;
          }),
        );
        yield* kickCancels;
        yield* onTerminal(deliveryId);
        return delivery;
      });

    const startDiscussion = (
      groupId: GroupChatGroupId,
      input: { participants: ReadonlyArray<GroupChatMemberId>; topic: string; maxRounds: number },
    ) =>
      Effect.gen(function* () {
        const topic = input.topic.trim();
        if (topic === "") return yield* new GroupChatInvalid({ reason: "a topic is required" });
        const { discussion, lanes } = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const group = yield* requireGroup(tx, groupId);
            if ((yield* tx.runningDiscussions).some((d) => d.groupId === groupId)) {
              return yield* new GroupChatRefused({
                reason: "a discussion is already running in this group",
              });
            }
            const active = yield* tx.members(groupId, false);
            const participants = [...new Set(input.participants)].filter((id) =>
              active.some((m) => m.id === id),
            );
            if (participants.length < 2) {
              return yield* new GroupChatInvalid({ reason: "pick at least two participants" });
            }
            if (group.settledAt !== null) yield* tx.updateGroup(groupId, { settled: false });
            const id = GroupChatDiscussionId.make(newId("dsc"));
            const prompt = yield* tx.appendMessage({
              groupId,
              author: { _tag: "operator" },
              kind: "discussion_prompt",
              text: topic,
              displayText: topic,
              recipients: participants,
              turnKey: `${id}:r1`,
              discussionId: id,
              round: 1,
            });
            const discussion = yield* tx.insertDiscussion({
              id,
              groupId,
              participants,
              topic,
              maxRounds: input.maxRounds,
              round: 1,
              state: "running",
              endReason: null,
              promptMessageId: prompt.id,
              signedOff: {},
            });
            yield* enqueueRound(tx, discussion, prompt);
            return {
              discussion,
              lanes: active.filter((m) => participants.includes(m.id)).map(laneOf),
            };
          }),
        );
        for (const lane of lanes) {
          yield* releaseLane(lane);
          yield* kick(lane);
        }
        return discussion;
      });

    const stopDiscussion = (
      discussionId: GroupChatDiscussionId,
    ): Effect.Effect<GroupChatDiscussion, GroupChatNotFound | StoreError> =>
      Effect.gen(function* () {
        const discussion = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx.discussion(discussionId);
            if (current === null) return yield* notFound("discussion", discussionId);
            if (current.state !== "running") return current;
            const round = yield* tx.deliveriesOfRound(discussionId, current.round);
            yield* Effect.forEach(round, (d) => withdraw(tx, d, "discussion stopped"), {
              discard: true,
            });
            const inFlight = (yield* tx.deliveriesOfRound(discussionId, current.round)).filter(
              (d) => d.state === "running" || d.dispatch === "sending" || d.dispatch === "unknown",
            ).length;
            const note =
              inFlight > 0
                ? `${inFlight} repl${inFlight === 1 ? "y was" : "ies were"} already in progress and may still arrive; no further rounds will start`
                : null;
            return yield* endDiscussion(tx, current, "stopped by operator", note);
          }),
        );
        yield* kickCancels;
        return discussion;
      });

    const answerMember = (
      memberId: GroupChatMemberId,
      requestId: string,
      answers: Readonly<Record<string, string | ReadonlyArray<string>>>,
    ) =>
      Effect.gen(function* () {
        const member = yield* store.member(memberId);
        if (member === null) return yield* notFound("member", memberId);
        const threadId = yield* requireThread(member);
        const pending = yield* port.pendingRequest(threadId);
        if (pending === null || pending._tag !== "question" || pending.requestId !== requestId) {
          return yield* new GroupChatRefused({
            reason: "T3 has no such pending question (it may already be answered)",
          });
        }
        const filled = Object.fromEntries(
          pending.questions.map((q) => [q.id, answers[q.id] ?? ""]),
        );
        const blank = (a: string | ReadonlyArray<string>): boolean =>
          typeof a === "string" ? a.trim() === "" : a.length === 0 || a.some(blank);
        if (Object.values(filled).some(blank)) {
          return yield* new GroupChatInvalid({ reason: "every question needs an answer" });
        }
        yield* port.respond({ threadId, requestId: pending.requestId, answers: filled }).pipe(
          Effect.catchTags({
            GroupChatPortRefused: (error) =>
              new GroupChatThreadRefused({ action: "answer", threadId, reason: error.reason }),
          }),
        );
        yield* kick(laneOf(member));
      });

    const requireThread = (member: GroupChatMember) => {
      const threadId = threadIdOf(member);
      return threadId === null
        ? Effect.fail(new GroupChatInvalid({ reason: `@${member.handle} is not a T3 thread` }))
        : Effect.succeed(threadId);
    };

    const settleMemberThread = (memberId: GroupChatMemberId, settled: boolean) =>
      Effect.gen(function* () {
        const member = yield* store.member(memberId);
        if (member === null) return yield* notFound("member", memberId);
        const threadId = yield* requireThread(member);
        yield* (settled ? port.settle(threadId) : port.unsettle(threadId)).pipe(
          Effect.catchTags({
            GroupChatPortRefused: (error) =>
              new GroupChatThreadRefused({ action: error.action, threadId, reason: error.reason }),
          }),
        );
      });

    const memberResult = (member: MemberRow): GroupChatDispatchResult => ({
      _tag: "member",
      member: publicMember(member),
    });

    const dispatch: GroupChatEngine["Service"]["dispatch"] = (command) => {
      switch (command._tag) {
        case "group.create":
          return Effect.map(createGroup(command.title, command.threadIds), (group) => ({
            _tag: "group",
            group,
          }));
        case "group.rename":
          return store
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* requireGroup(tx, command.groupId);
                const title = yield* validTitle(command.title);
                return yield* tx.updateGroup(command.groupId, { title });
              }),
            )
            .pipe(Effect.map((group) => ({ _tag: "group", group })));
        case "group.settle":
        case "group.unsettle":
          return store
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* requireGroup(tx, command.groupId);
                return yield* tx.updateGroup(command.groupId, {
                  settled: command._tag === "group.settle",
                });
              }),
            )
            .pipe(Effect.map((group) => ({ _tag: "group", group })));
        case "group.delete":
          return Effect.gen(function* () {
            const lanes = yield* store.transaction((tx) =>
              Effect.gen(function* () {
                yield* requireGroup(tx, command.groupId);
                const members = new Map(
                  (yield* tx.members(command.groupId, true)).map((m) => [m.id, m]),
                );
                for (const d of yield* tx.deliveriesOfGroup(command.groupId)) {
                  yield* withdraw(tx, d, "group deleted");
                  const member = members.get(d.memberId);
                  const threadId = member === undefined ? null : threadIdOf(member);
                  if (dispatchUnresolved(d) && d.messageId !== null && threadId !== null) {
                    yield* tx.insertCancel({
                      threadId,
                      messageId: d.messageId,
                      inFlight: d.dispatch === "sending",
                    });
                  }
                }
                yield* tx.deleteGroup(command.groupId);
                const unique = new Map(
                  [...members.values()].map((m) => [laneKey(laneOf(m)), laneOf(m)]),
                );
                return [...unique.values()];
              }),
            );
            yield* kickCancels;
            // A deleted delivery may have been what another group's envelope waited behind.
            yield* Effect.forEach(lanes, kick, { discard: true });
            return { _tag: "done" } as const;
          });
        case "member.add":
          return Effect.gen(function* () {
            const thread = yield* threadOf(command.threadId);
            const member = yield* store.transaction((tx) =>
              Effect.gen(function* () {
                yield* requireGroup(tx, command.groupId);
                return yield* addThreadMember(tx, command.groupId, thread, []);
              }),
            );
            return memberResult(member);
          });
        case "member.addExternal":
          return Effect.map(
            addExternalMember(command.groupId, command.handle, command.kind, command.config),
            memberResult,
          );
        case "member.inboundUrl":
          return Effect.map(inboundUrlOf(command.memberId), (url) => ({ _tag: "url", url }));
        case "member.remove":
          return Effect.map(removeMember(command.memberId), memberResult);
        case "member.rename":
          return store
            .transaction((tx) =>
              Effect.gen(function* () {
                const member = yield* requireMember(tx, command.memberId);
                const taken = (yield* tx.members(member.groupId, false))
                  .filter((m) => m.id !== member.id)
                  .map((m) => m.handle);
                const handle = yield* validHandle(command.handle, taken);
                return yield* tx.updateMember(member.id, { handle });
              }),
            )
            .pipe(Effect.map(memberResult));
        case "member.thread.settle":
          return Effect.as(settleMemberThread(command.memberId, true), { _tag: "done" } as const);
        case "member.thread.unsettle":
          return Effect.as(settleMemberThread(command.memberId, false), { _tag: "done" } as const);
        case "member.answer":
          return Effect.as(answerMember(command.memberId, command.requestId, command.answers), {
            _tag: "done",
          } as const);
        case "message.send":
          return Effect.map(
            sendMessage(command.groupId, command.text, command.recipients),
            (message) => ({ _tag: "message", message }),
          );
        case "delivery.retry":
          return Effect.flatMap(retryDelivery(command.deliveryId), (delivery) =>
            Effect.map(decorateRead(delivery), (decorated) => ({
              _tag: "delivery",
              delivery: decorated,
            })),
          );
        case "delivery.stop":
          return Effect.flatMap(stopDelivery(command.deliveryId), (delivery) =>
            Effect.map(decorateRead(delivery), (decorated) => ({
              _tag: "delivery",
              delivery: decorated,
            })),
          );
        case "discussion.start":
          return Effect.map(
            startDiscussion(command.groupId, {
              participants: command.participants,
              topic: command.topic,
              maxRounds: command.maxRounds,
            }),
            (discussion) => ({ _tag: "discussion", discussion }),
          );
        case "discussion.stop":
          return Effect.map(stopDiscussion(command.discussionId), (discussion) => ({
            _tag: "discussion",
            discussion,
          }));
      }
    };

    const snapshot: GroupChatEngine["Service"]["snapshot"] = Effect.gen(function* () {
      const groups = yield* store.groups;
      const members = yield* store.activeMembers;
      return { groups, members: members.map(publicMember) };
    });

    const groupPage: GroupChatEngine["Service"]["groupPage"] = (groupId, query) =>
      Effect.gen(function* () {
        const group = yield* store.group(groupId);
        if (group === null) return yield* notFound("group", groupId);
        const members = (yield* store.members(groupId, true)).map(publicMember);
        const discussions = yield* store.discussionsOfGroup(groupId);
        const byMember = new Map(members.map((m) => [m.id, m]));
        const byDiscussion = new Map(discussions.map((d) => [d.id, d]));
        const { messages, hasOlder } = yield* store.messagePage(groupId, {
          ...query,
          limit: GROUP_CHAT_PAGE_SIZE,
        });
        const ofPage = yield* store.deliveriesOfMessages(messages.map((m) => m.id));
        const open = query.before === undefined ? yield* store.openDeliveriesOfGroup(groupId) : [];
        const rows = new Map<GroupChatDeliveryId, DeliveryRow>();
        for (const d of [...ofPage, ...open]) rows.set(d.id, d);
        const deliveries = [...rows.values()].map((d) =>
          onPage(
            decorate(
              d,
              byMember.get(d.memberId) ?? null,
              d.discussionId === null ? null : (byDiscussion.get(d.discussionId) ?? null),
            ),
          ),
        );
        return {
          group,
          members,
          discussions,
          messages,
          deliveries,
          olderBefore: hasOlder ? messages[0]!.seq : null,
        };
      });

    const delivery: GroupChatEngine["Service"]["delivery"] = (deliveryId) =>
      Effect.gen(function* () {
        const row = yield* store.delivery(deliveryId);
        if (row === null) return yield* notFound("delivery", deliveryId);
        return yield* decorateRead(row);
      });

    const events: GroupChatEngine["Service"]["events"] = Stream.fromPubSub(store.changes).pipe(
      Stream.mapEffect(({ seq, change }): Effect.Effect<GroupChatStreamEvent, StoreError> => {
        switch (change._tag) {
          case "delivery":
            return Effect.map(decorateRead(change.delivery), (decorated) => ({
              _tag: "delivery",
              seq,
              delivery: head(decorated),
            }));
          case "group":
            return Effect.succeed({ _tag: "group", seq, group: change.group });
          case "group.deleted":
            return Effect.succeed({ _tag: "group.deleted", seq, groupId: change.groupId });
          case "member":
            return Effect.succeed({ _tag: "member", seq, member: publicMember(change.member) });
          case "message": {
            const { text: _text, displayText: _displayText, ...message } = change.message;
            return Effect.succeed({ _tag: "message", seq, message });
          }
          case "discussion": {
            const { topic: _topic, ...discussion } = change.discussion;
            return Effect.succeed({ _tag: "discussion", seq, discussion });
          }
        }
      }),
    );

    const recover = Effect.gen(function* () {
      yield* store.transaction((tx) => tx.landAllCancels);
      yield* Effect.forkIn(drainCancels, scope);
      const open = yield* store.openDeliveries;
      const lanes = new Map<string, Lane>();
      for (const d of open) {
        const member = yield* store.member(d.memberId);
        if (member !== null) lanes.set(laneKey(laneOf(member)), laneOf(member));
      }
      yield* Effect.forEach([...lanes.values()], kick, { discard: true });
      const running = yield* store.runningDiscussions;
      for (const discussion of running) {
        yield* Effect.log("group chat resuming a discussion", {
          discussionId: discussion.id,
          round: discussion.round,
        });
        yield* advanceDiscussion(discussion.id);
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logError("group chat boot recovery failed", { cause })),
      Effect.withSpan("groupChat.recover"),
    );

    const start: GroupChatEngine["Service"]["start"] = forkParked(recover);

    const landReply: GroupChatEngine["Service"]["landReply"] = (deliveryId, text) =>
      ingestReply(deliveryId, capUntrusted(text));

    return GroupChatEngine.of({
      snapshot,
      groupPage,
      delivery,
      dispatch,
      events,
      start,
      landReply,
      postInbound,
    });
  });
