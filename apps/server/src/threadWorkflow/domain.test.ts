import {
  ThreadWorkflowChangeRecord,
  ThreadWorkflowRecord,
  type ThreadWorkflowErrorCode,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  admits,
  emptyState,
  evolve,
  fold,
  lifecycleBlocker,
  markCorrupt,
  toSubscriptionView,
  toView,
  type DecideContext,
  type ThreadWorkflowState,
} from "./domain.ts";
import { agent, apply, given, started, threadId, user } from "./testkit.ts";

const decodeRecord = Schema.decodeUnknownSync(ThreadWorkflowRecord);

type Actor = typeof user | typeof agent;
type Setup = ReadonlyArray<readonly [Actor, unknown, Partial<DecideContext>?]>;
type Expected = "changed" | "unchanged" | "replayed" | ThreadWorkflowErrorCode;

interface Row {
  readonly name: string;
  readonly setup: Setup;
  readonly actor: Actor;
  readonly request: unknown;
  readonly context?: Partial<DecideContext>;
  readonly expect: Expected;
  /** Text the refusal must print, typed as the agent would type it. */
  readonly mentions?: ReadonlyArray<string>;
  /** Text the refusal must not print. */
  readonly omits?: ReadonlyArray<string>;
}

/** `null` sends no comment. */
const tick = (stepId: string, comment: string | null = "did it") => ({
  _tag: "tick",
  stepId,
  ...(comment === null ? {} : { comment }),
});
const skip = (stepId: string) => ({ _tag: "skip", stepId, reason: "not needed" });
const remove = (stepId: string) => ({ _tag: "remove", stepId, reason: "wrong step" });
const reopen = (target: string) => ({ _tag: "reopen", target, reason: "intent changed" });
const close = (instanceId: string, outcome: "finished" | "abandoned") => ({
  _tag: "close",
  instanceId,
  outcome,
  reason: "done here",
});
const insert = (fields: Record<string, unknown> = {}) => ({
  _tag: "insert",
  step: { title: "Extra", instructions: "Do more.", proofLevel: "none", waitsForUser: false },
  reason: "found more work",
  ...fields,
});
const start = { _tag: "start", templateId: "checklist" };
const userStarted = [started] as Setup;
const allResolved: Setup = [
  started,
  [user, tick("w1.1")],
  [user, tick("w1.2")],
  [user, skip("w1.3")],
];
const closedFinished: Setup = [...allResolved, [user, close("w1", "finished")]];
const closedAbandoned: Setup = [started, [user, close("w1", "abandoned")]];

const outcomeOf = (applied: ReturnType<typeof apply>): Expected => {
  const { decision } = applied;
  if (decision._tag === "ThreadWorkflowError") return decision.code;
  if (decision._tag === "unchanged") return decision.replayed ? "replayed" : "unchanged";
  return "changed";
};

