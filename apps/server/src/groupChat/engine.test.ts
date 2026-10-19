import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type GroupChatDiscussionId,
  type GroupChatGroupId,
  type GroupChatMemberId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DeliveryRow } from "./store.ts";
import {
  type App,
  boot,
  fakeAgent,
  type FakeThreads,
  makeFakeThreads,
  tempBaseDir,
} from "./testkit.ts";

const alpha = ThreadId.make("alpha");
const bravo = ThreadId.make("bravo");
const charlie = ThreadId.make("charlie");

const setup = (threads: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeThreads;
    const app = yield* boot(fake, yield* tempBaseDir);
    const created = yield* app.dispatch({
      _tag: "group.create",
      title: "Crew",
      threadIds: threads,
    });
    const group = created._tag === "group" ? created.group : assert.fail("group");
    const members = yield* app.store.members(group.id, true);
    const member = (threadId: ThreadId) =>
      members.find((m) => m.kind._tag === "t3" && m.kind.thread.threadId === threadId)!;
    return { fake, app, group, member };
  });

const send = (
  app: App,
  groupId: GroupChatGroupId,
  text: string,
  recipients: ReadonlyArray<GroupChatMemberId>,
) =>
  Effect.map(app.dispatch({ _tag: "message.send", groupId, text, recipients }), (result) =>
    result._tag === "message" ? result.message : assert.fail("message"),
  );

const startDiscussion = (
  app: App,
  groupId: GroupChatGroupId,
  participants: ReadonlyArray<GroupChatMemberId>,
  topic: string,
  maxRounds: number,
) =>
  Effect.map(
    app.dispatch({ _tag: "discussion.start", groupId, participants, topic, maxRounds }),
    (result) => (result._tag === "discussion" ? result.discussion : assert.fail("discussion")),
  );

const roundDeliveries = (app: App, discussionId: GroupChatDiscussionId, round: number) =>
  app.store.deliveriesOfRound(discussionId, round);

const answer = (
  app: App,
  fake: FakeThreads,
  threadId: ThreadId,
  memberId: GroupChatMemberId,
  text: string,
) =>
  Effect.gen(function* () {
    const running = yield* app.until(app.store.deliveriesOfMember(memberId), (rows) =>
      rows.some((d) => d.state === "running"),
    );
    const d = running.find((row) => row.state === "running")!;
    yield* fake.complete(threadId, d.runId!, text);
    yield* app.until(app.store.delivery(d.id), (row) => row?.state === "replied");
    return d;
  });

const sentEnvelope = (
  app: App,
  fake: FakeThreads,
  threadId: ThreadId,
  memberId: GroupChatMemberId,
) =>
  Effect.gen(function* () {
    yield* app.until(app.store.deliveriesOfMember(memberId), (rows) =>
      rows.some((d) => d.state === "running"),
    );
    return (yield* fake.sends(threadId)).at(-1)!.text;
  });

const texts = (app: App, groupId: GroupChatGroupId) =>
  Effect.map(app.store.messages(groupId), (rows) => rows.map((m) => m.text));

const states = (rows: ReadonlyArray<DeliveryRow>) => rows.map((d) => d.state);

