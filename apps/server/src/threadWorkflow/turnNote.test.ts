import { THREAD_WORKFLOW_LIMITS, ThreadWorkflowTemplate } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { markCorrupt, toSubscriptionView, toView } from "./domain.ts";
import { builtInTemplates } from "./templates/index.ts";
import { agent, apply, given, started, user } from "./testkit.ts";
import { noWorkflowNote, turnNote, WAITS_FOR_USER, type TurnNoteForm } from "./turnNote.ts";

const decodeTemplate = Schema.decodeSync(ThreadWorkflowTemplate);
const note = (state: Parameters<typeof toView>[0], form: TurnNoteForm = "full") =>
  turnNote(toSubscriptionView(state), form);

/** Every printed call in a note, parsed the way an agent would copy it. */
const printedCalls = (text: string) =>
  text.split("\n").flatMap((line) => {
    const match = /(thread_workflow_[a-z]+) (\{.*\})$/.exec(line);
    return match === null
      ? []
      : [{ tool: match[1], params: JSON.parse(match[2] ?? "") as Record<string, unknown> }];
  });

/** The verifier's probe: a start with the longest title, then a first step with every field at its limit. */
const probeState = (proofHint: string) =>
  given(
    [
      user,
      {
        _tag: "start",
        templateId: "checklist",
        title: "T".repeat(THREAD_WORKFLOW_LIMITS.instanceTitle),
      },
    ],
    [
      user,
      {
        _tag: "insert",
        afterStepId: null,
        step: {
          title: "S".repeat(THREAD_WORKFLOW_LIMITS.stepTitle),
          instructions: "I".repeat(THREAD_WORKFLOW_LIMITS.instructions),
          proofLevel: "recommended",
          proofHint,
          waitsForUser: true,
        },
        reason: "probe",
      },
    ],
  ).state;

const DROPPED = [
  "cannot settle, archive or be deleted",
  "Whole workflow",
  "thread_workflow_get {}",
  '"action":"skip"',
  "When it is done",
  "If it should not be done",
  "template checklist",
  "question tool",
];