const rows: ReadonlyArray<Row> = [
  // start
  {
    name: "start with no open instance",
    setup: [],
    actor: agent,
    request: start,
    expect: "changed",
  },
  {
    name: "start on a settled or archived thread",
    setup: [],
    actor: user,
    request: start,
    context: { threadActive: false },
    expect: "thread_not_active",
  },
  {
    name: "start with the flag off",
    setup: [],
    actor: user,
    request: start,
    context: { enabled: false },
    expect: "disabled",
  },
  {
    name: "start while another instance is open",
    setup: userStarted,
    actor: agent,
    request: { ...start, title: "Second" },
    expect: "instance_open",
    mentions: [
      'thread_workflow_close {"instanceId":"w1","outcome":"finished","reason":"<why it is done>"}',
      'thread_workflow_close {"instanceId":"w1","outcome":"abandoned","reason":"<what changed>"}',
    ],
  },
  {
    name: "a retried start without a request id returns the open instance",
    setup: userStarted,
    actor: user,
    request: start,
    expect: "unchanged",
  },
  {
    name: "start an unknown template",
    setup: [],
    actor: user,
    request: { _tag: "start", templateId: "nope" },
    expect: "unknown_template",
    mentions: ['"checklist"'],
  },
  // tick
  {
    name: "tick an open step",
    setup: userStarted,
    actor: agent,
    request: tick("w1.1"),
    expect: "changed",
  },
  {
    name: "tick a skipped step",
    setup: [...userStarted, [user, skip("w1.1")]],
    actor: agent,
    request: tick("w1.1"),
    expect: "changed",
  },
  {
    name: "tick a done step converges",
    setup: [...userStarted, [user, tick("w1.1")]],
    actor: agent,
    request: tick("w1.1", "again"),
    expect: "unchanged",
  },
  {
    name: "tick a removed step",
    setup: [...userStarted, [user, remove("w1.1")]],
    actor: agent,
    request: tick("w1.1"),
    expect: "invalid_transition",
    mentions: ['thread_workflow_change {"action":"reopen","target":"w1.1","reason":"<why>"}'],
  },
  {
    name: "an agent tick without a comment",
    setup: userStarted,
    actor: agent,
    request: tick("w1.1", null),
    expect: "comment_required",
    mentions: [
      'thread_workflow_tick {"stepId":"w1.1","comment":"<what you did and how you know it worked>","proof":"<the commit SHA>"}',
    ],
  },
  {
    name: "a user tick without a comment",
    setup: userStarted,
    actor: user,
    request: tick("w1.1", null),
    expect: "changed",
  },
  {
    name: "an agent tick of a required-proof step without proof",
    setup: userStarted,
    actor: agent,
    request: tick("w1.1"),
    expect: "changed",
  },
  {
    name: "tick on a closed instance",
    setup: closedAbandoned,
    actor: agent,
    request: tick("w1.1"),
    expect: "instance_closed",
    mentions: ['thread_workflow_change {"action":"reopen","target":"w1","reason":"<why>"}'],
  },
  {
    name: "tick an unknown step",
    setup: userStarted,
    actor: agent,
    request: tick("w1.9"),
    expect: "unknown_step",
    mentions: ["thread_workflow_get {}"],
  },
  {
    name: "tick with the flag off still works",
    setup: userStarted,
    actor: agent,
    request: tick("w1.1"),
    context: { enabled: false, threadActive: false },
    expect: "changed",
  },
  // skip
  {
    name: "skip an open step",
    setup: userStarted,
    actor: agent,
    request: skip("w1.1"),
    expect: "changed",
  },
  {
    name: "skip a skipped step converges",
    setup: [...userStarted, [user, skip("w1.1")]],
    actor: agent,
    request: skip("w1.1"),
    expect: "unchanged",
  },
  {
    name: "skip a done step",
    setup: [...userStarted, [user, tick("w1.1")]],
    actor: agent,
    request: skip("w1.1"),
    expect: "invalid_transition",
    mentions: [
      "ticked by the user",
      'thread_workflow_change {"action":"reopen","target":"w1.1","reason":"<why>"}',
    ],
  },
  {
    name: "skip a removed step",
    setup: [...userStarted, [user, remove("w1.1")]],
    actor: agent,
    request: skip("w1.1"),
    expect: "invalid_transition",
  },
  // insert
  {
    name: "insert at the end of the open instance",
    setup: userStarted,
    actor: agent,
    request: insert(),
    expect: "changed",
  },
  {
    name: "insert after a step",
    setup: userStarted,
    actor: agent,
    request: insert({ afterStepId: "w1.1" }),
    expect: "changed",
  },
  {
    name: "insert into a closed instance",
    setup: closedAbandoned,
    actor: agent,
    request: insert({ instanceId: "w1" }),
    expect: "instance_closed",
  },
  {
    name: "insert with no open instance",
    setup: [],
    actor: agent,
    request: insert(),
    expect: "no_open_instance",
    mentions: ['thread_workflow_start {"templateId":"open-ended"}'],
  },
  {
    name: "insert after an unknown step",
    setup: userStarted,
    actor: agent,
    request: insert({ afterStepId: "w1.9" }),
    expect: "unknown_step",
  },
  {
    name: "insert a ninth step",
    setup: [...userStarted, ...Array.from({ length: 5 }, () => [agent, insert()] as const)],
    actor: agent,
    request: insert(),
    expect: "too_many_steps",
    mentions: ['thread_workflow_change {"action":"comment","target":"w1.1"'],
  },
  {
    name: "the user inserting a ninth step reads a plain refusal",
    setup: [...userStarted, ...Array.from({ length: 5 }, () => [agent, insert()] as const)],
    actor: user,
    request: insert(),
    expect: "too_many_steps",
    mentions: ["This workflow already has 8 stages. Combine two, or skip or remove one"],
    omits: ["thread_workflow"],
  },
  {
    name: "insert once a skipped step has left the plan",
    setup: [
      ...userStarted,
      ...Array.from({ length: 5 }, () => [agent, insert()] as const),
      [user, skip("w1.1")],
    ],
    actor: agent,
    request: insert(),
    expect: "changed",
  },
  // remove
  {
    name: "remove an open step",
    setup: userStarted,
    actor: agent,
    request: remove("w1.1"),
    expect: "changed",
  },
  {
    name: "remove a skipped step",
    setup: [...userStarted, [user, skip("w1.1")]],
    actor: agent,
    request: remove("w1.1"),
    expect: "changed",
  },
  {
    name: "remove a removed step converges",
    setup: [...userStarted, [user, remove("w1.1")]],
    actor: agent,
    request: remove("w1.1"),
    expect: "unchanged",
  },
  {
    name: "remove a done step",
    setup: [...userStarted, [user, tick("w1.1")]],
    actor: agent,
    request: remove("w1.1"),
    expect: "invalid_transition",
  },
  // reopen step
  ...(["tick", "skip", "remove"] as const).map((how): Row => ({
    name: `reopen a step after ${how}`,
    setup: [
      ...userStarted,
      [user, how === "tick" ? tick("w1.1") : how === "skip" ? skip("w1.1") : remove("w1.1")],
    ],
    actor: agent,
    request: reopen("w1.1"),
    expect: "changed",
  })),
  {
    name: "reopen an open step converges",
    setup: userStarted,
    actor: agent,
    request: reopen("w1.1"),
    expect: "unchanged",
  },
  {
    name: "reopen a step of a closed instance",
    setup: closedAbandoned,
    actor: agent,
    request: reopen("w1.1"),
    expect: "instance_closed",
  },
  // reopen instance
  {
    name: "reopen a closed instance",
    setup: closedFinished,
    actor: agent,
    request: reopen("w1"),
    expect: "changed",
  },
  {
    name: "reopen an open instance converges",
    setup: userStarted,
    actor: agent,
    request: reopen("w1"),
    expect: "unchanged",
  },
  {
    name: "reopen a closed instance while another is open",
    setup: [...closedAbandoned, [user, start]],
    actor: user,
    request: reopen("w1"),
    expect: "instance_open",
    mentions: [
      'thread_workflow_close {"instanceId":"w2","outcome":"abandoned","reason":"<what changed>"}',
    ],
  },
  {
    name: "reopen an instance with the flag off",
    setup: closedAbandoned,
    actor: user,
    request: reopen("w1"),
    context: { enabled: false },
    expect: "disabled",
  },
  {
    name: "reopen an instance on a settled thread",
    setup: closedAbandoned,
    actor: user,
    request: reopen("w1"),
    context: { threadActive: false },
    expect: "thread_not_active",
  },
  // comment
  {
    name: "comment on a step",
    setup: userStarted,
    actor: agent,
    request: { _tag: "comment", target: "w1.2", comment: "waiting on the user" },
    expect: "changed",
  },
  {
    name: "comment on a closed instance",
    setup: closedAbandoned,
    actor: agent,
    request: { _tag: "comment", target: "w1", comment: "for the record" },
    expect: "changed",
  },
  {
    name: "comment on an unknown step",
    setup: userStarted,
    actor: agent,
    request: { _tag: "comment", target: "w1.7", comment: "?" },
    expect: "unknown_step",
  },
  // close
  {
    name: "close finished with open steps",
    setup: [...userStarted, [user, tick("w1.1")]],
    actor: agent,
    request: close("w1", "finished"),
    expect: "steps_unresolved",
    mentions: [
      'thread_workflow_change {"action":"skip","stepId":"w1.2","reason":"<why>"}',
      'thread_workflow_change {"action":"skip","stepId":"w1.3","reason":"<why>"}',
      'thread_workflow_close {"instanceId":"w1","outcome":"abandoned","reason":"<what changed>"}',
    ],
  },
  {
    name: "close finished with every step resolved",
    setup: allResolved,
    actor: agent,
    request: close("w1", "finished"),
    expect: "changed",
  },
  {
    name: "close abandoned with open steps",
    setup: userStarted,
    actor: agent,
    request: close("w1", "abandoned"),
    expect: "changed",
  },
  {
    name: "close again with the same outcome converges",
    setup: closedFinished,
    actor: agent,
    request: close("w1", "finished"),
    expect: "unchanged",
  },
  {
    name: "close again with a different outcome",
    setup: closedFinished,
    actor: agent,
    request: close("w1", "abandoned"),
    expect: "invalid_transition",
  },
  {
    name: "close an unknown instance",
    setup: [],
    actor: agent,
    request: close("w3", "abandoned"),
    expect: "unknown_instance",
  },
  // recover
  {
    name: "recover by the agent",
    setup: [],
    actor: agent,
    request: { _tag: "recover", reason: "fix it" },
    expect: "user_only",
  },
  {
    name: "recover a readable log",
    setup: [],
    actor: user,
    request: { _tag: "recover", reason: "fix it" },
    expect: "not_corrupt",
  },
  // pane concurrency
  {
    name: "a stale expected revision",
    setup: userStarted,
    actor: user,
    request: skip("w1.1"),
    context: { expectedRevision: 0 },
    expect: "revision_conflict",
  },
  {
    name: "a current expected revision",
    setup: userStarted,
    actor: user,
    request: skip("w1.1"),
    context: { expectedRevision: 1 },
    expect: "changed",
  },
];

