import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  THREAD_WORKFLOW_LIMITS,
  ThreadWorkflowInstanceId,
  ThreadWorkflowQuestionId,
  ThreadWorkflowRequest,
  ThreadWorkflowStepId,
  ThreadWorkflowTarget,
} from "./threadWorkflow.ts";

const accepts = (schema: Schema.Codec<unknown, unknown>, input: unknown) =>
  Schema.decodeUnknownExit(schema)(input)._tag === "Success";

describe("thread workflow ids", () => {
  it("keeps instance, step and question ids disjoint", () => {
    expect(accepts(ThreadWorkflowQuestionId, "w1.q1")).toBe(true);
    expect(accepts(ThreadWorkflowQuestionId, "w12.q30")).toBe(true);
    for (const notAQuestion of ["w1.1", "w1", "w1.q0", "w1.q", "q1", "w1.q1.1"]) {
      expect(accepts(ThreadWorkflowQuestionId, notAQuestion)).toBe(false);
    }
    expect(accepts(ThreadWorkflowStepId, "w1.q1")).toBe(false);
    expect(accepts(ThreadWorkflowInstanceId, "w1.q1")).toBe(false);
  });

  it("takes a question id as a target", () => {
    expect(accepts(ThreadWorkflowTarget, "w1.q1")).toBe(true);
    expect(accepts(ThreadWorkflowTarget, "w1.1")).toBe(true);
    expect(accepts(ThreadWorkflowTarget, "w1")).toBe(true);
  });
});

describe("question requests", () => {
  const request = Schema.decodeUnknownExit(ThreadWorkflowRequest);

  it("holds each field of an ask to its cap", () => {
    const full = {
      _tag: "ask",
      title: "T".repeat(THREAD_WORKFLOW_LIMITS.questionTitle),
      summary: "S".repeat(THREAD_WORKFLOW_LIMITS.questionSummary),
      details: "D".repeat(THREAD_WORKFLOW_LIMITS.questionDetails),
      options: Array.from({ length: THREAD_WORKFLOW_LIMITS.questionOptions }, (_, index) => ({
        label: "L".repeat(THREAD_WORKFLOW_LIMITS.questionOptionLabel),
        recommended: index === 0,
      })),
      blocksStepId: "w1.2",
    };
    expect(request(full)._tag).toBe("Success");
    expect(request({ ...full, title: `${full.title}!` })._tag).toBe("Failure");
    expect(request({ ...full, summary: `${full.summary}!` })._tag).toBe("Failure");
    expect(request({ ...full, details: `${full.details}!` })._tag).toBe("Failure");
    expect(request({ ...full, options: [...full.options, { label: "one more" }] })._tag).toBe(
      "Failure",
    );
    expect(request({ ...full, options: [{ label: `${full.options[0]!.label}!` }] })._tag).toBe(
      "Failure",
    );
    expect(request({ ...full, blocksStepId: "w1.q2" })._tag).toBe("Failure");
    expect(request({ _tag: "ask", title: "Short?" })._tag).toBe("Success");
  });

  it("caps an answer and leaves its source optional", () => {
    const answer = "A".repeat(THREAD_WORKFLOW_LIMITS.answer);
    expect(request({ _tag: "answer", questionId: "w1.q1", answer })._tag).toBe("Success");
    expect(request({ _tag: "answer", questionId: "w1.q1", answer, source: "chat" })._tag).toBe(
      "Success",
    );
    expect(request({ _tag: "answer", questionId: "w1.q1", answer: `${answer}!` })._tag).toBe(
      "Failure",
    );
    expect(request({ _tag: "answer", questionId: "w1.1", answer })._tag).toBe("Failure");
    expect(request({ _tag: "withdraw", questionId: "w1.q1", reason: "moot" })._tag).toBe("Success");
  });
});