it.layer(NodeServices.layer)("group chat engine rules", (it) => {
  it.effect(
    "catch-up envelopes carry everything after the mark except the member's own messages",
    () =>
      Effect.gen(function* () {
        const { fake, app, group, member } = yield* setup([alpha, bravo]);
        const a = member(alpha).id;
        const b = member(bravo).id;
        yield* send(app, group.id, "OP1 to A", [a]);
        yield* answer(app, fake, alpha, a, "A1");
        yield* send(app, group.id, "OP2 to A", [a]);
        yield* answer(app, fake, alpha, a, "A2");
        const m3 = yield* send(app, group.id, "OP3 to B", [b]);
        const toB = yield* sentEnvelope(app, fake, bravo, b);
        const order = ["OP1 to A", "A1", "OP2 to A", "A2", "OP3 to B"].map((t) => toB.indexOf(t));
        assert.isTrue(
          order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]!)),
          `order ${order}`,
        );
        assert.strictEqual((yield* app.store.member(b))!.seenSeq, m3.seq);
        yield* answer(app, fake, bravo, b, "B1");
        yield* send(app, group.id, "OP4 to A", [a]);
        const toA = yield* sentEnvelope(app, fake, alpha, a);
        assert.notInclude(toA, "OP1 to A", "A's envelope repeats what A saw");
        assert.notInclude(toA, "| A2", "A's own reply is not sent back");
        assert.include(toA, "OP3 to B");
        assert.include(toA, "B1");
      }).pipe(Effect.scoped),
  );

  it.effect("reserved and taken handles are refused on rename", () =>
    Effect.gen(function* () {
      const { app, member } = yield* setup([alpha, bravo]);
      const a = member(alpha).id;
      const rename = (handle: string) =>
        app.dispatch({ _tag: "member.rename", memberId: a, handle });
      assert.match((yield* rename("operator").pipe(Effect.flip)).message, /reserved/);
      assert.match((yield* rename("System").pipe(Effect.flip)).message, /reserved/);
      assert.match((yield* rename("bravo").pipe(Effect.flip)).message, /already used/);
      assert.match((yield* rename("way-too-long-for-a-handle").pipe(Effect.flip)).message, /1-16/);
      const renamed = yield* rename("ace");
      assert.strictEqual(renamed._tag === "member" ? renamed.member.handle : "", "ace");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "after a rename the member is told its new handle and keeps taking part in discussions",
    () =>
      Effect.gen(function* () {
        const { fake, app, group, member } = yield* setup([alpha, bravo]);
        const a = member(alpha).id;
        const b = member(bravo).id;
        yield* send(app, group.id, "hello both", [a, b]);
        yield* answer(app, fake, alpha, a, "@alpha: hi");
        yield* answer(app, fake, bravo, b, "@bravo: hi");
        const labelled = (yield* app.store.messages(group.id)).find(
          (m) => m.text === "@alpha: hi",
        )!;
        assert.strictEqual(labelled.displayText, "hi", "the self-label is stripped for display");
        yield* app.dispatch({ _tag: "member.rename", memberId: a, handle: "ace" });
        const discussion = yield* startDiscussion(app, group.id, [a, b], "pick", 2);
        const envA1 = yield* sentEnvelope(app, fake, alpha, a);
        const envB1 = yield* sentEnvelope(app, fake, bravo, b);
        assert.match(envA1, /You are @ace/);
        assert.match(envA1, /renamed you from @alpha to @ace/);
        assert.match(envB1, /@alpha is now @ace/);
        yield* answer(app, fake, alpha, a, "my pick");
        yield* answer(app, fake, bravo, b, "my pick");
        yield* app.until(app.store.discussion(discussion.id), (d) => d?.round === 2);
        const envA2 = yield* sentEnvelope(app, fake, alpha, a);
        const envB2 = yield* sentEnvelope(app, fake, bravo, b);
        assert.notInclude(envA2, "renamed you", "announced once");
        assert.match(envB2, /MESSAGE \d\/\d from @ace /);
      }).pipe(Effect.scoped),
  );

  it.effect("a message with nobody ticked is logged without deliveries", () =>
    Effect.gen(function* () {
      const { app, group } = yield* setup([alpha]);
      yield* send(app, group.id, "just a note", []);
      assert.deepStrictEqual(yield* texts(app, group.id), ["just a note"]);
      assert.deepStrictEqual(yield* app.store.deliveriesOfGroup(group.id), []);
    }).pipe(Effect.scoped),
  );

  it.effect("replies are ingested exactly once", () =>
    Effect.gen(function* () {
      const { fake, app, group, member } = yield* setup([alpha]);
      const a = member(alpha).id;
      yield* send(app, group.id, "hi", [a]);
      const d = yield* answer(app, fake, alpha, a, "one");
      const thread = yield* fake.thread(alpha);
      const run = thread.runs.find((r) => r.id === d.runId)!;
      run.reply = "two";
      yield* fake.complete(alpha, run.id, "two");
      assert.deepStrictEqual(yield* texts(app, group.id), ["hi", "one"]);
    }).pipe(Effect.scoped),
  );

  it.effect("discussions advance round by round and end when everyone signs off", () =>
    Effect.gen(function* () {
      const { fake, app, group, member } = yield* setup([alpha, bravo]);
      const a = member(alpha).id;
      const b = member(bravo).id;
      const discussion = yield* startDiscussion(app, group.id, [a, b], "pick one", 3);
      assert.strictEqual((yield* roundDeliveries(app, discussion.id, 1)).length, 2);
      yield* answer(app, fake, alpha, a, "I pick X");
      assert.strictEqual(
        (yield* app.store.discussion(discussion.id))!.round,
        1,
        "advances only when the whole round is in",
      );
      yield* answer(app, fake, bravo, b, "I pick Y");
      yield* app.until(app.store.discussion(discussion.id), (d) => d?.round === 2);
      assert.include(yield* sentEnvelope(app, fake, alpha, a), "I pick Y");
      assert.include(yield* sentEnvelope(app, fake, bravo, b), "I pick X");
      yield* answer(app, fake, alpha, a, "X it is\n[[SIGN-OFF]]");
      yield* answer(app, fake, bravo, b, "X it is\n[[SIGN-OFF]]");
      const ended = yield* app.until(
        app.store.discussion(discussion.id),
        (d) => d?.state === "ended",
      );
      assert.strictEqual(ended!.endReason, "all signed off in round 2");
      const signOffs = (yield* app.store.messages(group.id)).filter((m) => m.signOff);
      assert.strictEqual(signOffs.length, 2);
      assert.strictEqual(
        signOffs[0]!.displayText,
        "X it is",
        "the counted marker line is dropped for display",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "C8: a reply that mentions the marker mid-sentence does not sign off; outside a discussion it is plain text",
    () =>
      Effect.gen(function* () {
        const { fake, app, group, member } = yield* setup([alpha, bravo]);
        const a = member(alpha).id;
        const b = member(bravo).id;
        const discussion = yield* startDiscussion(app, group.id, [a, b], "pick", 2);
        yield* answer(app, fake, alpha, a, "I am not adding [[SIGN-OFF]] yet.");
        yield* answer(app, fake, bravo, b, "Fine with X.\n[[SIGN-OFF]]");
        const now = yield* app.until(app.store.discussion(discussion.id), (d) => d?.round === 2);
        assert.strictEqual(now!.state, "running");
        assert.deepStrictEqual(Object.keys(now!.signedOff), [b]);
        yield* app.dispatch({ _tag: "discussion.stop", discussionId: discussion.id });
        yield* app.until(app.store.discussion(discussion.id), (d) => d?.state === "ended");
        yield* send(app, group.id, "hi", [a]);
        yield* answer(app, fake, alpha, a, "ok\n[[SIGN-OFF]]");
        const plain = (yield* app.store.messages(group.id)).at(-1)!;
        assert.strictEqual(plain.text, "ok\n[[SIGN-OFF]]");
        assert.isFalse(plain.signOff);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "C9: an operator message mid-round never drops a reply from the next round's envelope",
    () =>
      Effect.gen(function* () {
        const { fake, app, group, member } = yield* setup([alpha, bravo]);
        const a = member(alpha).id;
        const b = member(bravo).id;
        const discussion = yield* startDiscussion(app, group.id, [a, b], "pick", 2);
        yield* sentEnvelope(app, fake, bravo, b);
        yield* answer(app, fake, alpha, a, "A-ROUND-1");
        yield* send(app, group.id, "note to B", [b]);
        yield* answer(app, fake, bravo, b, "B-ROUND-1");
        const noteEnvelope = yield* sentEnvelope(app, fake, bravo, b);
        assert.include(noteEnvelope, "A-ROUND-1");
        yield* answer(app, fake, bravo, b, "noted");
        yield* app.until(app.store.discussion(discussion.id), (d) => d?.round === 2);
        const toB = yield* sentEnvelope(app, fake, bravo, b);
        const toA = yield* sentEnvelope(app, fake, alpha, a);
        assert.include(toB, "| A-ROUND-1", "B's round-2 envelope carries A's round-1 reply again");
        assert.match(toB, /repeated for this round/);
        assert.include(toA, "| B-ROUND-1");
      }).pipe(Effect.scoped),
  );

  it.effect("C10 and C12: Stop is final, and nothing after the end counts", () =>
    Effect.gen(function* () {
      const { fake, app, group, member } = yield* setup([alpha, bravo]);
      const a = member(alpha).id;
      const b = member(bravo).id;
      yield* fake.startOwnRun(bravo, "busy");
      const discussion = yield* startDiscussion(app, group.id, [a, b], "pick", 3);
      yield* sentEnvelope(app, fake, alpha, a);
      yield* app.until(app.store.deliveriesOfMember(b), (rows) => rows[0]?.state === "queued");
      yield* app.dispatch({ _tag: "discussion.stop", discussionId: discussion.id });
      const bRow = yield* app.until(
        app.store.deliveriesOfMember(b),
        (rows) => rows[0]?.state === "cancelled",
      );
      assert.strictEqual(bRow[0]!.error, "discussion stopped");
      assert.match(
        (yield* app.store.messages(group.id)).at(-1)!.text,
        /1 reply was already in progress/,
      );
      const late = yield* answer(app, fake, alpha, a, "Late.\n[[SIGN-OFF]]");
      const lateMessage = (yield* app.store.message(
        (yield* app.store.delivery(late.id))!.replyMessageId!,
      ))!;
      assert.isTrue(lateMessage.late, "the late reply lands");
      assert.isFalse(lateMessage.signOff);
      const after = (yield* app.store.discussion(discussion.id))!;
      assert.strictEqual(after.state, "ended");
      assert.strictEqual(after.endReason, "stopped by operator");
      assert.deepStrictEqual(after.signedOff, {});
      assert.deepStrictEqual(yield* roundDeliveries(app, discussion.id, 2), []);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "C15: an envelope cancelled by Stop never moves the mark; the next real envelope carries what was missed",
    () =>
      Effect.gen(function* () {
        const { fake, app, group, member } = yield* setup([alpha, bravo]);
        const a = member(alpha).id;
        const b = member(bravo).id;
        const discussion = yield* startDiscussion(app, group.id, [a, b], "pick", 3);
        yield* answer(app, fake, alpha, a, "A-R1");
        yield* answer(app, fake, bravo, b, "B-R1");
        yield* app.until(app.store.discussion(discussion.id), (d) => d?.round === 2);
        yield* fake.startOwnRun(alpha, "busy");
        const markBefore = (yield* app.store.member(a))!.seenSeq;
        yield* app.until(roundDeliveries(app, discussion.id, 2), (rows) => rows.length === 2);
        yield* app.dispatch({ _tag: "discussion.stop", discussionId: discussion.id });
        yield* app.until(roundDeliveries(app, discussion.id, 2), (rows) =>
          states(rows).every((s) => s === "cancelled" || s === "running"),
        );
        assert.strictEqual(
          (yield* app.store.member(a))!.seenSeq,
          markBefore,
          "mark unchanged by the cancelled envelope",
        );
        const busy = (yield* fake.thread(alpha)).runs.find(
          (r) => !r.own && r.status === "running",
        )!;
        yield* fake.complete(alpha, busy.id, "own");
        yield* send(app, group.id, "what did B say?", [a]);
        const env = yield* sentEnvelope(app, fake, alpha, a);
        assert.include(env, "| B-R1", "B's round-1 reply is still delivered");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "C13: removing every participant ends the discussion; removing a waiting one lets the round finish",
    () =>
      Effect.gen(function* () {
        {
          const { app, group, member } = yield* setup([alpha, bravo]);
          const discussion = yield* startDiscussion(
            app,
            group.id,
            [member(alpha).id, member(bravo).id],
            "t",
            3,
          );
          yield* app.dispatch({ _tag: "member.remove", memberId: member(alpha).id });
          yield* app.dispatch({ _tag: "member.remove", memberId: member(bravo).id });
          const end = yield* app.until(
            app.store.discussion(discussion.id),
            (d) => d?.state === "ended",
          );
          assert.match(end!.endReason!, /participants left/);
        }
        {
          const { fake, app, group, member } = yield* setup([alpha, bravo, charlie]);
          const a = member(alpha).id;
          const b = member(bravo).id;
          const c = member(charlie).id;
          const discussion = yield* startDiscussion(app, group.id, [a, b, c], "t", 2);
          yield* sentEnvelope(app, fake, charlie, c);
          yield* answer(app, fake, alpha, a, "A");
          yield* answer(app, fake, bravo, b, "B");
          assert.strictEqual(
            (yield* app.store.discussion(discussion.id))!.round,
            1,
            "held by charlie",
          );
          yield* app.dispatch({ _tag: "member.remove", memberId: c });
          yield* app.until(app.store.discussion(discussion.id), (d) => d?.round === 2);
          assert.strictEqual((yield* roundDeliveries(app, discussion.id, 2)).length, 2);
          const stale = (yield* fake.thread(charlie)).runs.find((r) => r.own)!;
          yield* fake.complete(charlie, stale.id, "late\n[[SIGN-OFF]]");
          const row = yield* app.until(
            app.store.deliveriesOfMember(c),
            (rows) => rows[0]?.state === "replied",
          );
          const message = (yield* app.store.message(row[0]!.replyMessageId!))!;
          assert.isFalse(message.signOff, "a removed member's late reply never counts");
          assert.isTrue(message.late);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "C14: a huge reply is stored whole, and the next round's section keeps its head and tail",
    () =>
      Effect.gen(function* () {
        const { fake, app, group, member } = yield* setup([alpha, bravo]);
        const a = member(alpha).id;
        const b = member(bravo).id;
        const discussion = yield* startDiscussion(app, group.id, [a, b], "lighthouses", 2);
        const big = `BOUNDARY-HEAD-513\n${"boundary fill ".repeat(3500)}\nBOUNDARY-TAIL-991`;
        assert.isAbove(big.length, 49_000);
        yield* answer(app, fake, alpha, a, "short one");
        const stored = yield* answer(app, fake, bravo, b, big);
        assert.strictEqual(
          (yield* app.store.message((yield* app.store.delivery(stored.id))!.replyMessageId!))!.text,
          big,
        );
        yield* app.until(app.store.discussion(discussion.id), (d) => d?.round === 2);
        const env = yield* sentEnvelope(app, fake, alpha, a);
        const start = env.indexOf("from @bravo");
        const section = env.slice(start, env.indexOf(" END ", start));
        assert.include(section, "| BOUNDARY-HEAD-513", "head kept");
        assert.include(section, "| BOUNDARY-TAIL-991", "tail kept");
        assert.match(
          section,
          /\[shortened by the group-chat app: \d+ of \d+ characters left out here; the start and the end are shown\]/,
        );
        assert.isBelow(section.length, 6_500, `section is bounded (${section.length})`);
      }).pipe(Effect.scoped),
  );
});

const externalConfig = (url: string, secret = "") => ({
  url,
  headers: {},
  bodyTemplate: "",
  replyPath: "",
  secret,
  callbackOrigin: "",
});

const addExternal = (
  app: App,
  groupId: GroupChatGroupId,
  handle: string,
  kind: "rest" | "webhook",
  url: string,
) =>
  Effect.map(
    app.dispatch({
      _tag: "member.addExternal",
      groupId,
      handle,
      kind,
      config: externalConfig(url),
    }),
    (result) => (result._tag === "member" ? result.member : assert.fail("member")),
  );

const deliveryOf = (
  app: App,
  memberId: GroupChatMemberId,
  predicate: (d: DeliveryRow) => boolean,
) =>
  Effect.map(
    app.until(app.store.deliveriesOfMember(memberId), (rows) => rows.some(predicate)),
    (rows) => rows.find(predicate)!,
  );

it.layer(NodeServices.layer)("group chat engine, external members", (it) => {
  it.effect("reserved handles are refused on external members", () =>
    Effect.gen(function* () {
      const { app, group } = yield* setup([alpha]);
      const add = (handle: string) =>
        app.dispatch({
          _tag: "member.addExternal",
          groupId: group.id,
          handle,
          kind: "rest",
          config: externalConfig("http://127.0.0.1:1/x"),
        });
      assert.match((yield* add("operator").pipe(Effect.flip)).message, /reserved/);
      assert.match((yield* add("System").pipe(Effect.flip)).message, /reserved/);
      const derived = yield* add("");
      assert.strictEqual(derived._tag === "member" ? derived.member.handle : "", "rest");
      assert.match(
        yield* add("ok").pipe(
          Effect.map(() => ""),
          Effect.catch((e) => Effect.succeed(e.message)),
        ),
        /^$/,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a callback origin is a bare http(s) origin", () =>
    Effect.gen(function* () {
      const { app, group } = yield* setup([alpha]);
      const add = (callbackOrigin: string) =>
        app.dispatch({
          _tag: "member.addExternal",
          groupId: group.id,
          handle: "",
          kind: "webhook",
          config: { ...externalConfig("http://127.0.0.1:1/x"), callbackOrigin },
        });
      for (const bad of [
        "https://agent.example?base=1",
        "https://agent.example/hooks",
        "https://agent.example/#x",
        "agent.example",
      ]) {
        assert.match((yield* add(bad).pipe(Effect.flip)).message, /origin/, bad);
      }
      const added = yield* add("https://agent.example/");
      const member = added._tag === "member" ? added.member : assert.fail("member");
      assert.strictEqual(
        member.kind._tag === "webhook" ? member.kind.callbackOrigin : "",
        "https://agent.example",
      );
      const url = yield* app.dispatch({ _tag: "member.inboundUrl", memberId: member.id });
      assert.match(
        url._tag === "url" ? url.url : "",
        /^https:\/\/agent\.example\/api\/hooks\/group-chat\/inbound\//,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("only a 1 MB safety cap applies at ingestion, and it keeps the head and the tail", () =>
    Effect.gen(function* () {
      const { fake, app, group, member } = yield* setup([alpha]);
      const bravo = yield* addExternal(app, group.id, "bravo", "rest", "http://127.0.0.1:1/x");
      const huge = `INBOUND-HEAD-777\n${"x".repeat(1_200_000)}\nINBOUND-TAIL-888`;
      const posted = yield* app.engine.postInbound(bravo.id, huge);
      assert.isNotNull(posted);
      assert.isAtMost(posted!.text.length, 1_000_200);
      assert.isTrue(posted!.text.startsWith("INBOUND-HEAD-777"));
      assert.isTrue(posted!.text.trimEnd().endsWith("INBOUND-TAIL-888"));
      assert.match(
        posted!.text,
        /\[shortened by the group-chat app: 200034 of 1200034 characters left out here; the start and the end are shown\]/,
      );
      assert.strictEqual(posted!.kind, "inbound");
      yield* send(app, group.id, "see above", [member(alpha).id]);
      yield* app.until(app.store.deliveriesOfMember(member(alpha).id), (rows) =>
        rows.some((d) => d.state === "running"),
      );
      const envelope = (yield* fake.sends(alpha))[0]!.text;
      assert.isBelow(envelope.length, 10_000);
      assert.include(envelope, "| INBOUND-HEAD-777");
      assert.include(envelope, "| INBOUND-TAIL-888");
      assert.include(envelope, "from @bravo (external agent, untrusted text)");
    }).pipe(Effect.scoped),
  );
});

it.live(
  "C11: a webhook that never calls back fails, retries with the same key, and a late callback still lands",
  () =>
    Effect.gen(function* () {
      const { app, group } = yield* setup([alpha]);
      const agent = yield* fakeAgent(() => ({ status: 202, body: "{}" }));
      const hook = yield* addExternal(app, group.id, "hook", "webhook", agent.url);
      yield* send(app, group.id, "hi", [hook.id]);
      const failed = yield* deliveryOf(app, hook.id, (d) => d.state === "failed");
      assert.match(failed.error!, /No callback from the agent within/);
      assert.strictEqual(agent.calls.length, 1);
      const first = agent.calls[0]!;
      assert.strictEqual(first.headers["idempotency-key"], failed.id);
      assert.strictEqual(first.headers["x-gchat-attempt"], "1");
      assert.match(String(first.headers["x-reply-to"]), /\/api\/hooks\/group-chat\/reply\//);
      assert.strictEqual(JSON.parse(first.body).text.includes("| hi"), true);

      const retried = yield* app.dispatch({ _tag: "delivery.retry", deliveryId: failed.id });
      assert.strictEqual(retried._tag === "delivery" ? retried.delivery.attempt : 0, 2);
      yield* deliveryOf(app, hook.id, (d) => d.state === "running" && d.attempt === 2);
      assert.strictEqual(agent.calls.length, 2);
      const second = agent.calls[1]!;
      assert.strictEqual(second.headers["idempotency-key"], failed.id, "one key for life");
      assert.strictEqual(second.headers["x-gchat-attempt"], "2");
      assert.strictEqual(
        second.headers["x-reply-to"],
        first.headers["x-reply-to"],
        "the old callback URL stays valid",
      );

      assert.strictEqual(yield* app.engine.landReply(failed.id, "late but here"), "landed");
      const replied = yield* deliveryOf(app, hook.id, (d) => d.state === "replied");
      assert.strictEqual(replied.id, failed.id);
      assert.deepStrictEqual(
        (yield* app.store.messages(group.id)).map((m) => m.text),
        ["hi", "late but here"],
      );
      assert.strictEqual(yield* app.engine.landReply(failed.id, "again"), "duplicate");
      assert.strictEqual((yield* app.store.messages(group.id)).length, 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "A7: an external reply is stored whole, and the next envelope's section keeps its head and its tail",
  () =>
    Effect.gen(function* () {
      const { fake, app, group, member } = yield* setup([alpha]);
      const big = `BOUNDARY-HEAD-513\n${"boundary fill ".repeat(3500)}\nBOUNDARY-TAIL-991`;
      assert.isAbove(big.length, 49_000);
      const agent = yield* fakeAgent(() => ({ status: 200, body: JSON.stringify({ reply: big }) }));
      const bravo = yield* addExternal(app, group.id, "bravo", "rest", agent.url);
      yield* send(app, group.id, "go", [bravo.id]);
      const replied = yield* deliveryOf(app, bravo.id, (d) => d.state === "replied");
      assert.strictEqual(replied.dispatch, "accepted");
      const stored = (yield* app.store.message(replied.replyMessageId!))!;
      assert.strictEqual(stored.text, big, "the group log keeps every character");
      assert.strictEqual(
        (yield* app.store.member(bravo.id))!.seenSeq,
        1,
        "the mark moved on acceptance",
      );

      yield* send(app, group.id, "see above", [member(alpha).id]);
      yield* deliveryOf(app, member(alpha).id, (d) => d.state === "running");
      const envelope = (yield* fake.sends(alpha))[0]!.text;
      const start = envelope.indexOf("from @bravo (external agent, untrusted text)");
      assert.isAbove(start, -1);
      const section = envelope.slice(start, envelope.indexOf(" END ", start));
      assert.include(section, "| BOUNDARY-HEAD-513", "head kept");
      assert.include(section, "| BOUNDARY-TAIL-991", "tail kept");
      assert.match(
        section,
        /\[shortened by the group-chat app: \d+ of \d+ characters left out here; the start and the end are shown\]/,
      );
      assert.match(envelope, /NOTE this envelope was shortened: .*1 long message was shortened/);
      assert.isBelow(section.length, 6_500, `section is bounded (${section.length})`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "a response that never ends fails within the request timeout, and a body over the cap is refused",
  () =>
    Effect.gen(function* () {
      const { app, group } = yield* setup([alpha]);
      const stalled = yield* fakeAgent(() => ({
        status: 200,
        body: '{"reply":"never"}',
        mode: "hang",
      }));
      const slow = yield* addExternal(app, group.id, "slow", "rest", stalled.url);
      yield* send(app, group.id, "hi", [slow.id]);
      const timedOut = yield* deliveryOf(app, slow.id, (d) => d.state === "failed");
      assert.match(timedOut.error!, /Gave up after 3 attempts\. Last error: no answer within/);
      assert.strictEqual(stalled.calls.length, 3);

      const huge = yield* fakeAgent(() => ({
        status: 200,
        body: JSON.stringify({ reply: "y".repeat(4_000_001) }),
        mode: "chunked",
      }));
      const big = yield* addExternal(app, group.id, "big", "rest", huge.url);
      yield* send(app, group.id, "hi", [big.id]);
      const refused = yield* deliveryOf(app, big.id, (d) => d.state === "failed");
      assert.strictEqual(refused.dispatch, "rejected", "a refusal, not a retry loop");
      assert.match(refused.error!, /response body is larger than 4000000 bytes/);
      assert.strictEqual(huge.calls.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