describe("decide", () => {
  it.each(rows)("$name -> $expect", (row) => {
    const { state } = given(...row.setup);
    const applied = apply(state, row.actor, row.request, row.context);
    expect(outcomeOf(applied)).toBe(row.expect);
    if (row.mentions !== undefined && applied.decision._tag === "ThreadWorkflowError") {
      for (const text of row.mentions) expect(applied.decision.message).toContain(text);
    }
    if (row.omits !== undefined && applied.decision._tag === "ThreadWorkflowError") {
      for (const text of row.omits) expect(applied.decision.message).not.toContain(text);
    }
  });

  it("refuses everything but the user's recover on a corrupt log", () => {
    const corrupt = markCorrupt(given(started).state, "line 2 of its log is not JSON");
    for (const input of [tick("w1.1"), close("w1", "abandoned"), start]) {
      expect(outcomeOf(apply(corrupt, user, input))).toBe("corrupt");
    }
    expect(outcomeOf(apply(corrupt, agent, { _tag: "recover", reason: "x" }))).toBe("user_only");
    expect(outcomeOf(apply(corrupt, user, { _tag: "recover", reason: "log broke" }))).toBe(
      "changed",
    );
  });
});

describe("request ids", () => {
  it("replays the same request and refuses a different one under the same id", () => {
    const { state } = given([user, start, { requestId: "r1" }]);
    expect(outcomeOf(apply(state, user, start, { requestId: "r1" }))).toBe("replayed");
    expect(outcomeOf(apply(state, user, { ...start, title: "Other" }, { requestId: "r1" }))).toBe(
      "request_id_reused",
    );
  });

  it("records a receipt for a no-op so a late retry does not act on later state", () => {
    const first = given(started, [user, tick("w1.1")]);
    const noop = apply(first.state, agent, tick("w1.1"), { requestId: "late" });
    expect(outcomeOf(noop)).toBe("unchanged");
    expect(noop.record?.kind).toBe("receipt");

    const reopened = apply(noop.state, user, reopen("w1.1")).state;
    const retry = apply(reopened, agent, tick("w1.1"), { requestId: "late" });
    expect(outcomeOf(retry)).toBe("replayed");
    expect(toView(retry.state).instances[0]?.steps[0]?.state._tag).toBe("open");
  });

  it("does not count a receipt as workflow activity", () => {
    const first = given(started, [user, tick("w1.1")]);
    const noop = apply(first.state, agent, tick("w1.1"), { requestId: "late" });
    expect(noop.state.lastSeq).toBe(first.state.lastSeq + 1);
    expect(noop.state.revision).toBe(first.state.revision);
    expect(noop.state.lastActivityAt).toBe(first.state.lastActivityAt);
  });

  it("writes nothing for a no-op without a request id", () => {
    const first = given(started, [user, tick("w1.1")]);
    expect(apply(first.state, agent, tick("w1.1")).record).toBeNull();
  });
});

