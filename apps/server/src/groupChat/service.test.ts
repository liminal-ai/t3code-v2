import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type GroupChatGroupId,
  type GroupChatMemberId,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { DeliveryRow } from "./store.ts";
import { type App, boot, type FakeThreads, makeFakeThreads, tempBaseDir } from "./testkit.ts";

const alpha = ThreadId.make("alpha");
const bravo = ThreadId.make("bravo");

const setup = Effect.gen(function* () {
  const fake = yield* makeFakeThreads;
  const baseDir = yield* tempBaseDir;
  const app = yield* boot(fake, baseDir);
  return { fake, baseDir, app };
});

const createGroup = (app: App, title: string, threads: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    const result = yield* app.dispatch({ _tag: "group.create", title, threadIds: threads });
    assert.strictEqual(result._tag, "group");
    const group = result._tag === "group" ? result.group : null;
    const members = yield* app.store.members(group!.id, true);
    const byThread = new Map(members.map((m) => [m.thread.threadId, m]));
    return { group: group!, members, member: (threadId: ThreadId) => byThread.get(threadId)! };
  });

const send = (
  app: App,
  groupId: GroupChatGroupId,
  text: string,
  recipients: ReadonlyArray<GroupChatMemberId>,
) =>
  Effect.map(app.dispatch({ _tag: "message.send", groupId, text, recipients }), (result) =>
    result._tag === "message" ? result.message : assert.fail("expected a message"),
  );

const latestDelivery = (app: App, memberId: GroupChatMemberId) =>
  Effect.map(app.store.deliveriesOfMember(memberId), (rows) => rows.at(-1) ?? null);

const awaitDelivery = (
  app: App,
  memberId: GroupChatMemberId,
  predicate: (d: DeliveryRow) => boolean,
) =>
  Effect.map(
    app.until(latestDelivery(app, memberId), (d) => d !== null && predicate(d)),
    (d) => d!,
  );

const awaitState = (app: App, memberId: GroupChatMemberId, state: DeliveryRow["state"]) =>
  awaitDelivery(app, memberId, (d) => d.state === state);

const reply = (fake: FakeThreads, threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const thread = yield* fake.thread(threadId);
    const run = thread.runs.find((candidate) => candidate.own && candidate.status === "running");
    assert.isDefined(run, `no running envelope on ${threadId}`);
    yield* fake.complete(threadId, run!.id, text);
  });

const messageTexts = (app: App, groupId: GroupChatGroupId) =>
  Effect.map(app.store.messages(groupId), (rows) => rows.map((m) => m.text));