describe("turnNote", () => {
  it("is empty when no workflow is open", () => {
    expect(note(given().state)).toBe("");
    expect(note(given().state, "short")).toBe("");
    expect(
      note(
        given(started, [
          user,
          { _tag: "close", instanceId: "w1", outcome: "abandoned", reason: "x" },
        ]).state,
      ),
    ).toBe("");
  });

  it("prints the whole step in the full form, with the slug and the Done call", () => {
    expect(note(given(started).state)).toBe(
      [
        "<thread-workflow>",
        'Workflow "Checklist" (w1), step 1 of 3: write-it (w1.1)',
        "Write it",
        "Write the code.",
        "Proof wanted (required): the commit SHA.",
        'Done: thread_workflow_tick {"stepId":"w1.1","comment":"<what you did and how you know it worked>","proof":"<the commit SHA>"}',
        "</thread-workflow>",
      ].join("\n"),
    );
  });

  it("names the step in one line in the short form", () => {
    const text = note(given(started).state, "short");
    expect(text).toBe(
      "<thread-workflow>\nWorkflow w1, step 1 of 3: write-it (w1.1)\n</thread-workflow>",
    );
    expect(text.length).toBeLessThan(200);
  });

  it("drops the lifecycle rule, the get and skip calls and the labels from every form", () => {
    const state = given(started).state;
    for (const text of [note(state), note(state, "short")]) {
      for (const dropped of DROPPED) expect(text).not.toContain(dropped);
    }
  });

  it("puts the user's-decision line before Done on a step that waits, and drops the proof key", () => {
    const text = note(
      given(started, [agent, { _tag: "tick", stepId: "w1.1", comment: "done" }]).state,
    );
    const lines = text.split("\n");
    expect(lines[1]).toBe('Workflow "Checklist" (w1), step 2 of 3: ask-the-user (w1.2)');
    expect(lines.indexOf(WAITS_FOR_USER)).toBe(lines.length - 3);
    expect(lines.at(-2)).toBe(
      'Done: thread_workflow_tick {"stepId":"w1.2","comment":"<what you did and how you know it worked>"}',
    );
    expect(WAITS_FOR_USER).not.toContain("question tool");
    expect(text).not.toContain("Proof wanted");
    expect(note(given(started).state)).not.toContain(WAITS_FOR_USER);
  });

  it("tells a thread under /poteto-mode with no workflow to start one", () => {
    expect(noWorkflowNote()).toBe(
      [
        "<thread-workflow>",
        'No workflow is open on this thread. Before task work, pick the playbook and start its workflow: thread_workflow_start {"templateId":"<template>"}. Templates: thread_workflow_get {}. Discussion and status replies need none.',
        "</thread-workflow>",
      ].join("\n"),
    );
  });

  it("prints the close call when no step is open, in either form", () => {
    const { state } = given(
      started,
      [agent, { _tag: "tick", stepId: "w1.1", comment: "done" }],
      [agent, { _tag: "tick", stepId: "w1.2", comment: "user said go" }],
      [agent, { _tag: "skip", stepId: "w1.3", reason: "shipped elsewhere" }],
    );
    const text = note(state);
    expect(note(state, "short")).toBe(text);
    expect(text).toContain('Workflow "Checklist" (w1): every step is done, skipped or removed.');
    expect(text).toContain(
      'thread_workflow_close {"instanceId":"w1","outcome":"finished","reason":"<why it is done>"}',
    );
    expect(text).not.toContain("thread_workflow_tick");
    for (const dropped of DROPPED) expect(text).not.toContain(dropped);
  });

  it("offers the next step when every step of a full plan is done, because done steps leave the cap", () => {
    const extra = {
      title: "Extra",
      instructions: "Do more.",
      proofLevel: "none",
      waitsForUser: false,
    };
    const inserts = Array.from(
      { length: THREAD_WORKFLOW_LIMITS.steps - 3 },
      () => [agent, { _tag: "insert", step: extra, reason: "more work" }] as const,
    );
    const { state } = given(started, ...inserts);
    const ticks = state.instances[0]!.instance.steps.map(
      (step) => [agent, { _tag: "tick", stepId: step.id, comment: "done" }] as const,
    );
    const text = note(given(started, ...inserts, ...ticks).state);
    expect(text).toContain('"action":"insert"');
    expect(text).toContain('"afterStepId":"w1.8"');
    expect(text).not.toContain('"action":"comment"');
  });

  it("tells the agent a corrupt log needs the user", () => {
    const text = note(markCorrupt(given(started).state, "line 2 of its log is not JSON"));
    expect(text).toContain("line 2 of its log is not JSON");
    expect(text).toContain("Workflow tab on web or desktop");
  });

  it("stays under the cap with every field at its limit", () => {
    const worst = decodeTemplate({
      id: "x".repeat(THREAD_WORKFLOW_LIMITS.templateId),
      version: 1,
      title: "T".repeat(THREAD_WORKFLOW_LIMITS.instanceTitle),
      description: "worst case",
      source: null,
      steps: [
        {
          title: "S".repeat(THREAD_WORKFLOW_LIMITS.stepTitle),
          slug: "s".repeat(THREAD_WORKFLOW_LIMITS.slug),
          instructions: "I".repeat(THREAD_WORKFLOW_LIMITS.instructions),
          proofLevel: "recommended",
          // Quotes double in the JSON of the printed tick call.
          proofHint: '"'.repeat(THREAD_WORKFLOW_LIMITS.proofHint),
          waitsForUser: true,
        },
      ],
    });
    const applied = apply(
      given().state,
      user,
      { _tag: "start", templateId: worst.id },
      { templates: new Map([[worst.id, { template: worst, freshness: "no-source" }]]) },
    );
    // Push the ids to three digits per part.
    const state = {
      ...applied.state,
      instances: applied.state.instances.map((entry) => ({
        ...entry,
        instance: {
          ...entry.instance,
          id: "w999" as never,
          steps: entry.instance.steps.map((step) => ({ ...step, id: "w999.999" as never })),
          currentStepId: "w999.999" as never,
        },
      })),
    };
    const view = { ...toView(state), activeInstanceId: "w999" as never };
    const text = turnNote(view, "full");
    expect(text).toContain(WAITS_FOR_USER);
    expect(text.length).toBeLessThan(THREAD_WORKFLOW_LIMITS.turnNote);
    expect(turnNote(view, "short").length).toBeLessThan(200);
  });

  it("cuts the instructions, never a printed call, when the escaped proof hint pushes it over the cap", () => {
    const hint = "\u0001".repeat(THREAD_WORKFLOW_LIMITS.proofHint);
    const text = note(probeState(hint));
    expect(text.length).toBeLessThanOrEqual(THREAD_WORKFLOW_LIMITS.turnNote);
    expect(text).toContain("step 1 of 4: " + "s".repeat(THREAD_WORKFLOW_LIMITS.slug) + " (w1.4)");
    expect(text).toContain(WAITS_FOR_USER);
    expect(text).toContain("I".repeat(150));
    expect(text).toContain("… (cut to fit; thread_workflow_get has the whole step)");
    expect(text).not.toContain("I".repeat(THREAD_WORKFLOW_LIMITS.instructions));
    expect(printedCalls(text)).toEqual([
      {
        tool: "thread_workflow_tick",
        params: {
          stepId: "w1.4",
          comment: "<what you did and how you know it worked>",
          proof: `<${hint}>`,
        },
      },
    ]);
  });

  it("keeps the whole instructions when the escaped note fits", () => {
    const text = note(probeState('"'.repeat(THREAD_WORKFLOW_LIMITS.proofHint)));
    expect(text.length).toBeLessThanOrEqual(THREAD_WORKFLOW_LIMITS.turnNote);
    expect(text).toContain("I".repeat(THREAD_WORKFLOW_LIMITS.instructions));
    expect(text).not.toContain("cut to fit");
  });

  it("stays under the caps for every step of every built-in template", () => {
    for (const template of builtInTemplates.values()) {
      let state = apply(
        given().state,
        user,
        { _tag: "start", templateId: template.id },
        { templates: new Map([[template.id, { template, freshness: "fresh" }]]) },
      ).state;
      for (const [index, step] of template.steps.entries()) {
        const full = note(state);
        expect(full).toContain(`: ${step.slug} (w1.${index + 1})`);
        expect(full).toContain(`"stepId":"w1.${index + 1}"`);
        expect(full.length).toBeLessThan(THREAD_WORKFLOW_LIMITS.turnNote);
        expect(note(state, "short").length).toBeLessThan(200);
        state = apply(state, user, { _tag: "tick", stepId: `w1.${index + 1}` }).state;
      }
    }
  });
});