describe("records", () => {
  const decodeChange = Schema.decodeUnknownExit(ThreadWorkflowChangeRecord);
  const base = {
    v: 1,
    seq: 2,
    at: "2026-10-17T12:00:00.000Z",
    kind: "change",
    requestId: null,
    inputDigest: "0".repeat(64),
  };
  const tickEvent = { _tag: "ticked", stepId: "w1.1", comment: null, proof: null };

  it("cannot decode an agent tick without a comment", () => {
    expect(Exit.isFailure(decodeChange({ ...base, by: agent, event: tickEvent }))).toBe(true);
    expect(Exit.isSuccess(decodeChange({ ...base, by: user, event: tickEvent }))).toBe(true);
  });

  it("cannot decode an agent recovery", () => {
    const event = { _tag: "recovered", reason: "x", corruption: "y", nextInstanceNumber: 2 };
    expect(Exit.isFailure(decodeChange({ ...base, by: agent, event }))).toBe(true);
    expect(Exit.isSuccess(decodeChange({ ...base, by: user, event }))).toBe(true);
  });

  it("cannot decode a skip without a reason", () => {
    const event = { _tag: "skipped", stepId: "w1.1", reason: " " };
    expect(Exit.isFailure(decodeChange({ ...base, by: user, event }))).toBe(true);
  });

  it("round-trips every record the domain writes", () => {
    const { records } = given(
      started,
      [agent, tick("w1.1")],
      [agent, insert({ afterStepId: "w1.1" })],
      [agent, tick("w1.1"), { requestId: "receipt" }],
      [user, close("w1", "abandoned")],
    );
    const codec = Schema.fromJsonString(ThreadWorkflowRecord);
    for (const record of records) {
      expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(record))).toEqual(record);
    }
  });
});

