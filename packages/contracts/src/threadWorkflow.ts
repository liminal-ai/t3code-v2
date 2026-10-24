import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProviderSessionId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

// "Workflow" already names Claude workflow runs (`t3_workflow_stop`). Everything here is a
// thread workflow: the user's checklist for one thread.

/** `w1`, `w2`: numbered per thread in start order, never reused, short so a printed call stays readable. */
export const ThreadWorkflowInstanceId = Schema.String.check(Schema.isPattern(/^w[1-9]\d*$/)).pipe(
  Schema.brand("ThreadWorkflowInstanceId"),
);
export type ThreadWorkflowInstanceId = typeof ThreadWorkflowInstanceId.Type;

/**
 * `w2.4`: the instance id, then a per-instance counter that never reuses a number, so a step
 * inserted after a removed one cannot alias it. Display order is the array order.
 */
export const ThreadWorkflowStepId = Schema.String.check(
  Schema.isPattern(/^w[1-9]\d*\.[1-9]\d*$/),
).pipe(Schema.brand("ThreadWorkflowStepId"));
export type ThreadWorkflowStepId = typeof ThreadWorkflowStepId.Type;

/** A step or an instance. The two id patterns are disjoint. */
export const ThreadWorkflowTarget = Schema.Union([ThreadWorkflowStepId, ThreadWorkflowInstanceId]);
export type ThreadWorkflowTarget = typeof ThreadWorkflowTarget.Type;

export const ThreadWorkflowTemplateId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
  Schema.isMaxLength(48),
).pipe(Schema.brand("ThreadWorkflowTemplateId"));
export type ThreadWorkflowTemplateId = typeof ThreadWorkflowTemplateId.Type;

/** A record's 1-based position in its thread's log. */
export const ThreadWorkflowSeq = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ThreadWorkflowSeq"),
);
export type ThreadWorkflowSeq = typeof ThreadWorkflowSeq.Type;

export const ThreadWorkflowRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ThreadWorkflowRequestId = typeof ThreadWorkflowRequestId.Type;

/** sha256 hex of a request's canonical JSON. */
export const ThreadWorkflowDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

const Reason = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
const Comment = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));
const Proof = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
// The title, instructions and hint caps keep the full turn note under 2,000 characters; a hint
// that JSON-escapes in the printed tick call can cost up to six characters each, and the note
// cuts the instructions to absorb that.
const InstanceTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const StepTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Instructions = TrimmedNonEmptyString.check(Schema.isMaxLength(640));
const ProofHint = TrimmedNonEmptyString.check(Schema.isMaxLength(120));

export const THREAD_WORKFLOW_LIMITS = {
  instanceTitle: 120,
  stepTitle: 120,
  instructions: 640,
  proofHint: 120,
  templateId: 48,
  turnNote: 2_000,
  /** Steps that are open or done. The pane is for a glance, so a plan is a few stages, not a task list. */
  steps: 8,
} as const;

/** How much a step wants evidence. Advisory: it shapes the note and the pane and never refuses a tick. */
export const ThreadWorkflowProofLevel = Schema.Literals([
  "none",
  "recommended",
  "preferred",
  "required",
]);
export type ThreadWorkflowProofLevel = typeof ThreadWorkflowProofLevel.Type;

export const ThreadWorkflowOutcome = Schema.Literals(["finished", "abandoned"]);
export type ThreadWorkflowOutcome = typeof ThreadWorkflowOutcome.Type;

