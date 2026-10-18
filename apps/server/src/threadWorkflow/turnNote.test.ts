import { THREAD_WORKFLOW_LIMITS, ThreadWorkflowTemplate } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { markCorrupt, toSubscriptionView, toView } from "./domain.ts";
import { builtInTemplates } from "./templates/index.ts";
import { agent, apply, given, started, user } from "./testkit.ts";
import { turnNote } from "./turnNote.ts";

const decodeTemplate = Schema.decodeSync(ThreadWorkflowTemplate);
const note = (state: Parameters<typeof toView>[0]) => turnNote(toSubscriptionView(state));

describe("turnNote", () => {
  it("is empty when no workflow is open", () => {
    expect(note(given().state)).toBe("");
    expect(
      note(
        given(started, [
          user,
          { _tag: "close", instanceId: "w1", outcome: "abandoned", reason: "x" },
        ]).state,
      ),
    ).toBe("");
  });

  it("prints the current step with the exact tick and skip calls", () => {
    const text = note(given(started).state);
    expect(text.startsWith("<thread-workflow>\n")).toBe(true);
    expect(text.endsWith("\n</thread-workflow>")).toBe(true);
    expect(text).toContain('Workflow "Checklist" (w1, template checklist), step 1 of 3: Write it');
    expect(text).toContain("Write the code.");
    expect(text).toContain("Proof wanted (required): the commit SHA.");
    expect(text).toContain(
      'thread_workflow_tick {"stepId":"w1.1","comment":"<what you did and how you know it worked>","proof":"<the commit SHA>"}',
    );
    expect(text).toContain(
      'thread_workflow_change {"action":"skip","stepId":"w1.1","reason":"<why>"}',
    );
    expect(text).toContain("thread_workflow_get {}");
    expect(text).toContain("cannot settle, archive or be deleted while the workflow is open");
    expect(text).not.toContain("waits for the user");
  });

  it("adds the wait-for-user line and drops the proof key for a step without proof", () => {
    const text = note(
      given(started, [agent, { _tag: "tick", stepId: "w1.1", comment: "done" }]).state,
    );
    expect(text).toContain("step 2 of 3: Ask the user");
    expect(text).toContain(
      "This step waits for the user. Ask once with your question tool, then tick it with their answer in the comment.",
    );
    expect(text).toContain(
      'thread_workflow_tick {"stepId":"w1.2","comment":"<what you did and how you know it worked>"}',
    );
    expect(text).not.toContain("Proof wanted");
  });

  it("prints the close call when no step is open", () => {
    const { state } = given(
      started,
      [agent, { _tag: "tick", stepId: "w1.1", comment: "done" }],
      [agent, { _tag: "tick", stepId: "w1.2", comment: "user said go" }],
      [agent, { _tag: "skip", stepId: "w1.3", reason: "shipped elsewhere" }],
    );
    const text = note(state);
    expect(text).toContain(
      'thread_workflow_close {"instanceId":"w1","outcome":"finished","reason":"<why it is done>"}',
    );
    expect(text).not.toContain("thread_workflow_tick");
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
    const text = turnNote(view);
    expect(text).toContain("waits for the user");
    expect(text.length).toBeLessThan(THREAD_WORKFLOW_LIMITS.turnNote);
  });

  it("stays under the cap for every step of every built-in template", () => {
    for (const template of builtInTemplates.values()) {
      let state = apply(
        given().state,
        user,
        { _tag: "start", templateId: template.id },
        { templates: new Map([[template.id, { template, freshness: "fresh" }]]) },
      ).state;
      for (const step of template.steps.keys()) {
        const text = note(state);
        expect(text).toContain(`"stepId":"w1.${step + 1}"`);
        expect(text.length).toBeLessThan(THREAD_WORKFLOW_LIMITS.turnNote);
        state = apply(state, user, { _tag: "tick", stepId: `w1.${step + 1}` }).state;
      }
    }
  });
});