describe("evolve", () => {
  const view = (state: ThreadWorkflowState) => toView(state);

  it("assigns instance and step ids from the event", () => {
    const { state } = given(started);
    const instance = view(state).instances[0];
    expect(view(state).activeInstanceId).toBe("w1");
    expect(instance?.steps.map((step) => step.id)).toEqual(["w1.1", "w1.2", "w1.3"]);
    expect(instance?.currentStepId).toBe("w1.1");
  });

  it("stamps a tick with the agent and moves the current step", () => {
    const { state } = given(started, [agent, { ...tick("w1.1", "wrote it"), proof: "abc123" }]);
    const instance = view(state).instances[0];
    expect(instance?.steps[0]?.state).toEqual({
      _tag: "done",
      stamp: { seq: 2, at: "2026-10-17T12:00:01.000Z", by: agent },
      comment: "wrote it",
      proof: "abc123",
    });
    expect(instance?.currentStepId).toBe("w1.2");
    expect(instance?.steps[0]?.history).toHaveLength(1);
  });

  it("places inserted steps and never reuses a step number", () => {
    const { state } = given(
      started,
      [agent, remove("w1.3")],
      [agent, insert({ afterStepId: "w1.1" })],
      [agent, insert({ afterStepId: null })],
      [agent, insert()],
    );
    const steps = view(state).instances[0]?.steps ?? [];
    expect(steps.map((step) => step.id)).toEqual(["w1.5", "w1.1", "w1.4", "w1.2", "w1.3", "w1.6"]);
    expect(steps[0]?.origin).toMatchObject({ _tag: "inserted", reason: "found more work" });
  });

  it("derives the active instance from the one open instance", () => {
    const closed = given(...closedFinished).state;
    expect(view(closed).activeInstanceId).toBeNull();
    const second = apply(closed, user, start).state;
    expect(view(second).activeInstanceId).toBe("w2");
    const reopened = given(...closedFinished, [user, reopen("w1")]).state;
    expect(view(reopened).activeInstanceId).toBe("w1");
    expect(
      view(reopened).instances[0]?.history.map(
        (record) => record.kind === "change" && record.event._tag,
      ),
    ).toEqual(["started", "closed", "reopened"]);
  });

  it("starts a fresh log on recovery with ids clear of the old ones", () => {
    const corrupt = markCorrupt(given(started).state, "line 2 of its log is not JSON", 7);
    const recovered = apply(corrupt, user, { _tag: "recover", reason: "log broke" });
    expect(recovered.record?.seq).toBe(1);
    expect(view(recovered.state)).toMatchObject({ corruption: null, instances: [], revision: 1 });
    const next = apply(recovered.state, user, start).state;
    expect(view(next).activeInstanceId).toBe("w7");
  });

  it("folds a log to the same state as applying it record by record", () => {
    const { state, records } = given(
      started,
      [agent, tick("w1.1")],
      [agent, skip("w1.2")],
      [agent, insert({ afterStepId: "w1.2" })],
      [user, tick("w1.4", null)],
      [agent, tick("w1.4"), { requestId: "noop" }],
      [user, { _tag: "comment", target: "w1", comment: "nearly there" }],
      [user, skip("w1.3")],
      [agent, close("w1", "finished")],
      [user, start],
    );
    const folded = fold(threadId, records);
    expect(folded).toEqual(state);
    expect(toView(folded)).toEqual(toView(state));
  });

  it("leaves history out of the subscription view", () => {
    const { state } = given(started, [agent, tick("w1.1")]);
    const instance = toSubscriptionView(state).instances[0];
    expect(instance).not.toHaveProperty("history");
    expect(instance?.steps[0]).not.toHaveProperty("history");
    expect(instance?.steps[0]?.state._tag).toBe("done");
  });
});