/** The user, through any client. The client session traces a pane edit to a device. */
export const ThreadWorkflowUser = Schema.TaggedStruct("user", {
  clientSessionId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ThreadWorkflowUser = typeof ThreadWorkflowUser.Type;

/** The agent of `threadId`, resolved from its MCP credential, never from a tool argument. */
export const ThreadWorkflowAgent = Schema.TaggedStruct("agent", {
  threadId: ThreadId,
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
  providerSessionId: Schema.optionalKey(ProviderSessionId),
  runId: Schema.optionalKey(RunId),
});
export type ThreadWorkflowAgent = typeof ThreadWorkflowAgent.Type;

export const ThreadWorkflowActor = Schema.Union([ThreadWorkflowUser, ThreadWorkflowAgent]);
export type ThreadWorkflowActor = typeof ThreadWorkflowActor.Type;

export const ThreadWorkflowStepSeed = Schema.Struct({
  title: StepTitle,
  instructions: Instructions,
  proofLevel: ThreadWorkflowProofLevel,
  /** What counts as proof, printed in the note: "PR URL", "test command and result". */
  proofHint: Schema.optionalKey(ProofHint),
  /** A step for the user (brief addendum). Advisory: it changes the note, not who may tick. */
  waitsForUser: Schema.Boolean,
});
export type ThreadWorkflowStepSeed = typeof ThreadWorkflowStepSeed.Type;

/**
 * Where a template came from. `sha256` is the installed playbook's hash at derivation time and is
 * what freshness compares. `commit` is provenance in liminal-ai/pstack-lim (branch `lim`).
 */
export const ThreadWorkflowTemplateSource = Schema.Struct({
  /** Relative to the playbook dir, e.g. "poteto-mode/playbooks/feature.md". */
  playbook: TrimmedNonEmptyString,
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  sha256: ThreadWorkflowDigest,
});
export type ThreadWorkflowTemplateSource = typeof ThreadWorkflowTemplateSource.Type;

export const ThreadWorkflowTemplate = Schema.Struct({
  id: ThreadWorkflowTemplateId,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  title: InstanceTitle,
  description: TrimmedNonEmptyString,
  /** null for a template with no playbook behind it. */
  source: Schema.NullOr(ThreadWorkflowTemplateSource),
  steps: Schema.Array(ThreadWorkflowStepSeed).check(Schema.isMinLength(1)),
});
export type ThreadWorkflowTemplate = typeof ThreadWorkflowTemplate.Type;

export const ThreadWorkflowTemplateFreshness = Schema.Literals([
  "fresh",
  "stale",
  "source-missing",
  "no-source",
]);
export type ThreadWorkflowTemplateFreshness = typeof ThreadWorkflowTemplateFreshness.Type;

export const ThreadWorkflowTemplateSummary = Schema.Struct({
  id: ThreadWorkflowTemplateId,
  version: Schema.Int,
  title: Schema.String,
  description: Schema.String,
  stepCount: Schema.Int,
  freshness: ThreadWorkflowTemplateFreshness,
});
export type ThreadWorkflowTemplateSummary = typeof ThreadWorkflowTemplateSummary.Type;

export const ThreadWorkflowStepDefinition = Schema.Struct({
  id: ThreadWorkflowStepId,
  ...ThreadWorkflowStepSeed.fields,
});
export type ThreadWorkflowStepDefinition = typeof ThreadWorkflowStepDefinition.Type;

export const ThreadWorkflowInstanceTemplate = Schema.Struct({
  id: ThreadWorkflowTemplateId,
  version: Schema.Int,
  source: Schema.NullOr(ThreadWorkflowTemplateSource),
  staleAtStart: Schema.Boolean,
});

// Every derived value (assigned ids, copied steps) is in the event, so folding never decides.
const Started = Schema.TaggedStruct("started", {
  instanceId: ThreadWorkflowInstanceId,
  title: InstanceTitle,
  template: ThreadWorkflowInstanceTemplate,
  /** Copied in at start, so a later template change never rewrites a running instance. */
  steps: Schema.Array(ThreadWorkflowStepDefinition),
  comment: Schema.NullOr(Comment),
});
const Skipped = Schema.TaggedStruct("skipped", { stepId: ThreadWorkflowStepId, reason: Reason });
const Inserted = Schema.TaggedStruct("inserted", {
  instanceId: ThreadWorkflowInstanceId,
  step: ThreadWorkflowStepDefinition,
  /** null inserts at the top of the instance. */
  afterStepId: Schema.NullOr(ThreadWorkflowStepId),
  reason: Reason,
});
const Removed = Schema.TaggedStruct("removed", { stepId: ThreadWorkflowStepId, reason: Reason });
const Commented = Schema.TaggedStruct("commented", {
  target: ThreadWorkflowTarget,
  comment: Comment,
  proof: Schema.NullOr(Proof),
});
const Reopened = Schema.TaggedStruct("reopened", { target: ThreadWorkflowTarget, reason: Reason });
const Closed = Schema.TaggedStruct("closed", {
  instanceId: ThreadWorkflowInstanceId,
  outcome: ThreadWorkflowOutcome,
  reason: Reason,
});
/**
 * The first record of a fresh log written by the user's `recover`. The unreadable log sits beside
 * it. `nextInstanceNumber` keeps new ids clear of every id the old log used.
 */
const Recovered = Schema.TaggedStruct("recovered", {
  reason: Reason,
  corruption: Schema.String,
  nextInstanceNumber: Schema.Int.check(Schema.isGreaterThan(0)),
});

/** The user may tick with no comment. An agent may not; the only event whose shape depends on the actor. */
const TickedByUser = Schema.TaggedStruct("ticked", {
  stepId: ThreadWorkflowStepId,
  comment: Schema.NullOr(Comment),
  proof: Schema.NullOr(Proof),
});
const TickedByAgent = Schema.TaggedStruct("ticked", {
  stepId: ThreadWorkflowStepId,
  comment: Comment,
  proof: Schema.NullOr(Proof),
});

const SharedEvents = [Started, Skipped, Inserted, Removed, Commented, Reopened, Closed] as const;
export const ThreadWorkflowUserEvent = Schema.Union([...SharedEvents, TickedByUser, Recovered]);
export const ThreadWorkflowAgentEvent = Schema.Union([...SharedEvents, TickedByAgent]);
export type ThreadWorkflowEvent =
  | typeof ThreadWorkflowUserEvent.Type
  | typeof ThreadWorkflowAgentEvent.Type;

const RecordFields = {
  v: Schema.Literal(1),
  seq: ThreadWorkflowSeq,
  at: IsoDateTime,
};

const ChangeFields = {
  ...RecordFields,
  kind: Schema.Literal("change"),
  requestId: Schema.NullOr(ThreadWorkflowRequestId),
  inputDigest: ThreadWorkflowDigest,
};

/**
 * One workflow change. Actor and event are paired, so an agent tick without a comment and an
 * agent `recovered` cannot be decoded, stored or built.
 */
export const ThreadWorkflowChangeRecord = Schema.Union([
  Schema.Struct({ ...ChangeFields, by: ThreadWorkflowUser, event: ThreadWorkflowUserEvent }),
  Schema.Struct({ ...ChangeFields, by: ThreadWorkflowAgent, event: ThreadWorkflowAgentEvent }),
]);
export type ThreadWorkflowChangeRecord = typeof ThreadWorkflowChangeRecord.Type;

/**
 * A request that succeeded without changing anything, kept so a retry of its `requestId` replays
 * instead of acting on whatever the state became since. Not workflow activity.
 */
export const ThreadWorkflowReceiptRecord = Schema.Struct({
  ...RecordFields,
  kind: Schema.Literal("receipt"),
  by: ThreadWorkflowActor,
  requestId: ThreadWorkflowRequestId,
  inputDigest: ThreadWorkflowDigest,
});
export type ThreadWorkflowReceiptRecord = typeof ThreadWorkflowReceiptRecord.Type;

/** One line of `<stateDir>/thread-workflows/threads/<threadId>.jsonl`. */
export const ThreadWorkflowRecord = Schema.Union([
  ThreadWorkflowChangeRecord,
  ThreadWorkflowReceiptRecord,
]);
export type ThreadWorkflowRecord = typeof ThreadWorkflowRecord.Type;

export const ThreadWorkflowRequest = Schema.Union([
  Schema.TaggedStruct("start", {
    templateId: ThreadWorkflowTemplateId,
    title: Schema.optionalKey(InstanceTitle),
    comment: Schema.optionalKey(Comment),
  }),
  /** `comment` is optional here because the user may omit it; an agent tick without one is refused. */
  Schema.TaggedStruct("tick", {
    stepId: ThreadWorkflowStepId,
    comment: Schema.optionalKey(Comment),
    proof: Schema.optionalKey(Proof),
  }),
  Schema.TaggedStruct("skip", { stepId: ThreadWorkflowStepId, reason: Reason }),
  Schema.TaggedStruct("insert", {
    /** Defaults to the open instance. Ignored when `afterStepId` names a step, which names its instance. */
    instanceId: Schema.optionalKey(ThreadWorkflowInstanceId),
    /** Omitted inserts at the end; null inserts at the top. */
    afterStepId: Schema.optionalKey(Schema.NullOr(ThreadWorkflowStepId)),
    step: ThreadWorkflowStepSeed,
    reason: Reason,
  }),
  Schema.TaggedStruct("remove", { stepId: ThreadWorkflowStepId, reason: Reason }),
  /** A step goes back to open; a closed instance reopens when no other instance is open. */
  Schema.TaggedStruct("reopen", { target: ThreadWorkflowTarget, reason: Reason }),
  Schema.TaggedStruct("comment", {
    target: ThreadWorkflowTarget,
    comment: Comment,
    proof: Schema.optionalKey(Proof),
  }),
  Schema.TaggedStruct("close", {
    instanceId: ThreadWorkflowInstanceId,
    outcome: ThreadWorkflowOutcome,
    reason: Reason,
  }),
  /** User only, and only for an unreadable log: sets the log aside and abandons what it held. */
  Schema.TaggedStruct("recover", { reason: Reason }),
]);
export type ThreadWorkflowRequest = typeof ThreadWorkflowRequest.Type;

export const ThreadWorkflowErrorCode = Schema.Literals([
  "disabled",
  "thread_not_active",
  "unknown_template",
  "unknown_instance",
  "unknown_step",
  "no_open_instance",
  "instance_open",
  "instance_closed",
  "invalid_transition",
  "steps_unresolved",
  "too_many_steps",
  "comment_required",
  "user_only",
  "not_corrupt",
  "corrupt",
  "request_id_reused",
  "revision_conflict",
  "store_unavailable",
]);
export type ThreadWorkflowErrorCode = typeof ThreadWorkflowErrorCode.Type;

/** Every refusal names what to do instead. `message` is written for the agent and the user's toast. */
export class ThreadWorkflowError extends Schema.TaggedError<ThreadWorkflowError>()(
  "ThreadWorkflowError",
  {
    code: ThreadWorkflowErrorCode,
    message: Schema.String,
  },
) {}
export const isThreadWorkflowError = Schema.is(ThreadWorkflowError);

export const ThreadWorkflowStamp = Schema.Struct({
  seq: ThreadWorkflowSeq,
  at: IsoDateTime,
  by: ThreadWorkflowActor,
});
export type ThreadWorkflowStamp = typeof ThreadWorkflowStamp.Type;

export const ThreadWorkflowStepState = Schema.Union([
  Schema.TaggedStruct("open", {}),
  Schema.TaggedStruct("done", {
    stamp: ThreadWorkflowStamp,
    comment: Schema.NullOr(Schema.String),
    proof: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("skipped", { stamp: ThreadWorkflowStamp, reason: Schema.String }),
  Schema.TaggedStruct("removed", { stamp: ThreadWorkflowStamp, reason: Schema.String }),
]);
export type ThreadWorkflowStepState = typeof ThreadWorkflowStepState.Type;

export const ThreadWorkflowStepOrigin = Schema.Union([
  Schema.TaggedStruct("template", {}),
  Schema.TaggedStruct("inserted", { stamp: ThreadWorkflowStamp, reason: Schema.String }),
]);

export const ThreadWorkflowStepSummary = Schema.Struct({
  ...ThreadWorkflowStepDefinition.fields,
  origin: ThreadWorkflowStepOrigin,
  state: ThreadWorkflowStepState,
});
export type ThreadWorkflowStepSummary = typeof ThreadWorkflowStepSummary.Type;

export const ThreadWorkflowInstanceStatus = Schema.Union([
  Schema.TaggedStruct("open", {}),
  Schema.TaggedStruct("closed", {
    outcome: ThreadWorkflowOutcome,
    stamp: ThreadWorkflowStamp,
    reason: Schema.String,
  }),
]);
export type ThreadWorkflowInstanceStatus = typeof ThreadWorkflowInstanceStatus.Type;

const InstanceSummaryFields = {
  id: ThreadWorkflowInstanceId,
  title: Schema.String,
  template: ThreadWorkflowInstanceTemplate,
  status: ThreadWorkflowInstanceStatus,
  /** First open step in display order; null when every step is resolved. */
  currentStepId: Schema.NullOr(ThreadWorkflowStepId),
  started: ThreadWorkflowStamp,
  lastChangeAt: IsoDateTime,
};

export const ThreadWorkflowInstanceSummary = Schema.Struct({
  ...InstanceSummaryFields,
  steps: Schema.Array(ThreadWorkflowStepSummary),
});
export type ThreadWorkflowInstanceSummary = typeof ThreadWorkflowInstanceSummary.Type;

export const ThreadWorkflowStep = Schema.Struct({
  ...ThreadWorkflowStepSummary.fields,
  /** Every record that touched this step, in order. */
  history: Schema.Array(ThreadWorkflowChangeRecord),
});
export type ThreadWorkflowStep = typeof ThreadWorkflowStep.Type;

export const ThreadWorkflowInstance = Schema.Struct({
  ...InstanceSummaryFields,
  steps: Schema.Array(ThreadWorkflowStep),
  /** Records about the instance itself: started, inserted, closed, reopened and its comments. */
  history: Schema.Array(ThreadWorkflowChangeRecord),
});
export type ThreadWorkflowInstance = typeof ThreadWorkflowInstance.Type;

const ViewFields = {
  threadId: ThreadId,
  /** Seq of the last change record; 0 for a thread with none. Receipts do not move it. */
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The open instance, derived: at most one instance is open. */
  activeInstanceId: Schema.NullOr(ThreadWorkflowInstanceId),
  /** Set when the log is unreadable or a write was uncertain. The workflow is read-only until the user recovers it. */
  corruption: Schema.NullOr(Schema.String),
};

/** What `get` returns: every instance with full history. */
export const ThreadWorkflowView = Schema.Struct({
  ...ViewFields,
  instances: Schema.Array(ThreadWorkflowInstance),
});
export type ThreadWorkflowView = typeof ThreadWorkflowView.Type;

/** What the subscription streams: current states and stamps, no history arrays. */
export const ThreadWorkflowSubscriptionView = Schema.Struct({
  ...ViewFields,
  instances: Schema.Array(ThreadWorkflowInstanceSummary),
});
export type ThreadWorkflowSubscriptionView = typeof ThreadWorkflowSubscriptionView.Type;

/** What `threadWorkflow.subscribe` streams. `visible`: the flag is on, or an instance is open or corrupt. */
export const ThreadWorkflowSubscriptionState = Schema.Struct({
  enabled: Schema.Boolean,
  visible: Schema.Boolean,
  /** Set when the server could not load any workflow logs at startup; the view is then empty. */
  unavailable: Schema.NullOr(Schema.String),
  view: ThreadWorkflowSubscriptionView,
});
export type ThreadWorkflowSubscriptionState = typeof ThreadWorkflowSubscriptionState.Type;

export const ThreadWorkflowApplyResult = Schema.Struct({
  changed: Schema.Boolean,
  /** The request id already had a record, so nothing was written and this is its first result. */
  replayed: Schema.Boolean,
  view: ThreadWorkflowSubscriptionView,
});
export type ThreadWorkflowApplyResult = typeof ThreadWorkflowApplyResult.Type;

export const ThreadWorkflowSubscribeInput = Schema.Struct({ threadId: ThreadId });
export const ThreadWorkflowGetInput = Schema.Struct({
  threadId: ThreadId,
  instanceId: ThreadWorkflowInstanceId,
});
/** The pane's write: it always binds a request id and the revision it rendered. */
export const ThreadWorkflowApplyInput = Schema.Struct({
  threadId: ThreadId,
  request: ThreadWorkflowRequest,
  requestId: ThreadWorkflowRequestId,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ThreadWorkflowApplyInput = typeof ThreadWorkflowApplyInput.Type;