it.layer(NodeServices.layer)("group chat service", (it) => {
  it.effect("a send to two idle threads creates one envelope each and both reach replied", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "Crew", [alpha, bravo]);
      yield* send(app, group.id, "hello both", [member(alpha).id, member(bravo).id]);
      yield* awaitState(app, member(alpha).id, "running");
      yield* awaitState(app, member(bravo).id, "running");
      yield* reply(fake, alpha, "hi from alpha");
      yield* reply(fake, bravo, "hi from bravo");
      const a = yield* awaitState(app, member(alpha).id, "replied");
      const b = yield* awaitState(app, member(bravo).id, "replied");
      assert.strictEqual(a.dispatch, "accepted");
      assert.strictEqual(b.attempt, 1);
      assert.strictEqual((yield* fake.sends(alpha)).length, 1);
      assert.match((yield* fake.sends(alpha))[0]!.text, /hello both/);
      assert.match(
        (yield* fake.sends(alpha))[0]!.text,
        /This is a group-chat turn\. Don't work your workflow steps unless the message asks\./,
      );
      assert.match(
        (yield* fake.sends(alpha))[0]!.text,
        /Reply to the group in plain text\. If your own workflow needs the operator, ask through your normal question tool\./,
      );
      assert.deepStrictEqual(yield* messageTexts(app, group.id), [
        "hello both",
        "hi from alpha",
        "hi from bravo",
      ]);
      assert.strictEqual((yield* app.store.member(member(alpha).id))!.seenSeq, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("a second envelope to a thread waits until the first one's run ends", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "Crew", [alpha]);
      const first = yield* send(app, group.id, "first", [member(alpha).id]);
      yield* awaitState(app, member(alpha).id, "running");
      yield* send(app, group.id, "second", [member(alpha).id]);
      const second = yield* awaitDelivery(
        app,
        member(alpha).id,
        (d) => d.wait?._tag === "lane_busy",
      );
      assert.strictEqual(second.state, "pending");
      assert.strictEqual((yield* fake.sends(alpha)).length, 1);
      yield* reply(fake, alpha, "one");
      yield* awaitDelivery(
        app,
        member(alpha).id,
        (d) => d.triggerMessageId !== first.id && d.state === "running",
      );
      assert.strictEqual((yield* fake.sends(alpha)).length, 2);
      const envelope = (yield* fake.sends(alpha))[1]!.text;
      assert.match(envelope, /\| second\n/);
      assert.notMatch(envelope, /\| first\n/, "what it saw is not repeated");
      assert.notMatch(envelope, /\| one\n/, "its own reply is not sent back");
    }).pipe(Effect.scoped),
  );

  it.effect("one thread in two groups gets its sends one at a time, in order", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const one = yield* createGroup(app, "one", [alpha]);
      const two = yield* createGroup(app, "two", [alpha]);
      yield* send(app, one.group.id, "from one", [one.member(alpha).id]);
      yield* send(app, two.group.id, "from two", [two.member(alpha).id]);
      yield* awaitState(app, one.member(alpha).id, "running");
      assert.strictEqual((yield* fake.sends(alpha)).length, 1);
      yield* reply(fake, alpha, "ok one");
      yield* awaitState(app, two.member(alpha).id, "running");
      yield* reply(fake, alpha, "ok two");
      yield* awaitState(app, two.member(alpha).id, "replied");
      assert.deepStrictEqual(
        (yield* fake.sends(alpha)).map((s) => (s.text.includes("from one") ? 1 : 2)),
        [1, 2],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a permanent rejection fails with no retry loop", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "Crew", [alpha]);
      (yield* fake.thread(alpha)).faults.push({
        type: "reject",
        reason: "Thread alpha is archived.",
      });
      yield* send(app, group.id, "hello", [member(alpha).id]);
      const failed = yield* awaitState(app, member(alpha).id, "failed");
      assert.strictEqual(failed.dispatch, "rejected");
      assert.strictEqual(failed.error, "Thread alpha is archived.");
      assert.strictEqual(failed.attempt, 1);
      assert.strictEqual((yield* fake.sends(alpha)).length, 1);
      assert.strictEqual((yield* app.store.member(member(alpha).id))!.seenSeq, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("an operator Retry after a failed run bumps the attempt and sends once", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "Crew", [alpha]);
      (yield* fake.thread(alpha)).faults.push({ type: "reject", reason: "refused" });
      yield* send(app, group.id, "hello", [member(alpha).id]);
      const failed = yield* awaitState(app, member(alpha).id, "failed");
      yield* app.dispatch({ _tag: "delivery.retry", deliveryId: failed.id });
      const running = yield* awaitState(app, member(alpha).id, "running");
      assert.strictEqual(running.attempt, 2);
      const sends = yield* fake.sends(alpha);
      assert.strictEqual(sends.length, 2);
      assert.notStrictEqual(sends[0]!.commandId, sends[1]!.commandId);
      assert.match(sends[1]!.commandId, /:2$/);
      assert.strictEqual(sends[0]!.text, sends[1]!.text);
      const refusedWhileRunning = yield* app
        .dispatch({ _tag: "delivery.retry", deliveryId: failed.id })
        .pipe(Effect.flip);
      assert.strictEqual(refusedWhileRunning._tag, "GroupChatRefused");
      yield* reply(fake, alpha, "done");
      yield* awaitState(app, member(alpha).id, "replied");
      const refusedAfterReply = yield* app
        .dispatch({ _tag: "delivery.retry", deliveryId: failed.id })
        .pipe(Effect.flip);
      assert.match((refusedAfterReply as { reason: string }).reason, /already got its reply/);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an in-flight dispatch finishes and is then followed, and a lost one is resent once",
    () =>
      Effect.gen(function* () {
        const { fake, app } = yield* setup;
        const { group, member } = yield* createGroup(app, "Crew", [alpha]);
        (yield* fake.thread(alpha)).faults.push({ type: "commit-silently" });
        yield* send(app, group.id, "first", [member(alpha).id]);
        yield* awaitState(app, member(alpha).id, "running");
        yield* reply(fake, alpha, "one");
        yield* awaitState(app, member(alpha).id, "replied");
        assert.strictEqual(
          (yield* fake.sends(alpha)).length,
          1,
          "found by its message id, never resent",
        );

        (yield* fake.thread(alpha)).faults.push({ type: "lose" });
        yield* send(app, group.id, "second", [member(alpha).id]);
        yield* awaitDelivery(app, member(alpha).id, (d) => d.state === "running");
        const sends = yield* fake.sends(alpha);
        assert.strictEqual(sends.length, 3);
        assert.strictEqual(sends[1]!.commandId, sends[2]!.commandId, "the resend reuses its ids");
        yield* reply(fake, alpha, "two");
        yield* awaitState(app, member(alpha).id, "replied");
        assert.strictEqual((yield* fake.thread(alpha)).runs.filter((r) => r.own).length, 2);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a send that is lost twice fails and a restart never sends it into an ended discussion",
    () =>
      Effect.gen(function* () {
        const { fake, baseDir, app } = yield* setup;
        const { group, member } = yield* createGroup(app, "probe", [alpha, bravo]);
        (yield* fake.thread(alpha)).faults.push({ type: "lose" }, { type: "lose" });
        const started = yield* app.dispatch({
          _tag: "discussion.start",
          groupId: group.id,
          participants: [member(alpha).id, member(bravo).id],
          topic: "topic",
          maxRounds: 2,
        });
        const discussion =
          started._tag === "discussion" ? started.discussion : assert.fail("discussion");
        const stalled = yield* awaitDelivery(
          app,
          member(alpha).id,
          (d) => d.dispatch === "unknown" && (d.error ?? "").includes("Retry sends it again"),
        );
        assert.strictEqual(stalled.state, "pending", "unknown stays unknown until Retry or a boot");
        assert.strictEqual(new Set((yield* fake.sends(alpha)).map((s) => s.commandId)).size, 1);
        assert.strictEqual(stalled.attempt, 1);
        yield* app.dispatch({ _tag: "discussion.stop", discussionId: discussion.id });
        const sendsAtStop = (yield* fake.sends(alpha)).length;
        yield* app.shutdown;

        const again = yield* boot(fake, baseDir);
        yield* again.until(again.store.delivery(stalled.id), (d) => d?.state === "cancelled");
        assert.strictEqual((yield* fake.sends(alpha)).length, sendsAtStop, "no send after Stop");
        assert.strictEqual((yield* fake.thread(alpha)).runs.length, 0, "T3 never ran it");
        assert.strictEqual(
          (yield* again.store.member(member(alpha).id))!.seenSeq,
          0,
          "the mark never moved",
        );
        assert.strictEqual((yield* again.store.discussion(discussion.id))!.state, "ended");
      }).pipe(Effect.scoped),
  );

  it.effect("an unrecorded outcome resolves at boot by the derived messageId and shows late", () =>
    Effect.gen(function* () {
      const { fake, baseDir, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "lost response", [alpha, bravo]);
      const gate = yield* Deferred.make<void>();
      const reached = yield* Deferred.make<void>();
      (yield* fake.thread(alpha)).sendGate = gate;
      (yield* fake.thread(alpha)).sendReached = reached;
      const started = yield* app.dispatch({
        _tag: "discussion.start",
        groupId: group.id,
        participants: [member(alpha).id, member(bravo).id],
        topic: "topic",
        maxRounds: 3,
      });
      const discussion =
        started._tag === "discussion" ? started.discussion : assert.fail("discussion");
      yield* Deferred.await(reached);
      assert.strictEqual((yield* latestDelivery(app, member(alpha).id))!.dispatch, "sending");
      assert.strictEqual((yield* fake.thread(alpha)).runs.length, 1, "T3 has the envelope");
      yield* app.dispatch({ _tag: "discussion.stop", discussionId: discussion.id });

      yield* app.shutdown;
      (yield* fake.thread(alpha)).sendGate = null;
      const booted = yield* boot(fake, baseDir);
      const found = yield* awaitDelivery(booted, member(alpha).id, (d) => d.state === "running");
      assert.strictEqual(found.dispatch, "accepted");
      assert.strictEqual(found.withdrawn, "discussion stopped");
      yield* reply(fake, alpha, "My view.\n[[SIGN-OFF]]");
      const replied = yield* awaitState(booted, member(alpha).id, "replied");
      const message = (yield* booted.store.message(replied.replyMessageId!))!;
      assert.isTrue(message.late);
      assert.isFalse(message.signOff);
      assert.deepStrictEqual((yield* booted.store.discussion(discussion.id))!.signedOff, {});
      assert.isAbove(
        (yield* booted.store.member(member(alpha).id))!.seenSeq,
        0,
        "accepted, so the mark moved",
      );
      assert.strictEqual((yield* fake.sends(alpha)).length, 1, "never resent");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "Stop during an in-flight dispatch lets it finish, and the accepted reply shows late",
    () =>
      Effect.gen(function* () {
        const { fake, app } = yield* setup;
        const { group, member } = yield* createGroup(app, "late accept", [alpha, bravo]);
        const gate = yield* Deferred.make<void>();
        (yield* fake.thread(alpha)).sendGate = gate;
        const started = yield* app.dispatch({
          _tag: "discussion.start",
          groupId: group.id,
          participants: [member(alpha).id, member(bravo).id],
          topic: "topic",
          maxRounds: 3,
        });
        const discussion =
          started._tag === "discussion" ? started.discussion : assert.fail("discussion");
        yield* awaitDelivery(app, member(alpha).id, (d) => d.dispatch === "sending");
        yield* app.dispatch({ _tag: "discussion.stop", discussionId: discussion.id });
        assert.strictEqual(
          (yield* latestDelivery(app, member(alpha).id))!.withdrawn,
          "discussion stopped",
        );
        (yield* fake.thread(alpha)).sendGate = null;
        yield* Deferred.succeed(gate, undefined);
        yield* awaitDelivery(
          app,
          member(alpha).id,
          (d) => d.dispatch === "accepted" && d.state === "running",
        );
        yield* reply(fake, alpha, "late answer");
        const replied = yield* awaitState(app, member(alpha).id, "replied");
        const message = (yield* app.store.message(replied.replyMessageId!))!;
        assert.strictEqual(message.text, "late answer");
        assert.isTrue(message.late);
        assert.strictEqual(
          (yield* app.store.discussion(discussion.id))!.endReason,
          "stopped by operator",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("Stop while the pre-send step runs sends nothing", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "slow read", [alpha, bravo]);
      const gate = yield* Deferred.make<void>();
      for (const id of [alpha, bravo]) (yield* fake.thread(id)).readGate = gate;
      const started = yield* app.dispatch({
        _tag: "discussion.start",
        groupId: group.id,
        participants: [member(alpha).id, member(bravo).id],
        topic: "t",
        maxRounds: 2,
      });
      const discussion =
        started._tag === "discussion" ? started.discussion : assert.fail("discussion");
      yield* awaitDelivery(app, member(alpha).id, (d) => d.wait === null && d.state === "pending");
      yield* app.dispatch({ _tag: "discussion.stop", discussionId: discussion.id });
      yield* Deferred.succeed(gate, undefined);
      yield* awaitState(app, member(alpha).id, "cancelled");
      yield* awaitState(app, member(bravo).id, "cancelled");
      assert.strictEqual((yield* fake.sends(alpha)).length, 0);
      assert.strictEqual((yield* fake.sends(bravo)).length, 0);
      for (const id of [alpha, bravo]) {
        const d = (yield* latestDelivery(app, member(id).id))!;
        assert.strictEqual(d.dispatch, "unsent");
        assert.strictEqual((yield* app.store.member(member(id).id))!.seenSeq, 0);
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a lost send that T3 queued is found in the queue, and the envelope waits busy_with_own_run",
    () =>
      Effect.gen(function* () {
        const { fake, app } = yield* setup;
        const { group, member } = yield* createGroup(app, "queued", [alpha]);
        const own = yield* fake.startOwnRun(alpha, "busy work");
        (yield* fake.thread(alpha)).faults.push({ type: "commit-silently" });
        yield* send(app, group.id, "hello", [member(alpha).id]);
        const queued = yield* awaitDelivery(
          app,
          member(alpha).id,
          (d) => d.dispatch === "accepted" && d.wait !== null,
        );
        assert.strictEqual(queued.state, "queued");
        assert.deepStrictEqual(queued.wait, { _tag: "busy_with_own_run", runId: own.id });
        assert.strictEqual((yield* fake.sends(alpha)).length, 1);
        assert.strictEqual(
          (yield* app.store.member(member(alpha).id))!.seenSeq,
          0,
          "queued: the mark waits",
        );
        yield* fake.complete(alpha, own.id, "OWN-TEXT");
        yield* awaitState(app, member(alpha).id, "running");
        assert.strictEqual(
          (yield* app.store.member(member(alpha).id))!.seenSeq,
          1,
          "started: the mark moves",
        );
        yield* reply(fake, alpha, "hi");
        yield* awaitState(app, member(alpha).id, "replied");
        assert.deepStrictEqual(yield* messageTexts(app, group.id), ["hello", "hi"]);
      }).pipe(Effect.scoped),
  );

  it.effect("a held queue shows queue_held until something releases it", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "held", [alpha]);
      yield* fake.hold(alpha, true);
      yield* send(app, group.id, "hello", [member(alpha).id]);
      const held = yield* awaitDelivery(
        app,
        member(alpha).id,
        (d) => d.wait?._tag === "queue_held",
      );
      assert.strictEqual(held.state, "queued");
      yield* fake.hold(alpha, false);
      yield* awaitState(app, member(alpha).id, "running");
      yield* reply(fake, alpha, "released");
      yield* awaitState(app, member(alpha).id, "replied");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "Stop cancels group chat's own queued envelope by run id and leaves the seen mark unmoved",
    () =>
      Effect.gen(function* () {
        const { fake, app } = yield* setup;
        const { group, member } = yield* createGroup(app, "cancel queued", [alpha]);
        const own = yield* fake.startOwnRun(alpha);
        yield* send(app, group.id, "hello", [member(alpha).id]);
        const queued = yield* awaitState(app, member(alpha).id, "queued");
        yield* app.dispatch({ _tag: "delivery.stop", deliveryId: queued.id });
        const cancelled = yield* awaitState(app, member(alpha).id, "cancelled");
        assert.strictEqual(cancelled.error, "stopped by operator");
        const run = (yield* fake.thread(alpha)).runs.find((r) => r.id === queued.runId)!;
        assert.strictEqual(run.status, "cancelled");
        assert.strictEqual((yield* app.store.member(member(alpha).id))!.seenSeq, 0);
        yield* fake.complete(alpha, own.id, "own");
        assert.strictEqual(
          (yield* fake.thread(alpha)).runs.filter((r) => r.own && r.started).length,
          0,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("an envelope removed from the T3 queue shows as removed", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "removed", [alpha]);
      yield* fake.startOwnRun(alpha);
      yield* send(app, group.id, "hello", [member(alpha).id]);
      const queued = yield* awaitState(app, member(alpha).id, "queued");
      yield* fake.removeQueued(alpha, queued.runId!);
      const cancelled = yield* awaitState(app, member(alpha).id, "cancelled");
      assert.strictEqual(cancelled.error, "removed from the thread's queue in T3");
      assert.strictEqual((yield* app.store.member(member(alpha).id))!.seenSeq, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("an envelope edited in T3 stores the text that ran", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "edited", [alpha]);
      const own = yield* fake.startOwnRun(alpha);
      yield* send(app, group.id, "hello", [member(alpha).id]);
      const queued = yield* awaitState(app, member(alpha).id, "queued");
      yield* fake.editQueued(alpha, queued.runId!, "EDITED IN T3");
      yield* fake.complete(alpha, own.id, "own");
      const running = yield* awaitState(app, member(alpha).id, "running");
      assert.strictEqual(running.runId, queued.runId, "the edit kept the run id");
      assert.strictEqual(running.sentText, "EDITED IN T3");
      assert.match(running.envelope, /hello/);
    }).pipe(Effect.scoped),
  );

  it.effect("a stopped envelope run pauses that member's lane until Retry", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "stopped", [alpha]);
      yield* send(app, group.id, "first", [member(alpha).id]);
      const first = yield* awaitState(app, member(alpha).id, "running");
      yield* send(app, group.id, "second", [member(alpha).id]);
      yield* awaitDelivery(app, member(alpha).id, (d) => d.wait?._tag === "lane_busy");
      yield* fake.interrupt(alpha, first.runId!);
      const paused = yield* awaitDelivery(
        app,
        member(alpha).id,
        (d) => d.wait?._tag === "stopped_in_t3",
      );
      assert.strictEqual(paused.state, "pending");
      assert.strictEqual((yield* fake.sends(alpha)).length, 1, "nothing goes out while paused");
      const stopped = yield* app.until(app.store.delivery(first.id), (d) => d?.state === "failed");
      assert.strictEqual(stopped!.error, "T3 run interrupted");
      assert.strictEqual(stopped!.wait?._tag, "stopped_in_t3");
      yield* app.dispatch({ _tag: "delivery.retry", deliveryId: paused.id });
      const running = yield* awaitDelivery(
        app,
        member(alpha).id,
        (d) => d.id === paused.id && d.state === "running",
      );
      assert.strictEqual(running.attempt, 1, "a paused envelope never left, so its attempt stays");
      assert.strictEqual((yield* fake.sends(alpha)).length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("a restart continuation is followed to the reply and never pauses the lane", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "restart", [alpha]);
      yield* send(app, group.id, "hello", [member(alpha).id]);
      const running = yield* awaitState(app, member(alpha).id, "running");
      const continuation = yield* fake.restart(alpha, running.runId!);
      yield* awaitDelivery(app, member(alpha).id, (d) => d.runId === continuation.id);
      yield* fake.complete(alpha, continuation.id, "after restart");
      const replied = yield* awaitState(app, member(alpha).id, "replied");
      assert.strictEqual(replied.runId, continuation.id);
      yield* send(app, group.id, "again", [member(alpha).id]);
      yield* awaitDelivery(
        app,
        member(alpha).id,
        (d) => d.triggerMessageId !== running.triggerMessageId && d.state === "running",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a member thread waiting on a question shows it; the operator's answer clears it and the reply lands",
    () =>
      Effect.gen(function* () {
        const { fake, app } = yield* setup;
        const { group, member } = yield* createGroup(app, "needs input", [alpha]);
        yield* send(app, group.id, "Is the plan ready?", [member(alpha).id]);
        yield* awaitState(app, member(alpha).id, "running");
        yield* fake.ask(alpha, "req-1", "Is the picnic goal met?", ["Yes, goal met", "No"]);
        const waiting = yield* awaitDelivery(
          app,
          member(alpha).id,
          (d) => d.wait?._tag === "waiting_on_question",
        );
        const wait = waiting.wait!;
        assert.strictEqual(wait._tag, "waiting_on_question");
        if (wait._tag === "waiting_on_question") {
          assert.strictEqual(wait.requestId, "req-1");
          assert.deepStrictEqual(
            wait.questions[0]!.options.map((o) => o.label),
            ["Yes, goal met", "No"],
          );
        }
        const wrong = yield* app
          .dispatch({
            _tag: "member.answer",
            memberId: member(alpha).id,
            requestId: "nope" as never,
            answers: {},
          })
          .pipe(Effect.flip);
        assert.strictEqual(wrong._tag, "GroupChatRefused");
        yield* app.dispatch({
          _tag: "member.answer",
          memberId: member(alpha).id,
          requestId: "req-1" as never,
          answers: { "Is the picnic goal met?": "Yes, goal met" },
        });
        yield* awaitDelivery(app, member(alpha).id, (d) => d.wait === null);
        assert.deepStrictEqual((yield* fake.thread(alpha)).responses, [
          {
            requestId: "req-1" as RuntimeRequestId,
            answers: { "Is the picnic goal met?": "Yes, goal met" },
          },
        ]);
        yield* reply(fake, alpha, "Plan is ready.");
        yield* awaitState(app, member(alpha).id, "replied");
        assert.strictEqual(
          (yield* fake.sends(alpha)).length,
          1,
          "the answer went to the question, not as another send",
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a turn the thread starts on its own holds the envelope back, its question can be answered, and its text is never the reply",
    () =>
      Effect.gen(function* () {
        const { fake, app } = yield* setup;
        const { group, member } = yield* createGroup(app, "own run", [alpha]);
        const own = yield* fake.startOwnRun(alpha, "Workflow idle check", { idlePing: true });
        yield* fake.ask(alpha, "idle-q", "Continue the workflow or stop it?", ["Continue", "Stop"]);
        yield* send(app, group.id, "Say hi", [member(alpha).id]);
        const queued = yield* awaitDelivery(
          app,
          member(alpha).id,
          (d) => d.wait?._tag === "waiting_on_question",
        );
        assert.strictEqual(queued.state, "queued");
        yield* app.dispatch({
          _tag: "member.answer",
          memberId: member(alpha).id,
          requestId: "idle-q" as never,
          answers: { "Continue the workflow or stop it?": "Stop" },
        });
        yield* awaitDelivery(app, member(alpha).id, (d) => d.wait?._tag === "busy_with_own_run");
        yield* fake.complete(alpha, own.id, "OWN-WORKFLOW-TEXT");
        yield* awaitState(app, member(alpha).id, "running");
        yield* reply(fake, alpha, "hi");
        yield* awaitState(app, member(alpha).id, "replied");
        assert.deepStrictEqual(yield* messageTexts(app, group.id), ["Say hi", "hi"]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a pending permission approval shows as waiting_on_approval and cannot be answered here",
    () =>
      Effect.gen(function* () {
        const { fake, app } = yield* setup;
        const { group, member } = yield* createGroup(app, "approval", [alpha]);
        yield* send(app, group.id, "Do the thing", [member(alpha).id]);
        yield* awaitState(app, member(alpha).id, "running");
        yield* fake.askApproval(alpha);
        yield* awaitDelivery(app, member(alpha).id, (d) => d.wait?._tag === "waiting_on_approval");
        const refused = yield* app
          .dispatch({
            _tag: "member.answer",
            memberId: member(alpha).id,
            requestId: "any" as never,
            answers: {},
          })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "GroupChatRefused");
      }).pipe(Effect.scoped),
  );

  it.effect("settling a member thread passes T3's refusal sentence through verbatim", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { member } = yield* createGroup(app, "settle", [alpha, bravo]);
      (yield* fake.thread(alpha)).settleRefusal =
        'has an open workflow "Open-ended" (w1, 3 of 3 steps open).';
      const refused = yield* app
        .dispatch({ _tag: "member.thread.settle", memberId: member(alpha).id })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "GroupChatThreadRefused");
      assert.strictEqual(
        (refused as { reason: string }).reason,
        'has an open workflow "Open-ended" (w1, 3 of 3 steps open).',
      );
      yield* app.dispatch({ _tag: "member.thread.settle", memberId: member(bravo).id });
      assert.isTrue((yield* fake.thread(bravo)).settled);
      yield* app.dispatch({ _tag: "member.thread.unsettle", memberId: member(bravo).id });
      assert.isFalse((yield* fake.thread(bravo)).settled);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a thread removed and added back keeps its member, mark and handle, and is never sent its own old replies",
    () =>
      Effect.gen(function* () {
        const { fake, app } = yield* setup;
        const { group, member } = yield* createGroup(app, "readd", [alpha, bravo]);
        yield* app.dispatch({ _tag: "member.rename", memberId: member(alpha).id, handle: "ace" });
        yield* send(app, group.id, "first to ace", [member(alpha).id]);
        yield* awaitState(app, member(alpha).id, "running");
        yield* reply(fake, alpha, "reply 1 from thread alpha");
        yield* awaitState(app, member(alpha).id, "replied");
        const mark = (yield* app.store.member(member(alpha).id))!.seenSeq;
        yield* app.dispatch({ _tag: "member.remove", memberId: member(alpha).id });
        yield* send(app, group.id, "while ace is away", [member(bravo).id]);
        yield* awaitState(app, member(bravo).id, "running");
        yield* reply(fake, bravo, "reply 1 from thread bravo");
        yield* awaitState(app, member(bravo).id, "replied");
        const back = yield* app.dispatch({
          _tag: "member.add",
          groupId: group.id,
          threadId: alpha,
        });
        const restored = back._tag === "member" ? back.member : assert.fail("member");
        assert.strictEqual(restored.id, member(alpha).id, "same member");
        assert.strictEqual(restored.handle, "ace");
        assert.strictEqual(restored.seenSeq, mark);
        assert.isTrue(restored.introduced);
        assert.deepStrictEqual(restored.handleHistory, ["alpha"]);
        yield* send(app, group.id, "welcome back", [member(alpha).id]);
        yield* awaitDelivery(
          app,
          member(alpha).id,
          (d) => d.state === "running" && d.envelope.includes("welcome back"),
        );
        const envelope = (yield* fake.sends(alpha)).at(-1)!.text;
        assert.notMatch(
          envelope,
          /reply 1 from thread alpha/,
          "its own old reply is not sent back",
        );
        assert.notMatch(envelope, /first to ace/, "what it saw is not repeated");
        assert.match(envelope, /while ace is away/);
        assert.match(envelope, /reply 1 from thread bravo/);
        assert.notMatch(envelope, /ABOUT THIS GROUP CHAT/, "no second intro");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a restart mid-round resumes without resending, and the round advances when the runs finish",
    () =>
      Effect.gen(function* () {
        const { fake, baseDir, app } = yield* setup;
        const { group, member } = yield* createGroup(app, "restart", [alpha, bravo]);
        const started = yield* app.dispatch({
          _tag: "discussion.start",
          groupId: group.id,
          participants: [member(alpha).id, member(bravo).id],
          topic: "t",
          maxRounds: 2,
        });
        const discussion =
          started._tag === "discussion" ? started.discussion : assert.fail("discussion");
        yield* awaitState(app, member(alpha).id, "running");
        yield* awaitState(app, member(bravo).id, "running");
        yield* app.shutdown;
        const again = yield* boot(fake, baseDir);
        for (const id of [alpha, bravo]) yield* reply(fake, id, `${id} round 1`);
        yield* again.until(again.store.discussion(discussion.id), (d) => d?.round === 2);
        yield* again.until(fake.sends(alpha), (sends) => sends.length === 2);
        yield* again.until(fake.sends(bravo), (sends) => sends.length === 2);
        const all = [...(yield* fake.sends(alpha)), ...(yield* fake.sends(bravo))];
        assert.strictEqual(new Set(all.map((s) => s.commandId)).size, 4, "round 1 never resent");
        assert.match((yield* fake.sends(alpha))[1]!.text, /bravo round 1/);
      }).pipe(Effect.scoped),
  );

  it.effect("every envelope tells the member how to ask the operator", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "envelope line", [alpha]);
      yield* send(app, group.id, "hello", [member(alpha).id]);
      yield* awaitState(app, member(alpha).id, "running");
      const text = (yield* fake.sends(alpha))[0]!.text;
      assert.include(
        text,
        "Reply to the group in plain text. If your own workflow needs the operator, ask through your normal question tool.",
      );
      assert.include(
        text,
        "This is a group-chat turn. Don't work your workflow steps unless the message asks.",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("the group page decorates deliveries with whether Retry would do anything", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "page", [alpha]);
      (yield* fake.thread(alpha)).faults.push({ type: "reject", reason: "no" });
      yield* send(app, group.id, "hello", [member(alpha).id]);
      yield* awaitState(app, member(alpha).id, "failed");
      const page = yield* app.engine.groupPage(group.id);
      assert.strictEqual(page.deliveries.length, 1);
      assert.isTrue(page.deliveries[0]!.retryable);
      assert.strictEqual(page.messages[0]!.displayText, "hello");
      const stream = yield* app.engine.snapshot;
      assert.strictEqual(stream.groups[0]!.id, group.id);
      assert.strictEqual(stream.members.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a send whose outcome stays unknown waits for Retry, which sends it as a new attempt",
    () =>
      Effect.gen(function* () {
        const { fake, app } = yield* setup;
        const { group, member } = yield* createGroup(app, "unknown", [alpha]);
        (yield* fake.thread(alpha)).faults.push({ type: "lose" }, { type: "lose" });
        yield* send(app, group.id, "hello", [member(alpha).id]);
        const stalled = yield* awaitDelivery(
          app,
          member(alpha).id,
          (d) => d.dispatch === "unknown" && (d.error ?? "").includes("Retry sends it again"),
        );
        assert.strictEqual(stalled.attempt, 1);
        assert.isTrue((yield* app.engine.groupPage(group.id)).deliveries[0]!.retryable);
        yield* app.dispatch({ _tag: "delivery.retry", deliveryId: stalled.id });
        const running = yield* awaitState(app, member(alpha).id, "running");
        assert.strictEqual(running.attempt, 2);
        const sends = yield* fake.sends(alpha);
        assert.strictEqual(sends.length, 3);
        assert.strictEqual(
          sends[0]!.commandId,
          sends[1]!.commandId,
          "the one resend reused its ids",
        );
        assert.match(sends[2]!.commandId, /:2$/);
      }).pipe(Effect.scoped),
  );

  it.effect("a stopped lane stays paused across a restart", () =>
    Effect.gen(function* () {
      const { fake, baseDir, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "paused", [alpha]);
      yield* send(app, group.id, "first", [member(alpha).id]);
      const first = yield* awaitState(app, member(alpha).id, "running");
      yield* send(app, group.id, "second", [member(alpha).id]);
      yield* awaitDelivery(app, member(alpha).id, (d) => d.wait?._tag === "lane_busy");
      yield* fake.interrupt(alpha, first.runId!);
      const paused = yield* awaitDelivery(
        app,
        member(alpha).id,
        (d) => d.wait?._tag === "stopped_in_t3",
      );
      yield* app.shutdown;
      const again = yield* boot(fake, baseDir);
      yield* again.until(again.store.delivery(first.id), (d) => d?.state === "failed");
      const stillPaused = yield* again.until(again.store.delivery(paused.id), (d) => d !== null);
      assert.strictEqual(stillPaused!.state, "pending");
      assert.strictEqual(stillPaused!.wait?._tag, "stopped_in_t3");
      assert.strictEqual((yield* fake.sends(alpha)).length, 1, "a restart releases nothing");
      yield* again.dispatch({ _tag: "delivery.retry", deliveryId: paused.id });
      yield* again.until(again.store.delivery(paused.id), (d) => d?.state === "running");
      assert.strictEqual((yield* fake.sends(alpha)).length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("an interrupted participant holds the discussion round open until Retry", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "held round", [alpha, bravo]);
      const started = yield* app.dispatch({
        _tag: "discussion.start",
        groupId: group.id,
        participants: [member(alpha).id, member(bravo).id],
        topic: "t",
        maxRounds: 2,
      });
      const discussion =
        started._tag === "discussion" ? started.discussion : assert.fail("discussion");
      yield* awaitState(app, member(alpha).id, "running");
      const b = yield* awaitState(app, member(bravo).id, "running");
      yield* reply(fake, alpha, "A-R1");
      yield* awaitState(app, member(alpha).id, "replied");
      yield* fake.interrupt(bravo, b.runId!);
      const stopped = yield* awaitState(app, member(bravo).id, "failed");
      assert.strictEqual(stopped.wait?._tag, "stopped_in_t3");
      const held = (yield* app.store.discussion(discussion.id))!;
      assert.strictEqual(held.round, 1, "the stopped participant holds the round");
      assert.strictEqual(held.state, "running");
      yield* app.dispatch({ _tag: "delivery.retry", deliveryId: stopped.id });
      yield* awaitDelivery(app, member(bravo).id, (d) => d.state === "running" && d.attempt === 2);
      yield* reply(fake, bravo, "B-R1");
      yield* app.until(app.store.discussion(discussion.id), (d) => d?.round === 2);
    }).pipe(Effect.scoped),
  );

  it.effect("a run that started and ended before the engine looked still moves the seen mark", () =>
    Effect.gen(function* () {
      const { fake, baseDir, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "unseen", [alpha]);
      const own = yield* fake.startOwnRun(alpha);
      yield* send(app, group.id, "hello", [member(alpha).id]);
      const queued = yield* awaitState(app, member(alpha).id, "queued");
      yield* app.shutdown;
      yield* fake.complete(alpha, own.id, "own");
      yield* fake.complete(alpha, queued.runId!, "while nobody looked");
      const again = yield* boot(fake, baseDir);
      const replied = yield* again.until(
        again.store.delivery(queued.id),
        (d) => d?.state === "replied",
      );
      assert.strictEqual(
        (yield* again.store.message(replied!.replyMessageId!))!.text,
        "while nobody looked",
      );
      const m = (yield* again.store.member(member(alpha).id))!;
      assert.strictEqual(m.seenSeq, 1);
      assert.isTrue(m.introduced);
    }).pipe(Effect.scoped),
  );

  it.effect("a completed run without a text reply fails and stays retryable", () =>
    Effect.gen(function* () {
      const { fake, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "no text", [alpha]);
      yield* send(app, group.id, "hello", [member(alpha).id]);
      const running = yield* awaitState(app, member(alpha).id, "running");
      yield* fake.complete(alpha, running.runId!, null);
      const failed = yield* awaitState(app, member(alpha).id, "failed");
      assert.strictEqual(failed.error, "the run ended without a text reply");
      assert.isTrue((yield* app.engine.groupPage(group.id)).deliveries[0]!.retryable);
      assert.deepStrictEqual(yield* messageTexts(app, group.id), ["hello"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a Stop whose cancel never reached T3 is cancelled again at the next boot", () =>
    Effect.gen(function* () {
      const { fake, baseDir, app } = yield* setup;
      const { group, member } = yield* createGroup(app, "cancel intent", [alpha]);
      yield* fake.startOwnRun(alpha);
      yield* send(app, group.id, "hello", [member(alpha).id]);
      const queued = yield* awaitState(app, member(alpha).id, "queued");
      (yield* fake.thread(alpha)).cancelFaults = 1;
      yield* app.dispatch({ _tag: "delivery.stop", deliveryId: queued.id });
      yield* awaitDelivery(app, member(alpha).id, (d) => d.withdrawn !== null);
      const run = (yield* fake.thread(alpha)).runs.find((r) => r.id === queued.runId)!;
      assert.strictEqual(run.status, "queued", "T3 still queues it");
      yield* app.shutdown;
      const again = yield* boot(fake, baseDir);
      yield* again.until(again.store.delivery(queued.id), (d) => d?.state === "cancelled");
      assert.strictEqual(run.status, "cancelled");
      assert.strictEqual((yield* again.store.member(member(alpha).id))!.seenSeq, 0);
    }).pipe(Effect.scoped),
  );
});

// The lane's retry pause is a real sleep, so this case runs on the live clock.
it.live("a read failure while following keeps the envelope and the lane", () =>
  Effect.gen(function* () {
    const { fake, app } = yield* setup;
    const { group, member } = yield* createGroup(app, "read fault", [alpha]);
    yield* send(app, group.id, "hello", [member(alpha).id]);
    const running = yield* awaitState(app, member(alpha).id, "running");
    (yield* fake.thread(alpha)).readFaults = 2;
    yield* fake.ask(alpha, "q", "still there?");
    yield* fake.complete(alpha, running.runId!, "back");
    const replied = yield* awaitState(app, member(alpha).id, "replied");
    assert.strictEqual(replied.attempt, 1);
    assert.strictEqual((yield* fake.sends(alpha)).length, 1);
    assert.strictEqual((yield* fake.thread(alpha)).readFaults, 0, "the lane looked again");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