describe("lifecycleBlocker", () => {
  it("allows a thread with no open instance", () => {
    expect(lifecycleBlocker(given().state, "settle")).toBeNull();
    expect(lifecycleBlocker(given(...closedFinished).state, "delete")).toBeNull();
  });

  it("names both close calls and where the user can do it", () => {
    const message = lifecycleBlocker(given(started, [agent, tick("w1.1")]).state, "settle");
    expect(message).toContain('"Checklist" (w1, 2 of 3 steps open), so it cannot settle');
    expect(message).toContain(
      'thread_workflow_close {"instanceId":"w1","outcome":"finished","reason":"<why it is done>"}',
    );
    expect(message).toContain(
      'thread_workflow_close {"instanceId":"w1","outcome":"abandoned","reason":"<what changed>"}',
    );
    expect(message).toContain("from the Workflow tab on web or desktop, or ask the agent");
  });

  it("phrases each action", () => {
    const { state } = given(started);
    expect(lifecycleBlocker(state, "archive")).toContain("cannot be archived");
    expect(lifecycleBlocker(state, "delete")).toContain("cannot be deleted");
  });

  it("never blocks a corrupt thread, even one whose readable prefix has an open instance", () => {
    const corrupt = markCorrupt(given(started).state, "line 2 of its log is not JSON");
    for (const action of ["settle", "archive", "delete"] as const) {
      expect(lifecycleBlocker(corrupt, action)).toBeNull();
    }
  });
});