describe("open questions", () => {
  const ask = (title: string, fields: Record<string, unknown> = {}) =>
    [agent, { _tag: "ask", title, ...fields }] as const;
  const asked = given(
    started,
    ask("Merge without a second review?"),
    ask("Ship to staging first?"),
  );

  it("ends both forms with the open questions, and leaves the line out when none is open", () => {
    const line =
      "Open questions (2): w1.q1 Merge without a second review? · w1.q2 Ship to staging first?";
    const full = note(asked.state);
    const short = note(asked.state, "short");
    expect(full.split("\n").at(-2)).toBe(line);
    expect(short.split("\n").at(-2)).toBe(line);
    expect(full).toContain("Done: thread_workflow_tick");
    expect(short.split("\n")).toHaveLength(4);
    const answered = apply(asked.state, user, {
      _tag: "answer",
      questionId: "w1.q1",
      answer: "Yes",
    });
    expect(note(answered.state)).toContain("Open questions (1): w1.q2 Ship to staging first?\n");
    const none = apply(answered.state, agent, {
      _tag: "withdraw",
      questionId: "w1.q2",
      reason: "moot",
    });
    expect(note(none.state)).not.toContain("Open questions");
    expect(note(none.state, "short")).toBe(note(given(started).state, "short"));
  });

  it("lists five titles and counts the rest", () => {
    const seven = given(
      started,
      ...Array.from({ length: 7 }, (_, index) => ask(`Question ${index + 1}?`)),
    );
    const text = note(seven.state, "short");
    expect(text).toContain(
      "Open questions (7): w1.q1 Question 1? · w1.q2 Question 2? · w1.q3 Question 3? · w1.q4 Question 4? · w1.q5 Question 5? · and 2 more",
    );
    expect(text).not.toContain("Question 6?");
  });

  it("keeps the questions on the close form", () => {
    const { state } = given(
      started,
      [agent, { _tag: "tick", stepId: "w1.1", comment: "done" }],
      [agent, { _tag: "tick", stepId: "w1.2", comment: "user said go" }],
      [agent, { _tag: "skip", stepId: "w1.3", reason: "shipped elsewhere" }],
      ask("Close it now?"),
    );
    const text = note(state);
    expect(text).toContain('thread_workflow_close {"instanceId":"w1","outcome":"finished"');
    expect(text.split("\n").at(-2)).toBe("Open questions (1): w1.q1 Close it now?");
  });

  it("clips the listed titles before the instructions when the note is over the cap", () => {
    const long = "Q".repeat(THREAD_WORKFLOW_LIMITS.questionTitle);
    const state = given(
      [
        user,
        {
          _tag: "start",
          templateId: "checklist",
          title: "T".repeat(THREAD_WORKFLOW_LIMITS.instanceTitle),
        },
      ],
      [
        user,
        {
          _tag: "insert",
          afterStepId: null,
          step: {
            title: "S".repeat(THREAD_WORKFLOW_LIMITS.stepTitle),
            instructions: "I".repeat(THREAD_WORKFLOW_LIMITS.instructions),
            proofLevel: "recommended",
            proofHint: "H".repeat(THREAD_WORKFLOW_LIMITS.proofHint),
            waitsForUser: true,
          },
          reason: "probe",
        },
      ],
      ...Array.from({ length: 6 }, () => ask(long)),
    ).state;
    const text = note(state);
    expect(text.length).toBeLessThanOrEqual(THREAD_WORKFLOW_LIMITS.turnNote);
    expect(text).toContain("I".repeat(THREAD_WORKFLOW_LIMITS.instructions));
    expect(text).not.toContain("cut to fit");
    const line = text.split("\n").at(-2) ?? "";
    expect(line.startsWith("Open questions (6): w1.q1 Q")).toBe(true);
    expect(line.endsWith("… · and 1 more")).toBe(true);
    expect(line).not.toContain(long);
    expect(printedCalls(text).map((entry) => entry.tool)).toEqual(["thread_workflow_tick"]);
    const short = note(state, "short");
    expect(short.length).toBeLessThanOrEqual(THREAD_WORKFLOW_LIMITS.turnNote);
    expect(short).toContain(long);
  });

  it("cuts the instructions once every listed title is at its floor", () => {
    const hint = "\u0001".repeat(THREAD_WORKFLOW_LIMITS.proofHint);
    const state = given(
      ...([
        [user, { _tag: "start", templateId: "checklist", title: "T".repeat(120) }],
        [
          user,
          {
            _tag: "insert",
            afterStepId: null,
            step: {
              title: "S".repeat(THREAD_WORKFLOW_LIMITS.stepTitle),
              instructions: "I".repeat(THREAD_WORKFLOW_LIMITS.instructions),
              proofLevel: "recommended",
              proofHint: hint,
              waitsForUser: true,
            },
            reason: "probe",
          },
        ],
      ] as const),
      ...Array.from({ length: 5 }, () => ask("Q".repeat(THREAD_WORKFLOW_LIMITS.questionTitle))),
    ).state;
    const text = note(state);
    expect(text.length).toBeLessThanOrEqual(THREAD_WORKFLOW_LIMITS.turnNote);
    expect(text).toContain("cut to fit");
    expect(text).toContain("Open questions (5): w1.q1 " + "Q".repeat(23) + "…");
    expect(printedCalls(text)).toHaveLength(1);
  });
});
