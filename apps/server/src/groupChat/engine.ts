import {
  type GroupChatCommand,
  type GroupChatCommandError,
  type GroupChatDelivery,
  type GroupChatDeliveryId,
  type GroupChatDiscussion,
  GroupChatDiscussionId,
  type GroupChatDispatchResult,
  type GroupChatGroupId,
  type GroupChatGroupSnapshot,
  GroupChatInvalid,
  type GroupChatMember,
  type GroupChatMemberId,
  type GroupChatMessage,
  GroupChatNotFound,
  type GroupChatPendingInput,
  GroupChatRefused,
  type GroupChatSnapshot,
  type GroupChatStreamEvent,
  GroupChatThreadRefused,
  type GroupChatWait,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { newId } from "./domain.ts";
import { deriveHandle, nextColor, renderEnvelope } from "./envelope.ts";
import { countsAsSignOff, decideRound, gateSend, onWithdraw } from "./rounds.ts";
import type { DeliveryRow, GroupChatStore, StoreError, Tx } from "./store.ts";
import { handleProblem, stripLeadingHandle, withoutSignOffLine } from "./text.ts";
import {
  dispatchIds,
  GroupChatThreadPort,
  type PortReadError,
  type PortRun,
} from "./threadPort.ts";

export type EngineError = GroupChatCommandError | StoreError | PortReadError;

export class GroupChatEngine extends Context.Service<
  GroupChatEngine,
  {
    readonly snapshot: Effect.Effect<GroupChatSnapshot, StoreError>;
    readonly groupPage: (
      groupId: GroupChatGroupId,
    ) => Effect.Effect<GroupChatGroupSnapshot, GroupChatNotFound | StoreError>;
    readonly dispatch: (
      command: GroupChatCommand,
    ) => Effect.Effect<GroupChatDispatchResult, EngineError>;
    readonly events: Stream.Stream<GroupChatStreamEvent, StoreError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/groupChat/engine/GroupChatEngine") {}

const OPEN = new Set<GroupChatDelivery["state"]>(["pending", "queued", "running"]);
const TERMINAL = new Set<PortRun["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

const MAX_RESENDS = 1;
const STREAMING_LOOKS = 20;

/** How long a lane waits after a read or store failure before it looks at its envelope again. */
export class RetryDelay extends Context.Reference<Duration.Input>(
  "t3/groupChat/engine/RetryDelay",
  {
    defaultValue: () => "2 seconds",
  },
) {}

interface Lane {
  readonly threadId: ThreadId;
  readonly signal: Queue.Queue<void>;
}

/** A lane is paused while any of its pending envelopes carries the `stopped_in_t3` mark. */
const pausedIn = (deliveries: ReadonlyArray<DeliveryRow>) =>
  deliveries.some((d) => d.state === "pending" && d.wait?._tag === "stopped_in_t3");

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
    const retryDelay = yield* RetryDelay;
    const scope = yield* Effect.scope;
    const lanes = new Map<ThreadId, Lane>();
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
      const { roster: _roster, ...rest } = delivery;
      return { ...rest, retryable: retryRefusal(delivery, member, discussion) === null };
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

    const lane = (threadId: ThreadId): Effect.Effect<Lane> =>
      Effect.gen(function* () {
        const existing = lanes.get(threadId);
        if (existing !== undefined) return existing;
        const created: Lane = {
          threadId,
          signal: yield* Queue.make<void>({ capacity: 1, strategy: "sliding" }),
        };
        lanes.set(threadId, created);
        yield* Effect.forkIn(runLane(created), scope);
        return created;
      });

    const kick = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.flatMap(lane(threadId), (l) => Queue.offer(l.signal, undefined));

    const nextWork = (l: Lane): Effect.Effect<Work | null, StoreError> =>
      Effect.gen(function* () {
        const deliveries = yield* store.deliveriesOfThread(l.threadId);
        const open = deliveries.filter((d) => OPEN.has(d.state));
        const unresolved = open.find(
          (d) => (d.dispatch === "sending" || d.dispatch === "unknown") && !stalled.has(d.id),
        );
        if (unresolved !== undefined) return { kind: "resolve", delivery: unresolved };
        const outstanding = open.find((d) => d.dispatch === "accepted" && d.state !== "pending");
        if (outstanding !== undefined) return { kind: "follow", delivery: outstanding };
        const pending = open.find(
          (d) =>
            d.state === "pending" && d.dispatch === "unsent" && d.wait?._tag !== "stopped_in_t3",
        );
        return pending === undefined ? null : { kind: "send", delivery: pending };
      });

    const runLane = (l: Lane): Effect.Effect<never> =>
      Effect.gen(function* () {
        for (;;) {
          const work = yield* nextWork(l).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("group chat lane could not read its deliveries", {
                threadId: l.threadId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
          if (work === null) {
            yield* Queue.take(l.signal);
            continue;
          }
          // A failure to read or record is never a verdict on the envelope: the delivery keeps its
          // state and the lane looks again after a pause, so an accepted run is never abandoned.
          yield* runWork(work).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logError("group chat lane paused after a failure", {
                    deliveryId: work.delivery.id,
                    threadId: l.threadId,
                    cause,
                  }).pipe(Effect.andThen(Effect.sleep(retryDelay))),
            ),
          );
        }
      });

    const runWork = (work: Work): Effect.Effect<void, StoreError | PortReadError> => {
      switch (work.kind) {
        case "send":
          return send(work.delivery);
        case "resolve":
          return resolve(work.delivery);
        case "follow":
          return follow(work.delivery);
      }
    };

    /** Marks the thread's waiting envelopes, in the transaction that records why. */
    const markPaused = (tx: Tx, threadId: ThreadId): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        for (const d of yield* tx.deliveriesOfThread(threadId)) {
          if (d.state === "pending") {
            yield* tx.updateDelivery(d.id, { wait: { _tag: "stopped_in_t3" } });
          }
        }
      });

    const releaseLane = (threadId: ThreadId): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        yield* store.transaction((tx) =>
          Effect.gen(function* () {
            for (const d of yield* tx.deliveriesOfThread(threadId)) {
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
        const own = (m: GroupChatMessage) =>
          m.author._tag === "member" && m.author.memberId === member.id;
        const discussion = d.discussionId === null ? null : yield* tx.discussion(d.discussionId);
        const previous =
          discussion !== null && d.round !== null && d.round > 1
            ? (yield* tx.messages(d.groupId)).filter(
                (m) =>
                  m.discussionId === discussion.id &&
                  m.kind === "discussion_reply" &&
                  m.round === d.round! - 1 &&
                  !own(m),
              )
            : [];
        const after = (yield* tx.messages(d.groupId, member.seenSeq)).filter(
          (m) => m.seq <= d.toSeq && !own(m),
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
        return { envelope, fromSeq: member.seenSeq + 1, roster };
      });

    const claim = (deliveryId: GroupChatDeliveryId) =>
      store.transaction((tx) =>
        Effect.gen(function* () {
          const d = yield* tx.delivery(deliveryId);
          if (d === null) return null;
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
            patch = { ...patch, envelope, fromSeq: built.fromSeq, roster: built.roster };
          }
          const ids = dispatchIds({
            groupMessageId: d.triggerMessageId,
            memberId: d.memberId,
            attempt: d.attempt,
          });
          const claimed = yield* tx.updateDelivery(d.id, { ...patch, messageId: ids.messageId });
          return { delivery: claimed, member: member!, ids, envelope };
        }),
      );

    const send = (d: DeliveryRow): Effect.Effect<void, StoreError | PortReadError> =>
      Effect.gen(function* () {
        const member = yield* store.member(d.memberId);
        if (member === null) {
          yield* fail(d.id, "member or group no longer exists");
          return;
        }
        const threadId = member.thread.threadId;
        const projectId = yield* projectIdOf(threadId);
        if (projectId === null) {
          yield* fail(d.id, "the member's thread no longer exists", "rejected");
          return;
        }
        const claimed = yield* claim(d.id);
        if (claimed === null) return;
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
            yield* store.transaction((tx) =>
              Effect.gen(function* () {
                const current = yield* tx.delivery(d.id);
                if (current === null) return;
                yield* tx.updateDelivery(d.id, {
                  dispatch: "rejected",
                  state: current.withdrawn === null ? "failed" : "cancelled",
                  error: error.reason,
                  wait: null,
                });
              }),
            );
            yield* onTerminal(d.id);
            return;
          }
          yield* store.transaction((tx) =>
            tx.updateDelivery(d.id, { dispatch: "unknown", error: error.message }),
          );
          return;
        }
        yield* store.transaction((tx) =>
          tx.updateDelivery(d.id, {
            dispatch: "accepted",
            runId: sent.success.runId,
            state: "queued",
            error: null,
          }),
        );
        resends.delete(d.id);
      });

    const resolve = (d: DeliveryRow): Effect.Effect<void, StoreError | PortReadError> =>
      Effect.gen(function* () {
        const member = yield* store.member(d.memberId);
        if (member === null || d.messageId === null) {
          yield* fail(d.id, "member or envelope record is incomplete");
          return;
        }
        if ((yield* port.thread(member.thread.threadId)) === null) {
          yield* fail(d.id, "the member's thread no longer exists", "rejected");
          return;
        }
        const found = yield* port.findMessage({
          threadId: member.thread.threadId,
          messageId: d.messageId,
        });
        if (found !== null && found.runId !== null) {
          yield* store.transaction((tx) =>
            tx.updateDelivery(d.id, {
              dispatch: "accepted",
              runId: found.runId,
              state: d.state === "pending" ? "queued" : d.state,
              error: null,
            }),
          );
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
              error: `${d.error ?? "the send's outcome stayed unknown"}. Retry sends it again as a new attempt; a restart looks for it first.`,
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
      if (view.queueHeld) return { _tag: "queue_held" };
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
        if (member === null || d.runId === null) {
          yield* fail(d.id, "member or run record is incomplete");
          return;
        }
        const threadId = member.thread.threadId;
        const projectId = yield* projectIdOf(threadId);
        if (projectId === null) {
          yield* fail(d.id, "the member's thread no longer exists");
          return;
        }
        const changes = yield* port.changes(threadId);
        // A Stop recorded before a crash may never have reached T3's queue. Cancelling again is
        // safe: a refusal means the run started, and the follow below takes it from there.
        if (d.withdrawn !== null && d.state === "queued") {
          yield* port.cancelQueued({ threadId, runId: d.runId });
        }
        const first = yield* step(d.id, threadId);
        if (first === "done") return;
        const refresher = yield* changes.pipe(
          Stream.runForEach(() => Effect.asVoid(step(d.id, threadId))),
          Effect.forkChild,
        );
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
        let reply = yield* port.readReply({ threadId, runId: run.id });
        // The adapter closes a message before it ends the run, so a streaming one here is a
        // moment away from done. A bounded wait is cheaper than following a terminal run.
        for (let looks = 0; reply?.streaming === true && looks < STREAMING_LOOKS; looks++) {
          yield* Effect.sleep(retryDelay);
          reply = yield* port.readReply({ threadId, runId: run.id });
        }
        const text = reply === null || reply.text.trim() === "" ? null : reply.text;
        const note =
          reply?.streaming === true
            ? "\n\n_(the reply was still streaming when the run ended)_"
            : "";
        // The pause is written in the transaction that closes the delivery, so a boot that looks
        // at an interrupted run again cannot undo a Retry the operator already gave.
        const pause = run.status === "interrupted" ? threadId : null;
        if (run.status === "completed") {
          if (text === null) yield* fail(d.id, "the run ended without a text reply");
          else yield* ingestReply(d.id, `${text}${note}`);
        } else if (text !== null) {
          yield* ingestReply(d.id, `${text}${note}\n\n_(run ${run.status})_`, pause);
        } else {
          yield* fail(
            d.id,
            `T3 run ${run.status}`,
            undefined,
            pause === null ? null : { _tag: "stopped_in_t3" },
            pause,
          );
        }
      });

    const fail = (
      deliveryId: GroupChatDeliveryId,
      error: string,
      dispatch?: GroupChatDelivery["dispatch"],
      wait: GroupChatWait | null = null,
      pause: ThreadId | null = null,
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const failed = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const d = yield* tx.delivery(deliveryId);
            if (d === null || !OPEN.has(d.state)) return null;
            const updated = yield* tx.updateDelivery(deliveryId, {
              state: d.withdrawn === null ? "failed" : "cancelled",
              error,
              wait,
              ...(dispatch === undefined ? {} : { dispatch }),
            });
            if (pause !== null) yield* markPaused(tx, pause);
            yield* tx.touchMember(d.memberId);
            return updated;
          }),
        );
        if (failed !== null) yield* onTerminal(deliveryId);
      });

    const ingestReply = (
      deliveryId: GroupChatDeliveryId,
      raw: string,
      pause: ThreadId | null = null,
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const stored = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const d = yield* tx.delivery(deliveryId);
            if (d === null || d.replyMessageId !== null || d.state === "replied") return null;
            const member = yield* tx.member(d.memberId);
            const discussion =
              d.discussionId === null ? null : yield* tx.discussion(d.discussionId);
            const memberRemoved = member === null || member.removedAt !== null;
            const signOff = countsAsSignOff({
              discussion,
              replyRound: d.round,
              memberRemoved,
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
            if (pause !== null) yield* markPaused(tx, pause);
            yield* tx.touchMember(d.memberId);
            return reply;
          }),
        );
        if (stored !== null) yield* onTerminal(deliveryId);
      });

    const onTerminal = (deliveryId: GroupChatDeliveryId): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const d = yield* store.delivery(deliveryId);
        if (d?.discussionId) yield* advanceDiscussion(d.discussionId);
        const member = d === null ? null : yield* store.member(d.memberId);
        if (member !== null) yield* kick(member.thread.threadId);
      });

    const withdraw = (
      tx: Tx,
      d: DeliveryRow,
      reason: string,
    ): Effect.Effect<{ readonly threadId: ThreadId; readonly runId: RunId } | null, StoreError> =>
      Effect.gen(function* () {
        if (!OPEN.has(d.state)) return null;
        const action = onWithdraw({ state: d.state, dispatch: d.dispatch });
        if (action === "cancel") {
          yield* tx.updateDelivery(d.id, { state: "cancelled", error: reason, wait: null });
          return null;
        }
        yield* tx.updateDelivery(d.id, { withdrawn: reason });
        if (action === "cancel-queued" && d.runId !== null) {
          const member = yield* tx.member(d.memberId);
          return member === null ? null : { threadId: member.thread.threadId, runId: d.runId };
        }
        return null;
      });

    const cancelQueued = (
      targets: ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId } | null>,
    ): Effect.Effect<void> =>
      Effect.forEach(
        targets.flatMap((t) => (t === null ? [] : [t])),
        (target) => port.cancelQueued(target).pipe(Effect.ignoreCause({ log: true })),
        { discard: true },
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
        const outstanding = (yield* tx.deliveriesOfThread(member.thread.threadId)).find((d) =>
          OPEN.has(d.state),
        );
        const paused = pausedIn(yield* tx.deliveriesOfThread(member.thread.threadId));
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
              .map((m) => m.thread.threadId);
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
      thread: GroupChatMember["thread"],
      batchTitles: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const members = yield* tx.members(groupId, true);
        const same = (m: GroupChatMember) => m.thread.threadId === thread.threadId;
        if (members.some((m) => m.removedAt === null && same(m))) {
          return yield* new GroupChatRefused({
            reason: `${thread.title} is already in this group`,
          });
        }
        const active = members.filter((m) => m.removedAt === null);
        const taken = active.map((m) => m.handle);
        const activeTitles = active.map((m) => m.thread.title);
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
        return yield* tx.addMember({ groupId, handle, color: nextColor(members), thread });
      });

    const threadOf = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const info = yield* port.thread(threadId);
        if (info === null) return yield* notFound("thread", threadId);
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

    const createGroup = (title: string, threadIds: ReadonlyArray<ThreadId>) =>
      Effect.gen(function* () {
        if (title.trim() === "")
          return yield* new GroupChatInvalid({ reason: "title is required" });
        const unique = [...new Set(threadIds)];
        if (unique.length === 0) {
          return yield* new GroupChatInvalid({ reason: "pick at least one thread" });
        }
        const threads = yield* Effect.forEach(unique, threadOf);
        return yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const group = yield* tx.createGroup(title.trim());
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
    ): Effect.Effect<GroupChatMember, GroupChatNotFound | StoreError> =>
      Effect.gen(function* () {
        const { member, cancels, discussions } = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* requireMember(tx, memberId);
            const removed = yield* tx.updateMember(memberId, { removed: true });
            const cancels = yield* Effect.forEach(yield* tx.deliveriesOfMember(memberId), (d) =>
              withdraw(tx, d, "member removed"),
            );
            const discussions = (yield* tx.runningDiscussions).filter(
              (x) => x.groupId === current.groupId && x.participants.includes(memberId),
            );
            return { member: removed, cancels, discussions };
          }),
        );
        yield* cancelQueued(cancels);
        yield* Effect.forEach(discussions, (x) => advanceDiscussion(x.id), { discard: true });
        yield* kick(member.thread.threadId);
        return member;
      });

    const sendMessage = (
      groupId: GroupChatGroupId,
      text: string,
      recipientIds: ReadonlyArray<GroupChatMemberId>,
    ) =>
      Effect.gen(function* () {
        if (text.trim() === "") return yield* new GroupChatInvalid({ reason: "message is empty" });
        const { message, threads } = yield* store.transaction((tx) =>
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
            const threads: ThreadId[] = [];
            for (const id of recipients) {
              const member = active.find((m) => m.id === id)!;
              yield* enqueueEnvelope(tx, member, message);
              threads.push(member.thread.threadId);
            }
            return { message, threads };
          }),
        );
        for (const threadId of threads) {
          yield* releaseLane(threadId);
          yield* kick(threadId);
        }
        return message;
      });

    const retryDelivery = (
      deliveryId: GroupChatDeliveryId,
    ): Effect.Effect<DeliveryRow, GroupChatNotFound | GroupChatRefused | StoreError> =>
      Effect.gen(function* () {
        const { delivery, threadId } = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const d = yield* tx.delivery(deliveryId);
            if (d === null) return yield* notFound("delivery", deliveryId);
            const member = yield* tx.member(d.memberId);
            const discussion =
              d.discussionId === null ? null : yield* tx.discussion(d.discussionId);
            const refusal = retryRefusal(d, member, discussion);
            if (refusal !== null) return yield* new GroupChatRefused({ reason: refusal });
            const delivery =
              d.state === "failed" || d.dispatch === "unknown"
                ? yield* tx.updateDelivery(d.id, {
                    state: "pending",
                    dispatch: "unsent",
                    attempt: d.attempt + 1,
                    runId: null,
                    messageId: null,
                    sentText: null,
                    error: null,
                    wait: null,
                    withdrawn: null,
                  })
                : d;
            return { delivery, threadId: member!.thread.threadId };
          }),
        );
        resends.delete(deliveryId);
        stalled.delete(deliveryId);
        yield* releaseLane(threadId);
        yield* kick(threadId);
        return delivery;
      });

    const stopDelivery = (
      deliveryId: GroupChatDeliveryId,
    ): Effect.Effect<DeliveryRow, GroupChatNotFound | StoreError> =>
      Effect.gen(function* () {
        const { delivery, cancel } = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const d = yield* tx.delivery(deliveryId);
            if (d === null) return yield* notFound("delivery", deliveryId);
            const cancel = yield* withdraw(tx, d, "stopped by operator");
            return { delivery: (yield* tx.delivery(deliveryId))!, cancel };
          }),
        );
        yield* cancelQueued([cancel]);
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
        const { discussion, threads } = yield* store.transaction((tx) =>
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
              threads: active
                .filter((m) => participants.includes(m.id))
                .map((m) => m.thread.threadId),
            };
          }),
        );
        for (const threadId of threads) {
          yield* releaseLane(threadId);
          yield* kick(threadId);
        }
        return discussion;
      });

    const stopDiscussion = (
      discussionId: GroupChatDiscussionId,
    ): Effect.Effect<GroupChatDiscussion, GroupChatNotFound | StoreError> =>
      Effect.gen(function* () {
        const { discussion, cancels } = yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx.discussion(discussionId);
            if (current === null) return yield* notFound("discussion", discussionId);
            if (current.state !== "running") return { discussion: current, cancels: [] };
            const round = yield* tx.deliveriesOfRound(discussionId, current.round);
            const cancels = yield* Effect.forEach(round, (d) =>
              withdraw(tx, d, "discussion stopped"),
            );
            const inFlight = (yield* tx.deliveriesOfRound(discussionId, current.round)).filter(
              (d) => d.state === "running" || d.dispatch === "sending" || d.dispatch === "unknown",
            ).length;
            const note =
              inFlight > 0
                ? `${inFlight} repl${inFlight === 1 ? "y was" : "ies were"} already in progress and may still arrive; no further rounds will start`
                : null;
            const discussion = yield* endDiscussion(tx, current, "stopped by operator", note);
            return { discussion, cancels };
          }),
        );
        yield* cancelQueued(cancels);
        return discussion;
      });

    const answerMember = (
      memberId: GroupChatMemberId,
      requestId: string,
      answers: Readonly<Record<string, string>>,
    ) =>
      Effect.gen(function* () {
        const member = yield* store.member(memberId);
        if (member === null) return yield* notFound("member", memberId);
        const pending = yield* port.pendingRequest(member.thread.threadId);
        if (pending === null || pending._tag !== "question" || pending.requestId !== requestId) {
          return yield* new GroupChatRefused({
            reason: "T3 has no such pending question (it may already be answered)",
          });
        }
        const filled = Object.fromEntries(
          pending.questions.map((q) => [q.id, answers[q.id] ?? ""]),
        );
        if (Object.values(filled).some((a) => a.trim() === "")) {
          return yield* new GroupChatInvalid({ reason: "every question needs an answer" });
        }
        yield* port
          .respond({
            threadId: member.thread.threadId,
            requestId: pending.requestId,
            answers: filled,
          })
          .pipe(
            Effect.catchTags({
              GroupChatPortRefused: (error) =>
                new GroupChatThreadRefused({
                  action: "answer",
                  threadId: member.thread.threadId,
                  reason: error.reason,
                }),
            }),
          );
        yield* kick(member.thread.threadId);
      });

    const settleMemberThread = (memberId: GroupChatMemberId, settled: boolean) =>
      Effect.gen(function* () {
        const member = yield* store.member(memberId);
        if (member === null) return yield* notFound("member", memberId);
        const threadId = member.thread.threadId;
        yield* (settled ? port.settle(threadId) : port.unsettle(threadId)).pipe(
          Effect.catchTags({
            GroupChatPortRefused: (error) =>
              new GroupChatThreadRefused({ action: error.action, threadId, reason: error.reason }),
          }),
        );
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
                if (command.title.trim() === "") {
                  return yield* new GroupChatInvalid({ reason: "title is required" });
                }
                return yield* tx.updateGroup(command.groupId, { title: command.title.trim() });
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
            const cancels = yield* store.transaction((tx) =>
              Effect.gen(function* () {
                yield* requireGroup(tx, command.groupId);
                const cancels = yield* Effect.forEach(
                  yield* tx.deliveriesOfGroup(command.groupId),
                  (d) => withdraw(tx, d, "group deleted"),
                );
                yield* tx.deleteGroup(command.groupId);
                return cancels;
              }),
            );
            yield* cancelQueued(cancels);
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
            return { _tag: "member", member } as const;
          });
        case "member.remove":
          return Effect.map(removeMember(command.memberId), (member) => ({
            _tag: "member",
            member,
          }));
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
            .pipe(Effect.map((member) => ({ _tag: "member", member })));
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
      return { groups, members };
    });

    const groupPage: GroupChatEngine["Service"]["groupPage"] = (groupId) =>
      Effect.gen(function* () {
        const group = yield* store.group(groupId);
        if (group === null) return yield* notFound("group", groupId);
        const members = yield* store.members(groupId, true);
        const discussions = yield* store.discussionsOfGroup(groupId);
        const byMember = new Map(members.map((m) => [m.id, m]));
        const byDiscussion = new Map(discussions.map((d) => [d.id, d]));
        const deliveries = (yield* store.deliveriesOfGroup(groupId)).map((d) =>
          decorate(
            d,
            byMember.get(d.memberId) ?? null,
            d.discussionId === null ? null : (byDiscussion.get(d.discussionId) ?? null),
          ),
        );
        return {
          group,
          members,
          messages: yield* store.messages(groupId),
          deliveries,
          discussions,
        };
      });

    const events: GroupChatEngine["Service"]["events"] = Stream.fromPubSub(store.changes).pipe(
      Stream.mapEffect(({ seq, change }): Effect.Effect<GroupChatStreamEvent, StoreError> => {
        switch (change._tag) {
          case "delivery":
            return Effect.map(decorateRead(change.delivery), (delivery) => ({
              _tag: "delivery",
              seq,
              delivery,
            }));
          case "group":
            return Effect.succeed({ _tag: "group", seq, group: change.group });
          case "group.deleted":
            return Effect.succeed({ _tag: "group.deleted", seq, groupId: change.groupId });
          case "member":
            return Effect.succeed({ _tag: "member", seq, member: change.member });
          case "message":
            return Effect.succeed({ _tag: "message", seq, message: change.message });
          case "discussion":
            return Effect.succeed({ _tag: "discussion", seq, discussion: change.discussion });
        }
      }),
    );

    const recover = Effect.gen(function* () {
      const open = yield* store.openDeliveries;
      const threads = new Set<ThreadId>();
      for (const d of open) {
        const member = yield* store.member(d.memberId);
        if (member !== null) threads.add(member.thread.threadId);
      }
      yield* Effect.forEach([...threads], kick, { discard: true });
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

    return GroupChatEngine.of({ snapshot, groupPage, dispatch, events, start });
  });
