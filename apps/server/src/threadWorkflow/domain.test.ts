import {
  THREAD_WORKFLOW_LIMITS,
  ThreadWorkflowChangeRecord,
  ThreadWorkflowRecord,
  type ThreadWorkflowErrorCode,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  admits,
  attentionOf,
  emptyState,
  evolve,
  fold,
  instanceActedOn,
  lifecycleBlocker,
  markCorrupt,
  openQuestions,
  slugFor,
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
const ask = (fields: Record<string, unknown> = {}) => ({
  _tag: "ask",
  title: "Merge without a second review?",
  summary: "Yes (recommended) · No, wait for Sam",
  ...fields,
});
const answer = (questionId: string, fields: Record<string, unknown> = {}) => ({
  _tag: "answer",
  questionId,
  answer: "Yes",
  ...fields,
});
const withdraw = (questionId: string) => ({
  _tag: "withdraw",
  questionId,
  reason: "Sam already reviewed it",
});
const start = { _tag: "start", templateId: "checklist" };
const planned = (...titles: ReadonlyArray<string>) => ({
  ...start,
  steps: titles.map((title) => ({
    title,
    instructions: `Do ${title}.`,
    proofLevel: "none",
    waitsForUser: false,
  })),
});
const userStarted = [started] as Setup;
const allResolved: Setup = [
  started,
  [user, tick("w1.1")],
  [user, tick("w1.2")],
  [user, skip("w1.3")],
];
const closedFinished: Setup = [...allResolved, [user, close("w1", "finished")]];
const closedAbandoned: Setup = [started, [user, close("w1", "abandoned")]];
const asked: Setup = [started, [agent, ask()]];
const answered: Setup = [...asked, [user, answer("w1.q1")]];
const withdrawn: Setup = [...asked, [agent, withdraw("w1.q1")]];

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
  {
    name: "start with a plan the cap holds",
    setup: [],
    actor: agent,
    request: planned("a", "b", "c", "d", "e"),
    expect: "changed",
  },
  {
    name: "start with a plan past the cap",
    setup: [],
    actor: agent,
    request: planned("a", "b", "c", "d", "e", "f"),
    expect: "too_many_steps",
  },
  {
    name: "a retried plan start without a request id returns the instance it started",
    setup: [[agent, planned("a")]],
    actor: agent,
    request: planned("a"),
    expect: "unchanged",
  },
  {
    name: "a plan start against a workflow started without that plan",
    setup: userStarted,
    actor: agent,
    request: planned("a"),
    expect: "instance_open",
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
    mentions: ["This workflow already has 8 open stages. Finish, combine, skip or remove one"],
    omits: ["thread_workflow"],
  },
  {
    name: "insert a ninth step once a step is done, because done steps leave the cap",
    setup: [
      ...userStarted,
      ...Array.from({ length: 5 }, () => [agent, insert()] as const),
      [agent, { _tag: "tick", stepId: "w1.1", comment: "done" }],
    ],
    actor: agent,
    request: insert(),
    expect: "changed",
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
    name: "reopen a done step while 8 steps are open",
    setup: [
      ...userStarted,
      ...Array.from({ length: 5 }, () => [agent, insert()] as const),
      [agent, { _tag: "tick", stepId: "w1.1", comment: "done" }],
      [agent, insert()],
    ],
    actor: user,
    request: reopen("w1.1"),
    expect: "too_many_steps",
    mentions: ["8 open stages"],
  },
  {
    name: "the agent reopening a done step while 8 steps are open reads the skip call",
    setup: [
      ...userStarted,
      ...Array.from({ length: 5 }, () => [agent, insert()] as const),
      [agent, { _tag: "tick", stepId: "w1.1", comment: "done" }],
      [agent, insert()],
    ],
    actor: agent,
    request: reopen("w1.1"),
    expect: "too_many_steps",
    mentions: ['"action":"skip"'],
  },
  {
    name: "reopen a done step while 7 steps are open",
    setup: [
      ...userStarted,
      ...Array.from({ length: 5 }, () => [agent, insert()] as const),
      [agent, { _tag: "tick", stepId: "w1.1", comment: "done" }],
    ],
    actor: user,
    request: reopen("w1.1"),
    expect: "changed",
  },
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
  {
    name: "ask with no open instance",
    setup: closedAbandoned,
    actor: agent,
    request: ask(),
    expect: "no_open_instance",
    mentions: ["thread_workflow_start"],
  },
  { name: "ask by the agent", setup: userStarted, actor: agent, request: ask(), expect: "changed" },
  {
    name: "ask blocking a step of the open instance",
    setup: userStarted,
    actor: agent,
    request: ask({ blocksStepId: "w1.2" }),
    expect: "changed",
  },
  {
    name: "ask blocking a step that does not exist",
    setup: userStarted,
    actor: agent,
    request: ask({ blocksStepId: "w1.9" }),
    expect: "unknown_step",
  },
  {
    name: "answer from the pane",
    setup: asked,
    actor: user,
    request: answer("w1.q1"),
    expect: "changed",
  },
  {
    name: "answer recorded from chat",
    setup: asked,
    actor: agent,
    request: answer("w1.q1", { source: "chat" }),
    expect: "changed",
  },
  {
    name: "answer a question that does not exist",
    setup: asked,
    actor: user,
    request: answer("w1.q2"),
    expect: "unknown_question",
    mentions: ["thread_workflow_get {}"],
  },
  {
    name: "answer an answered question",
    setup: answered,
    actor: agent,
    request: answer("w1.q1"),
    expect: "question_closed",
    mentions: [
      "in the Workflow tab by the user",
      '"Yes"',
      'thread_workflow_change {"action":"reopen","target":"w1.q1","reason":"<why>"}',
    ],
  },
  {
    name: "answer on a closed workflow",
    setup: [...asked, [user, close("w1", "abandoned")]],
    actor: user,
    request: answer("w1.q1"),
    expect: "changed",
  },
  { name: "withdraw", setup: asked, actor: agent, request: withdraw("w1.q1"), expect: "changed" },
  {
    name: "withdraw a withdrawn question",
    setup: withdrawn,
    actor: agent,
    request: withdraw("w1.q1"),
    expect: "question_closed",
    mentions: ["withdrawn by the agent"],
  },
  {
    name: "reopen an answered question by the agent",
    setup: answered,
    actor: agent,
    request: reopen("w1.q1"),
    expect: "user_only",
    mentions: ["thread_workflow_ask"],
  },
  {
    name: "reopen an answered question by the user",
    setup: answered,
    actor: user,
    request: reopen("w1.q1"),
    expect: "changed",
  },
  {
    name: "reopen a withdrawn question by the user",
    setup: withdrawn,
    actor: user,
    request: reopen("w1.q1"),
    expect: "changed",
  },
  {
    name: "reopen an open question",
    setup: asked,
    actor: user,
    request: reopen("w1.q1"),
    expect: "unchanged",
  },
  {
    name: "reopen a question that does not exist",
    setup: asked,
    actor: user,
    request: reopen("w1.q3"),
    expect: "unknown_question",
  },
  {
    name: "comment on a question",
    setup: asked,
    actor: agent,
    request: { _tag: "comment", target: "w1.q1", comment: "Sam is back Monday" },
    expect: "changed",
  },
  {
    name: "comment on a question that does not exist",
    setup: asked,
    actor: agent,
    request: { _tag: "comment", target: "w1.q2", comment: "x" },
    expect: "unknown_question",
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

  it("starts a planned instance with the plan before the template's steps, in one record", () => {
    const { state, records } = given([agent, planned("Scope", "Build")]);
    expect(records).toHaveLength(1);
    expect(
      state.instances[0]!.instance.steps.map((step) => [step.id, step.title, step.origin._tag]),
    ).toEqual([
      ["w1.1", "Scope", "template"],
      ["w1.2", "Build", "template"],
      ["w1.3", "Write it", "template"],
      ["w1.4", "Ask the user", "template"],
      ["w1.5", "Ship it", "template"],
    ]);
    expect(admits(emptyState(threadId), records[0]!)).toBeNull();
    expect(outcomeOf(apply(state, agent, planned("Other"), { requestId: null }))).toBe(
      "instance_open",
    );
  });

  it("binds a request id to its plan", () => {
    const { state } = given([agent, planned("Scope"), { requestId: "r1" }]);
    expect(outcomeOf(apply(state, agent, planned("Scope"), { requestId: "r1" }))).toBe("replayed");
    expect(outcomeOf(apply(state, agent, planned("Other"), { requestId: "r1" }))).toBe(
      "request_id_reused",
    );
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

describe("slugs", () => {
  const slugsOf = (state: ThreadWorkflowState) =>
    toView(state).instances[0]?.steps.map((step) => step.slug) ?? [];

  it.each([
    ["Open the PR!", "open-the-pr"],
    ["  Design   the data shape  ", "design-the-data-shape"],
    ["Rebase, commit & push (again)", "rebase-commit-push-again"],
    [
      "Verify on the matching surface before the reviewer sees it",
      "verify-on-the-matching-surface-before",
    ],
    ["x".repeat(60), "x".repeat(40)],
    ["!!! ???", "step"],
    ["", "step"],
  ])("derives %j as %j", (title, slug) => {
    expect(slugFor(title)).toBe(slug);
  });

  it("puts a slug on every started step, in the event, unique within the instance", () => {
    const { state, records } = given([agent, planned("Build", "Build", "build", "Write it")]);
    expect(slugsOf(state)).toEqual([
      "build",
      "build-2",
      "build-3",
      "write-it",
      "write-it-2",
      "ask-the-user",
      "ship-it",
    ]);
    const event = records[0]!.kind === "change" ? records[0]!.event : null;
    expect(event?._tag === "started" && event.steps.map((step) => step.slug)).toEqual(
      slugsOf(state),
    );
  });

  it("keeps a given slug and still makes it unique", () => {
    const { state } = given([
      agent,
      {
        ...planned("Scope"),
        steps: [
          {
            title: "Scope",
            slug: "ship-it",
            instructions: "x",
            proofLevel: "none",
            waitsForUser: false,
          },
        ],
      },
    ]);
    expect(slugsOf(state)).toEqual(["ship-it", "write-it", "ask-the-user", "ship-it-2"]);
  });

  it("gives an inserted step a slug clear of the instance's, and keeps it within the limit", () => {
    const long = "v".repeat(THREAD_WORKFLOW_LIMITS.slug);
    const { state, records } = given(
      started,
      [agent, insert({ step: { ...insert().step, title: "Write it" } })],
      [agent, insert({ step: { ...insert().step, title: long } })],
      [agent, insert({ step: { ...insert().step, title: long } })],
    );
    expect(slugsOf(state)).toEqual([
      "write-it",
      "ask-the-user",
      "ship-it",
      "write-it-2",
      long,
      `${"v".repeat(38)}-2`,
    ]);
    const inserted = records.at(-1)!;
    expect(
      inserted.kind === "change" && inserted.event._tag === "inserted" && inserted.event.step.slug,
    ).toBe(`${"v".repeat(38)}-2`);
  });

  it("folds a record written before steps had slugs with derived ones", () => {
    const { records } = given(started, [agent, insert({ afterStepId: "w1.1" })]);
    const legacy = records.map((record) =>
      decodeRecord(
        JSON.parse(
          JSON.stringify(record, (key, value: unknown) => (key === "slug" ? undefined : value)),
        ),
      ),
    );
    const folded = fold(threadId, legacy);
    expect(slugsOf(folded)).toEqual(["write-it", "extra", "ask-the-user", "ship-it"]);
    expect(admits(emptyState(threadId), legacy[0]!)).toBeNull();
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

describe("questions", () => {
  const questionsOf = (state: ThreadWorkflowState) => toView(state).instances[0]?.questions ?? [];

  it("numbers questions per instance and never reuses a number", () => {
    const { state } = given(
      started,
      [agent, ask()],
      [agent, ask({ title: "Ship to staging first?" })],
      [agent, withdraw("w1.q1")],
      [agent, ask({ title: "Third" })],
    );
    expect(questionsOf(state).map((question) => question.id)).toEqual(["w1.q1", "w1.q2", "w1.q3"]);
    expect(questionsOf(state)[0]?.summary).toBe("Yes (recommended) · No, wait for Sam");
    expect(openQuestions(toView(state).instances[0]!).map((question) => question.id)).toEqual([
      "w1.q2",
      "w1.q3",
    ]);
    expect(toView(state).instances[0]?.currentStepId).toBe("w1.1");
  });

  it("records who answered and where, defaulting the source by actor", () => {
    const fromPane = given(...answered).state;
    expect(questionsOf(fromPane)[0]?.state).toEqual({
      _tag: "answered",
      stamp: { seq: 3, at: "2026-10-17T12:00:02.000Z", by: user },
      answer: "Yes",
      source: "pane",
    });
    const fromChat = given(...asked, [agent, answer("w1.q1", { answer: "No, wait" })]).state;
    expect(questionsOf(fromChat)[0]?.state).toMatchObject({ source: "chat", answer: "No, wait" });
    expect(questionsOf(fromChat)[0]?.history).toHaveLength(1);
  });

  it("withdraws with a reason and reopens to open", () => {
    const gone = given(...withdrawn).state;
    expect(questionsOf(gone)[0]?.state).toMatchObject({
      _tag: "withdrawn",
      reason: "Sam already reviewed it",
    });
    const back = given(...withdrawn, [user, reopen("w1.q1")]).state;
    expect(questionsOf(back)[0]?.state).toEqual({ _tag: "open" });
    expect(questionsOf(back)[0]?.history.map((record) => record.event._tag)).toEqual([
      "withdrawn",
      "reopened",
    ]);
  });

  it("reports attention only while a valid open instance has an open question", () => {
    expect(attentionOf(given(started).state)).toBeNull();
    const two = given(started, [agent, ask()], [agent, ask({ title: "Second?" })]).state;
    expect(attentionOf(two)).toEqual({ threadId, openQuestions: 2, latestQuestionId: "w1.q2" });
    const one = apply(two, agent, answer("w1.q2", { answer: "Later" })).state;
    expect(attentionOf(one)).toEqual({ threadId, openQuestions: 1, latestQuestionId: "w1.q1" });
    expect(attentionOf(apply(one, user, answer("w1.q1")).state)).toBeNull();
    expect(attentionOf(apply(two, user, close("w1", "abandoned")).state)).toBeNull();
    expect(attentionOf(markCorrupt(two, "line 9 of its log is not JSON"))).toBeNull();
  });

  it("names the instance a question request acted on", () => {
    const { state } = given(...asked);
    expect(instanceActedOn(state, ask() as never, null)).toBe("w1");
    expect(instanceActedOn(state, answer("w1.q1") as never, null)).toBe("w1");
    expect(instanceActedOn(state, withdraw("w1.q1") as never, null)).toBe("w1");
    expect(instanceActedOn(state, reopen("w1.q1") as never, null)).toBe("w1");
  });

  it("folds a question log to the same state record by record, and drops question history from the pane view", () => {
    const { state, records } = given(
      started,
      [agent, ask({ blocksStepId: "w1.1" })],
      [user, answer("w1.q1")],
      [agent, ask({ title: "Second?" })],
      [agent, withdraw("w1.q2")],
      [user, reopen("w1.q2")],
      [agent, { _tag: "comment", target: "w1.q2", comment: "still relevant" }],
    );
    expect(fold(threadId, records)).toEqual(state);
    const summary = toSubscriptionView(state).instances[0]?.questions ?? [];
    expect(summary.map((question) => question.state._tag)).toEqual(["answered", "open"]);
    expect(summary[0]).not.toHaveProperty("history");
    expect(summary[0]?.blocksStepId).toBe("w1.1");
  });

  it("folds a log written before questions existed with none", () => {
    const { records } = given(started, [agent, tick("w1.1")]);
    const folded = fold(threadId, records);
    expect(toView(folded).instances[0]?.questions).toEqual([]);
    expect(toSubscriptionView(folded).instances[0]?.questions).toEqual([]);
  });
});

describe("admits questions", () => {
  const { state: open, records } = given(...asked);
  const askedRecord = records[1] as ThreadWorkflowChangeRecord;
  const at = (seq: number, event: unknown) => decodeRecord({ ...askedRecord, seq, event });
  const asking = (id: string, instanceId = "w1", blocksStepId?: string) => ({
    _tag: "asked",
    instanceId,
    question: { id, title: "Again?", ...(blocksStepId === undefined ? {} : { blocksStepId }) },
  });

  it("admits every question record decide wrote, in order", () => {
    const log = given(
      ...asked,
      [agent, ask({ title: "Second?", blocksStepId: "w1.2" })],
      [user, answer("w1.q1")],
      [agent, withdraw("w1.q2")],
      [user, reopen("w1.q2")],
      [agent, { _tag: "comment", target: "w1.q2", comment: "x" }],
      [user, close("w1", "abandoned")],
      [agent, answer("w1.q2", { source: "chat" })],
    );
    let state = emptyState(threadId);
    for (const record of log.records) {
      expect(admits(state, record)).toBeNull();
      state = evolve(state, record);
    }
  });

  it("refuses an ask on a missing or closed instance, a taken id, or a missing blocked step", () => {
    expect(admits(open, at(3, asking("w2.q1", "w2")))).toBe("asks on w2, which does not exist");
    const closed = given(...asked, [user, close("w1", "abandoned")]).state;
    expect(admits(closed, at(4, asking("w1.q2")))).toBe("asks on w1, which is closed");
    expect(admits(open, at(3, asking("w1.q1")))).toBe("asks w1.q1, an id w1 cannot take");
    expect(admits(open, at(3, asking("w2.q2")))).toBe("asks w2.q2, an id w1 cannot take");
    expect(admits(open, at(3, asking("w1.q2", "w1", "w1.9")))).toBe(
      "asks w1.q2 blocking w1.9, which does not exist",
    );
  });

  it("refuses answers, withdrawals and reopens the question's state does not allow", () => {
    const resolved = given(...answered).state;
    const answering = { _tag: "answered", questionId: "w1.q1", answer: "x", source: "chat" };
    expect(admits(resolved, at(4, answering))).toBe("moves w1.q1 from answered to answered");
    expect(admits(resolved, at(4, { _tag: "withdrawn", questionId: "w1.q1", reason: "x" }))).toBe(
      "moves w1.q1 from answered to withdrawn",
    );
    expect(admits(open, at(3, { ...answering, questionId: "w1.q7" }))).toBe(
      "changes w1.q7, which does not exist",
    );
    expect(admits(open, at(3, { _tag: "reopened", target: "w1.q1", reason: "x" }))).toBe(
      "reopens w1.q1, which is open",
    );
    expect(
      admits(open, at(3, { _tag: "commented", target: "w1.q9", comment: "x", proof: null })),
    ).toBe("comments on w1.q9, which does not exist");
  });
});
