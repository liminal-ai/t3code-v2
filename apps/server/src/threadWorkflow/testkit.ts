import {
  ThreadId,
  ThreadWorkflowRequest,
  ThreadWorkflowTemplate,
  type ThreadWorkflowActor,
  type ThreadWorkflowError,
  type ThreadWorkflowRecord,
  type ThreadWorkflowTemplateId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  decide,
  emptyState,
  evolve,
  recordFor,
  type DecideContext,
  type Decision,
  type ResolvedTemplate,
  type ThreadWorkflowState,
} from "./domain.ts";

export const threadId = ThreadId.make("thread-1");
export const user: ThreadWorkflowActor = { _tag: "user", clientSessionId: "session-1" };
export const agent: ThreadWorkflowActor = { _tag: "agent", threadId };

export const request = Schema.decodeUnknownSync(ThreadWorkflowRequest);

export const checklist = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "checklist",
  version: 1,
  title: "Checklist",
  description: "Three steps for tests.",
  source: null,
  steps: [
    {
      title: "Write it",
      instructions: "Write the code.",
      proofLevel: "required",
      proofHint: "the commit SHA",
      waitsForUser: false,
    },
    {
      title: "Ask the user",
      instructions: "Ask whether to ship.",
      proofLevel: "none",
      waitsForUser: true,
    },
    {
      title: "Ship it",
      instructions: "Merge the PR.",
      proofLevel: "recommended",
      waitsForUser: false,
    },
  ],
});

export const contextWith = (
  overrides: Partial<DecideContext> = {},
  templates: ReadonlyArray<ResolvedTemplate> = [{ template: checklist, freshness: "no-source" }],
): DecideContext => ({
  requestId: null,
  expectedRevision: null,
  enabled: true,
  threadActive: true,
  templates: new Map<ThreadWorkflowTemplateId, ResolvedTemplate>(
    templates.map((resolved) => [resolved.template.id, resolved]),
  ),
  ...overrides,
});

export interface Applied {
  readonly state: ThreadWorkflowState;
  readonly decision: Decision | ThreadWorkflowError;
  readonly record: ThreadWorkflowRecord | null;
}

/** One request through the real write path: decide, build the record, fold it. */
export const apply = (
  state: ThreadWorkflowState,
  actor: ThreadWorkflowActor,
  input: unknown,
  overrides: Partial<DecideContext> = {},
): Applied => {
  const context = contextWith(overrides);
  const parsed = request(input);
  const decision = decide(state, actor, parsed, context);
  if (decision._tag === "ThreadWorkflowError") return { state, decision, record: null };
  const record = recordFor(state, actor, parsed, decision, {
    requestId: context.requestId,
    at: `2026-10-17T12:00:${String(state.lastSeq).padStart(2, "0")}.000Z`,
  });
  return { state: record === null ? state : evolve(state, record), decision, record };
};

/** Applies requests in order, failing the test on any refusal; returns the state and its records. */
export const given = (
  ...steps: ReadonlyArray<readonly [ThreadWorkflowActor, unknown, Partial<DecideContext>?]>
) => {
  let state = emptyState(threadId);
  const records: Array<ThreadWorkflowRecord> = [];
  for (const [actor, input, overrides] of steps) {
    const applied = apply(state, actor, input, overrides);
    if (applied.decision._tag === "ThreadWorkflowError") {
      throw new Error(`setup refused: ${applied.decision.code}: ${applied.decision.message}`);
    }
    state = applied.state;
    if (applied.record !== null) records.push(applied.record);
  }
  return { state, records };
};

export const started = [user, { _tag: "start", templateId: "checklist" }] as const;