describe("admits", () => {
  const legal = given(
    started,
    [agent, tick("w1.1")],
    [agent, skip("w1.2")],
    [agent, insert({ afterStepId: "w1.2" })],
    [agent, tick("w1.4"), { requestId: "noop" }],
    [user, { _tag: "comment", target: "w1", comment: "nearly there" }],
    [user, skip("w1.3")],
    [agent, close("w1", "finished")],
    [user, start],
    [user, close("w2", "abandoned")],
    [user, reopen("w1")],
  );
  const startRecord = legal.records[0] as ThreadWorkflowChangeRecord;
  const startEvent = startRecord.event as Extract<
    ThreadWorkflowChangeRecord["event"],
    { readonly _tag: "started" }
  >;
  const open = given(started).state;
  /** The start record's envelope around another event, decoded so the ids carry their brands. */
  const at = (seq: number, event: unknown, requestId: string | null = null) =>
    decodeRecord({ ...startRecord, seq, requestId, event });

  it("admits every record decide wrote, in order", () => {
    let state = emptyState(threadId);
    for (const record of legal.records) {
      expect(admits(state, record)).toBeNull();
      state = evolve(state, record);
    }
  });

  it("refuses a second start with an existing instance id", () => {
    expect(admits(open, at(2, startEvent))).toBe("starts w1, which already exists");
  });

  it("refuses a start while another instance is open", () => {
    const second = {
      ...startEvent,
      instanceId: "w2",
      steps: startEvent.steps.map((step) => ({ ...step, id: step.id.replace("w1.", "w2.") })),
    };
    expect(admits(open, at(2, second))).toBe("starts w2 while w1 is open");
  });

  it("refuses changes to steps and instances that do not exist", () => {
    expect(admits(open, at(2, { _tag: "ticked", stepId: "w1.9", comment: "x", proof: null }))).toBe(
      "changes w1.9, which does not exist",
    );
    const closeW3 = { _tag: "closed", instanceId: "w3", outcome: "abandoned", reason: "x" };
    expect(admits(open, at(2, closeW3))).toBe("closes w3, which does not exist");
  });

  it("refuses transitions decide never writes", () => {
    const finish = { _tag: "closed", instanceId: "w1", outcome: "finished", reason: "x" };
    const closed = given(started, [user, close("w1", "abandoned")]).state;
    expect(admits(closed, at(3, finish))).toBe("closes w1, which is already closed");
    expect(admits(open, at(2, finish))).toBe("finishes w1 with w1.1, w1.2, w1.3 open");
    const ticked = given(started, [agent, tick("w1.1")]).state;
    expect(admits(ticked, at(3, { _tag: "skipped", stepId: "w1.1", reason: "x" }))).toBe(
      "moves w1.1 from done to skipped",
    );
    const secondOpen = given(started, [user, close("w1", "abandoned")], [user, start]).state;
    expect(admits(secondOpen, at(4, { _tag: "reopened", target: "w1", reason: "x" }))).toBe(
      "reopens w1 while w2 is open",
    );
  });

  it("refuses a request id the log already answered", () => {
    const { state } = given(started, [agent, tick("w1.1"), { requestId: "r1" }]);
    const skipped = { _tag: "skipped", stepId: "w1.2", reason: "x" };
    expect(admits(state, at(3, skipped, "r1"))).toBe('reuses request id "r1"');
  });
});
