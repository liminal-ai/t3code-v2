/**
 * The thread workflow policy, pure. `decide` validates one request against the folded state and
 * returns the single change to record, `unchanged`, or a `ThreadWorkflowError` whose message
 * prints the corrective call. `evolve` applies one stored record; it is total and decides nothing,
 * because every derived value (assigned ids, copied steps) is already in the event.
 *
 * Downgrade policy: a log line with an unknown `v` or event kind marks its thread corrupt
 * (read-only) instead of being skipped, so a rollback to an older build never
 * silently drops intent. The user's `recover` sets the log aside and starts a fresh one.
 */
// @effect-diagnostics nodeBuiltinImport:off - decide is pure and synchronous; the Crypto service is not.
import * as NodeCrypto from "node:crypto";

import {
  isThreadWorkflowError,
  THREAD_WORKFLOW_LIMITS,
  ThreadWorkflowError,
  type ThreadId,
  type ThreadWorkflowActor,
  type ThreadWorkflowAgent,
  type ThreadWorkflowAgentEvent,
  type ThreadWorkflowChangeRecord,
  type ThreadWorkflowErrorCode,
  type ThreadWorkflowEvent,
  type ThreadWorkflowInstance,
  type ThreadWorkflowInstanceId,
  type ThreadWorkflowInstanceSummary,
  type ThreadWorkflowOutcome,
  type ThreadWorkflowReceiptRecord,
  type ThreadWorkflowRecord,
  type ThreadWorkflowRequest,
  type ThreadWorkflowSeq,
  type ThreadWorkflowStamp,
  type ThreadWorkflowStep,
  type ThreadWorkflowStepId,
  type ThreadWorkflowStepSummary,
  type ThreadWorkflowSubscriptionView,
  type ThreadWorkflowTarget,
  type ThreadWorkflowTemplate,
  type ThreadWorkflowTemplateFreshness,
  type ThreadWorkflowTemplateId,
  type ThreadWorkflowUser,
  type ThreadWorkflowUserEvent,
  type ThreadWorkflowView,
} from "@t3tools/contracts";

interface InstanceState {
  readonly instance: ThreadWorkflowInstance;
  readonly nextStepNumber: number;
  /** Digest of the `start` request, so a retried start without a request id converges. */
  readonly startDigest: string;
}

interface Receipt {
  readonly inputDigest: string;
  readonly seq: number;
  /** The instance the record acted on, or that was open for a bare receipt; null for a recovery. */
  readonly instanceId: ThreadWorkflowInstanceId | null;
}

export interface ThreadWorkflowState {
  readonly threadId: ThreadId;
  /** Seq of the last record of any kind; the next record is `lastSeq + 1`. */
  readonly lastSeq: number;
  /** Seq of the last change record. Receipts do not move it. */
  readonly revision: number;
  /** `at` of the last change record: what the inactivity ping measures. */
  readonly lastActivityAt: string | null;
  readonly nextInstanceNumber: number;
  readonly instances: ReadonlyArray<InstanceState>;
  readonly receipts: ReadonlyMap<string, Receipt>;
  readonly corruption: string | null;
}

export const emptyState = (threadId: ThreadId): ThreadWorkflowState => ({
  threadId,
  lastSeq: 0,
  revision: 0,
  lastActivityAt: null,
  nextInstanceNumber: 1,
  instances: [],
  receipts: new Map(),
  corruption: null,
});

export const fold = (
  threadId: ThreadId,
  records: ReadonlyArray<ThreadWorkflowRecord>,
): ThreadWorkflowState => records.reduce(evolve, emptyState(threadId));

/** Read-only from here on: decide refuses everything but the user's `recover`. */
export const markCorrupt = (
  state: ThreadWorkflowState,
  corruption: string,
  nextInstanceNumber = state.nextInstanceNumber,
): ThreadWorkflowState => ({
  ...state,
  corruption,
  nextInstanceNumber: Math.max(state.nextInstanceNumber, nextInstanceNumber),
});

const openInstance = (state: ThreadWorkflowState): InstanceState | undefined =>
  state.instances.find((entry) => entry.instance.status._tag === "open");

export const toView = (state: ThreadWorkflowState): ThreadWorkflowView => ({
  threadId: state.threadId,
  revision: state.revision,
  activeInstanceId: openInstance(state)?.instance.id ?? null,
  corruption: state.corruption,
  instances: state.instances.map((entry) => entry.instance),
});

export const toSubscriptionView = (state: ThreadWorkflowState): ThreadWorkflowSubscriptionView => {
  const view = toView(state);
  return {
    ...view,
    instances: view.instances.map(
      ({ history: _history, steps, ...instance }): ThreadWorkflowInstanceSummary => ({
        ...instance,
        steps: steps.map(({ history: _stepHistory, ...step }): ThreadWorkflowStepSummary => step),
      }),
    ),
  };
};

const call = (tool: string, params: Record<string, unknown>) => `${tool} ${JSON.stringify(params)}`;

type PrintableStep = Pick<ThreadWorkflowStepSummary, "id" | "proofLevel" | "proofHint">;

export const printedCall = {
  get: () => call("thread_workflow_get", {}),
  start: (templateId: string) => call("thread_workflow_start", { templateId }),
  tick: (step: PrintableStep) =>
    call("thread_workflow_tick", {
      stepId: step.id,
      comment: "<what you did and how you know it worked>",
      ...(step.proofLevel === "none" ? {} : { proof: `<${step.proofHint ?? "your evidence"}>` }),
    }),
  skip: (stepId: ThreadWorkflowStepId) =>
    call("thread_workflow_change", { action: "skip", stepId, reason: "<why>" }),
  reopen: (target: ThreadWorkflowTarget) =>
    call("thread_workflow_change", { action: "reopen", target, reason: "<why>" }),
  /** The answer to the idle ping: the user said go on, and the record says who. */
  commentContinue: (instanceId: ThreadWorkflowInstanceId) =>
    call("thread_workflow_change", {
      action: "comment",
      target: instanceId,
      comment: "Continue after the idle check. Answered by <who answered>.",
    }),
  insert: (afterStepId: ThreadWorkflowStepId | undefined) =>
    call("thread_workflow_change", {
      action: "insert",
      ...(afterStepId === undefined ? {} : { afterStepId }),
      title: "<step title>",
      instructions: "<what to do>",
      reason: "<why>",
    }),
  comment: (target: ThreadWorkflowTarget) =>
    call("thread_workflow_change", { action: "comment", target, comment: "<the detail>" }),
  close: (instanceId: ThreadWorkflowInstanceId, outcome: ThreadWorkflowOutcome) =>
    call("thread_workflow_close", {
      instanceId,
      outcome,
      reason: outcome === "finished" ? "<why it is done>" : "<what changed>",
    }),
};

const instanceIdOfStep = (stepId: ThreadWorkflowStepId) =>
  stepId.slice(0, stepId.indexOf(".")) as ThreadWorkflowInstanceId;

const isStepId = (target: ThreadWorkflowTarget): target is ThreadWorkflowStepId =>
  target.includes(".");

/** The counter part of `w2` or `w2.4`. */
const numberOf = (id: string) => Number(id.slice(id.includes(".") ? id.indexOf(".") + 1 : 1));

const findInstance = (state: ThreadWorkflowState, instanceId: ThreadWorkflowInstanceId) =>
  state.instances.find((entry) => entry.instance.id === instanceId);

const findStep = (state: ThreadWorkflowState, stepId: ThreadWorkflowStepId) => {
  const entry = findInstance(state, instanceIdOfStep(stepId));
  const step = entry?.instance.steps.find((candidate) => candidate.id === stepId);
  return entry && step ? { entry, step } : undefined;
};

const currentStepId = (steps: ReadonlyArray<ThreadWorkflowStepSummary>) =>
  steps.find((step) => step.state._tag === "open")?.id ?? null;

/** "step 4 of 9": position among the steps that are not removed. */
export const progress = (instance: Pick<ThreadWorkflowInstanceSummary, "steps">) => {
  const counted = instance.steps.filter((step) => step.state._tag !== "removed");
  const current = counted.findIndex((step) => step.state._tag === "open");
  return {
    total: counted.length,
    open: counted.filter((step) => step.state._tag === "open").length,
    currentPosition: current === -1 ? null : current + 1,
  };
};

/** Steps that count against the cap: open or done. A skipped or removed step has left the plan. */
export const plannedStepCount = (steps: ReadonlyArray<Pick<ThreadWorkflowStepSummary, "state">>) =>
  steps.filter((step) => step.state._tag === "open" || step.state._tag === "done").length;

const STEP_CAP_ADVICE = `A workflow holds at most ${THREAD_WORKFLOW_LIMITS.steps} steps that are not skipped or removed. Combine steps into outcomes at one level, and put detail in a comment on the current step instead.`;

const who = (stamp: ThreadWorkflowStamp) =>
  `${stamp.by._tag === "user" ? "the user" : "the agent"} at ${stamp.at}`;

const fail = (code: ThreadWorkflowErrorCode, message: string) =>
  new ThreadWorkflowError({ code, message });

/** sha256 of the request's canonical JSON (sorted keys), the identity a request id is bound to. */
const requestDigest = (request: ThreadWorkflowRequest): string =>
  NodeCrypto.createHash("sha256").update(canonicalJson(request)).digest("hex");

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export interface ResolvedTemplate {
  readonly template: ThreadWorkflowTemplate;
  readonly freshness: ThreadWorkflowTemplateFreshness;
}

export interface DecideContext {
  /** Binds a retry to its first result. The pane always sends one; agents may not. */
  readonly requestId: string | null;
  /** The pane's stale-view check. Agents may omit it. */
  readonly expectedRevision: number | null;
  /** `threadWorkflowsEnabled`. Off means no new instances; everything else keeps working. */
  readonly enabled: boolean;
  /** The thread is not settled, archived or deleted, read under the thread lock. */
  readonly threadActive: boolean;
  readonly templates: ReadonlyMap<ThreadWorkflowTemplateId, ResolvedTemplate>;
}

/** A change paired with its actor, so an agent tick without a comment cannot be built. */
export type PendingChange =
  | { readonly by: ThreadWorkflowUser; readonly event: typeof ThreadWorkflowUserEvent.Type }
  | { readonly by: ThreadWorkflowAgent; readonly event: typeof ThreadWorkflowAgentEvent.Type };

const isUserChange = (
  change: PendingChange,
): change is Extract<PendingChange, { readonly by: ThreadWorkflowUser }> =>
  change.by._tag === "user";

type SharedEvent = Exclude<ThreadWorkflowEvent, { readonly _tag: "ticked" | "recovered" }>;

export type Decision =
  | { readonly _tag: "changed"; readonly change: PendingChange }
  /** `replayed`: the request id already has a record; nothing new is written. */
  | { readonly _tag: "unchanged"; readonly replayed: boolean };

const changed = (actor: ThreadWorkflowActor, event: SharedEvent): Decision => ({
  _tag: "changed",
  change: actor._tag === "user" ? { by: actor, event } : { by: actor, event },
});
const UNCHANGED: Decision = { _tag: "unchanged", replayed: false };

export const decide = (
  state: ThreadWorkflowState,
  actor: ThreadWorkflowActor,
  request: ThreadWorkflowRequest,
  context: DecideContext,
): Decision | ThreadWorkflowError => {
  if (context.requestId !== null) {
    const receipt = state.receipts.get(context.requestId);
    if (receipt !== undefined) {
      return receipt.inputDigest === requestDigest(request)
        ? { _tag: "unchanged", replayed: true }
        : fail(
            "request_id_reused",
            `Request id "${context.requestId}" was already used for a different request (record ${receipt.seq}). Send this request with a new requestId.`,
          );
    }
  }
  if (request._tag === "recover") return decideRecover(state, actor, request.reason);
  if (state.corruption !== null) return fail("corrupt", corruptMessage(state.corruption));
  if (context.expectedRevision !== null && context.expectedRevision !== state.revision) {
    return fail(
      "revision_conflict",
      `The workflow changed since revision ${context.expectedRevision}; it is at revision ${state.revision}. Reload it and try again: ${printedCall.get()}`,
    );
  }
  switch (request._tag) {
    case "start":
      return decideStart(state, actor, request, context);
    case "tick":
      return decideTick(state, actor, request);
    case "skip":
      return decideStepChange(state, actor, request.stepId, "skipped", request.reason);
    case "remove":
      return decideStepChange(state, actor, request.stepId, "removed", request.reason);
    case "insert":
      return decideInsert(state, actor, request);
    case "reopen":
      return decideReopen(state, actor, request.target, request.reason, context);
    case "comment":
      return decideComment(state, actor, request);
    case "close":
      return decideClose(state, actor, request);
  }
};

const corruptMessage = (corruption: string) =>
  `This thread's workflow log cannot be trusted (${corruption}), so the workflow is read-only. The user can recover it from the Workflow tab on web or desktop.`;

const decideRecover = (
  state: ThreadWorkflowState,
  actor: ThreadWorkflowActor,
  reason: string,
): Decision | ThreadWorkflowError => {
  if (actor._tag !== "user") {
    return fail(
      "user_only",
      "Only the user can recover a workflow log, from the Workflow tab on web or desktop. Tell them what you saw.",
    );
  }
  if (state.corruption === null) {
    return fail(
      "not_corrupt",
      `This thread's workflow log is readable, so there is nothing to recover. To end an open workflow, close it instead.`,
    );
  }
  return {
    _tag: "changed",
    change: {
      by: actor,
      event: {
        _tag: "recovered",
        reason,
        corruption: state.corruption,
        nextInstanceNumber: state.nextInstanceNumber,
      },
    },
  };
};

const decideStart = (
  state: ThreadWorkflowState,
  actor: ThreadWorkflowActor,
  request: Extract<ThreadWorkflowRequest, { readonly _tag: "start" }>,
  context: DecideContext,
): Decision | ThreadWorkflowError => {
  const open = openInstance(state);
  // The plan is in the digest, so a start converges only on an instance an identical plan
  // started; a different plan meets `instance_open` below.
  if (open !== undefined && open.startDigest === requestDigest(request)) return UNCHANGED;
  if (!context.enabled) {
    return fail(
      "disabled",
      "Thread workflows are turned off on this server, so no new workflow can start. A workflow that is already open keeps working.",
    );
  }
  if (!context.threadActive) {
    return fail(
      "thread_not_active",
      "This thread is settled or archived, so a workflow cannot start on it. Unsettle or unarchive the thread first.",
    );
  }
  if (open !== undefined) {
    const { id, title } = open.instance;
    return fail(
      "instance_open",
      `Workflow "${title}" (${id}) is still open, and a thread holds one open workflow at a time. Finish it with ${printedCall.close(id, "finished")} once every step is done, skipped or removed, or abandon it with ${printedCall.close(id, "abandoned")}. Then start the new one.`,
    );
  }
  const resolved = context.templates.get(request.templateId);
  if (resolved === undefined) {
    const known = [...context.templates.keys()].map((id) => `"${id}"`).join(", ");
    return fail(
      "unknown_template",
      `No template "${request.templateId}". Templates: ${known}. Start one with ${printedCall.start([...context.templates.keys()][0] ?? "open-ended")}`,
    );
  }
  const { template, freshness } = resolved;
  const plan = request.steps ?? [];
  // A built-in template may carry more than the cap on its own; only a plan added to it is held to it.
  if (plan.length > 0 && plan.length + template.steps.length > THREAD_WORKFLOW_LIMITS.steps) {
    return fail(
      "too_many_steps",
      `${plan.length} planned steps plus the ${template.steps.length} the template "${template.id}" carries is more than ${THREAD_WORKFLOW_LIMITS.steps}. ${STEP_CAP_ADVICE}`,
    );
  }
  const instanceId = `w${state.nextInstanceNumber}` as ThreadWorkflowInstanceId;
  return changed(actor, {
    _tag: "started",
    instanceId,
    title: request.title ?? template.title,
    template: {
      id: template.id,
      version: template.version,
      source: template.source,
      staleAtStart: freshness === "stale",
    },
    steps: [...plan, ...template.steps].map((seed, index) => ({
      id: `${instanceId}.${index + 1}` as ThreadWorkflowStepId,
      ...seed,
    })),
    comment: request.comment ?? null,
  });
};

type Located =
  | { readonly entry: InstanceState; readonly step: ThreadWorkflowStep }
  | ThreadWorkflowError;

/** Finds a step on an open instance, or the refusal that names what to do instead. */
const locateEditableStep = (state: ThreadWorkflowState, stepId: ThreadWorkflowStepId): Located => {
  const found = findStep(state, stepId);
  if (found === undefined) {
    return fail(
      "unknown_step",
      `No step ${stepId} on this thread. See every step: ${printedCall.get()}`,
    );
  }
  const { status, id } = found.entry.instance;
  if (status._tag === "closed") {
    return fail(
      "instance_closed",
      `Workflow ${id} was ${status.outcome} by ${who(status.stamp)}. Reopen it first: ${printedCall.reopen(id)}`,
    );
  }
  return found;
};

const resolvedBy = (step: ThreadWorkflowStep) => {
  switch (step.state._tag) {
    case "open":
      return "open";
    case "done":
      return `ticked by ${who(step.state.stamp)}`;
    case "skipped":
      return `skipped by ${who(step.state.stamp)}: "${step.state.reason}"`;
    case "removed":
      return `removed by ${who(step.state.stamp)}: "${step.state.reason}"`;
  }
};

const decideTick = (
  state: ThreadWorkflowState,
  actor: ThreadWorkflowActor,
  request: Extract<ThreadWorkflowRequest, { readonly _tag: "tick" }>,
): Decision | ThreadWorkflowError => {
  const located = locateEditableStep(state, request.stepId);
  if (isThreadWorkflowError(located)) return located;
  const { step } = located;
  const proof = request.proof ?? null;
  let change: PendingChange;
  if (actor._tag === "user") {
    change = {
      by: actor,
      event: { _tag: "ticked", stepId: step.id, comment: request.comment ?? null, proof },
    };
  } else if (request.comment === undefined) {
    return fail(
      "comment_required",
      `A tick needs a comment saying what you did and how you know it worked: ${printedCall.tick(step)}`,
    );
  } else {
    change = {
      by: actor,
      event: { _tag: "ticked", stepId: step.id, comment: request.comment, proof },
    };
  }
  switch (step.state._tag) {
    case "done":
      return UNCHANGED;
    case "removed":
      return fail(
        "invalid_transition",
        `Step ${step.id} was ${resolvedBy(step)}. Reopen it before ticking: ${printedCall.reopen(step.id)}`,
      );
    case "open":
    case "skipped":
      return { _tag: "changed", change };
  }
};

const decideStepChange = (
  state: ThreadWorkflowState,
  actor: ThreadWorkflowActor,
  stepId: ThreadWorkflowStepId,
  to: "skipped" | "removed",
  reason: string,
): Decision | ThreadWorkflowError => {
  const located = locateEditableStep(state, stepId);
  if (isThreadWorkflowError(located)) return located;
  const { step } = located;
  if (step.state._tag === to) return UNCHANGED;
  const allowed = to === "skipped" ? step.state._tag === "open" : step.state._tag !== "done";
  if (!allowed) {
    const verb = to === "skipped" ? "skip" : "remove";
    return fail(
      "invalid_transition",
      `Step ${step.id} was ${resolvedBy(step)}, so it cannot ${verb} directly. Reopen it first: ${printedCall.reopen(step.id)}`,
    );
  }
  return changed(actor, { _tag: to, stepId, reason });
};

const decideInsert = (
  state: ThreadWorkflowState,
  actor: ThreadWorkflowActor,
  request: Extract<ThreadWorkflowRequest, { readonly _tag: "insert" }>,
): Decision | ThreadWorkflowError => {
  const anchor = request.afterStepId;
  let entry: InstanceState | undefined;
  if (typeof anchor === "string") {
    const located = locateEditableStep(state, anchor);
    if (isThreadWorkflowError(located)) return located;
    entry = located.entry;
  } else if (request.instanceId !== undefined) {
    entry = findInstance(state, request.instanceId);
    if (entry === undefined) {
      return fail(
        "unknown_instance",
        `No workflow ${request.instanceId} on this thread. See them all: ${printedCall.get()}`,
      );
    }
    if (entry.instance.status._tag === "closed") {
      return fail(
        "instance_closed",
        `Workflow ${entry.instance.id} was ${entry.instance.status.outcome} by ${who(entry.instance.status.stamp)}. Reopen it first: ${printedCall.reopen(entry.instance.id)}`,
      );
    }
  } else {
    entry = openInstance(state);
    if (entry === undefined) {
      return fail(
        "no_open_instance",
        `No workflow is open on this thread. Start one first: ${printedCall.start("open-ended")}`,
      );
    }
  }
  const { instance, nextStepNumber } = entry;
  if (plannedStepCount(instance.steps) >= THREAD_WORKFLOW_LIMITS.steps) {
    const target = instance.currentStepId ?? instance.id;
    return fail(
      "too_many_steps",
      actor._tag === "user"
        ? `This workflow already has ${THREAD_WORKFLOW_LIMITS.steps} stages. Combine two, or skip or remove one, before adding another.`
        : `Workflow ${instance.id} already holds ${THREAD_WORKFLOW_LIMITS.steps} steps that are not skipped or removed. ${STEP_CAP_ADVICE} ${printedCall.comment(target)}`,
    );
  }
  return changed(actor, {
    _tag: "inserted",
    instanceId: instance.id,
    step: { id: `${instance.id}.${nextStepNumber}` as ThreadWorkflowStepId, ...request.step },
    afterStepId: anchor === undefined ? (instance.steps.at(-1)?.id ?? null) : anchor,
    reason: request.reason,
  });
};

const decideReopen = (
  state: ThreadWorkflowState,
  actor: ThreadWorkflowActor,
  target: ThreadWorkflowTarget,
  reason: string,
  context: DecideContext,
): Decision | ThreadWorkflowError => {
  if (isStepId(target)) {
    const located = locateEditableStep(state, target);
    if (isThreadWorkflowError(located)) return located;
    if (located.step.state._tag === "open") return UNCHANGED;
    return changed(actor, { _tag: "reopened", target, reason });
  }
  const entry = findInstance(state, target);
  if (entry === undefined) {
    return fail(
      "unknown_instance",
      `No workflow ${target} on this thread. See them all: ${printedCall.get()}`,
    );
  }
  if (entry.instance.status._tag === "open") return UNCHANGED;
  const open = openInstance(state);
  if (open !== undefined) {
    const { id, title } = open.instance;
    return fail(
      "instance_open",
      `Workflow "${title}" (${id}) is open, and a thread holds one open workflow at a time. Close it first with ${printedCall.close(id, "finished")} or ${printedCall.close(id, "abandoned")}.`,
    );
  }
  if (!context.enabled) {
    return fail(
      "disabled",
      "Thread workflows are turned off on this server, so a closed workflow cannot reopen.",
    );
  }
  if (!context.threadActive) {
    return fail(
      "thread_not_active",
      "This thread is settled or archived, so a workflow cannot reopen on it. Unsettle or unarchive the thread first.",
    );
  }
  return changed(actor, { _tag: "reopened", target, reason });
};

const decideComment = (
  state: ThreadWorkflowState,
  actor: ThreadWorkflowActor,
  request: Extract<ThreadWorkflowRequest, { readonly _tag: "comment" }>,
): Decision | ThreadWorkflowError => {
  const exists = isStepId(request.target)
    ? findStep(state, request.target) !== undefined
    : findInstance(state, request.target) !== undefined;
  if (!exists) {
    return fail(
      isStepId(request.target) ? "unknown_step" : "unknown_instance",
      `Nothing named ${request.target} on this thread. See every workflow and step: ${printedCall.get()}`,
    );
  }
  return changed(actor, {
    _tag: "commented",
    target: request.target,
    comment: request.comment,
    proof: request.proof ?? null,
  });
};

const decideClose = (
  state: ThreadWorkflowState,
  actor: ThreadWorkflowActor,
  request: Extract<ThreadWorkflowRequest, { readonly _tag: "close" }>,
): Decision | ThreadWorkflowError => {
  const entry = findInstance(state, request.instanceId);
  if (entry === undefined) {
    return fail(
      "unknown_instance",
      `No workflow ${request.instanceId} on this thread. See them all: ${printedCall.get()}`,
    );
  }
  const { instance } = entry;
  if (instance.status._tag === "closed") {
    if (instance.status.outcome === request.outcome) return UNCHANGED;
    return fail(
      "invalid_transition",
      `Workflow ${instance.id} was already ${instance.status.outcome} by ${who(instance.status.stamp)}. Reopen it first: ${printedCall.reopen(instance.id)}`,
    );
  }
  if (request.outcome === "finished") {
    const open = instance.steps.filter((step) => step.state._tag === "open");
    if (open.length > 0) {
      return fail(
        "steps_unresolved",
        [
          `${open.map((step) => step.id).join(", ")} ${open.length === 1 ? "is" : "are"} open, so ${instance.id} cannot finish. Tick each, or skip it with a reason:`,
          ...open.map((step) => printedCall.skip(step.id)),
          `Or abandon the workflow: ${printedCall.close(instance.id, "abandoned")}`,
        ].join("\n"),
      );
    }
  }
  return changed(actor, {
    _tag: "closed",
    instanceId: instance.id,
    outcome: request.outcome,
    reason: request.reason,
  });
};

/**
 * The instance a request acted on, read from the state after it applied; null for a recovery.
 * A start or an unanchored insert acts on whichever instance was open when it was recorded, so a
 * replay reads that from its receipt, not from what is open now.
 */
export const instanceActedOn = (
  state: ThreadWorkflowState,
  request: ThreadWorkflowRequest,
  requestId: string | null,
): ThreadWorkflowInstanceId | null => {
  const openWhenRecorded = () => {
    const receipt = requestId === null ? undefined : state.receipts.get(requestId);
    return receipt === undefined ? (openInstance(state)?.instance.id ?? null) : receipt.instanceId;
  };
  switch (request._tag) {
    case "start":
      return openWhenRecorded();
    case "tick":
    case "skip":
    case "remove":
      return instanceIdOfStep(request.stepId);
    case "reopen":
    case "comment":
      return isStepId(request.target) ? instanceIdOfStep(request.target) : request.target;
    case "insert":
      return typeof request.afterStepId === "string"
        ? instanceIdOfStep(request.afterStepId)
        : (request.instanceId ?? openWhenRecorded());
    case "close":
      return request.instanceId;
    case "recover":
      return null;
  }
};

/**
 * The record a decision writes, or null when nothing is written: a replay, or a convergent
 * request with no request id to bind.
 */
export const recordFor = (
  state: ThreadWorkflowState,
  actor: ThreadWorkflowActor,
  request: ThreadWorkflowRequest,
  decision: Decision,
  input: { readonly requestId: string | null; readonly at: string },
): ThreadWorkflowRecord | null => {
  const inputDigest = requestDigest(request);
  if (decision._tag === "unchanged") {
    if (decision.replayed || input.requestId === null) return null;
    const receipt: ThreadWorkflowReceiptRecord = {
      v: 1,
      seq: (state.lastSeq + 1) as ThreadWorkflowSeq,
      at: input.at,
      kind: "receipt",
      by: actor,
      requestId: input.requestId,
      inputDigest,
    };
    return receipt;
  }
  // A recovery starts a fresh log, so its record is the first line.
  const seq = (
    decision.change.event._tag === "recovered" ? 1 : state.lastSeq + 1
  ) as ThreadWorkflowSeq;
  const fields = {
    v: 1,
    seq,
    at: input.at,
    kind: "change",
    requestId: input.requestId,
    inputDigest,
  } as const;
  const { change } = decision;
  const record: ThreadWorkflowChangeRecord = isUserChange(change)
    ? { ...fields, by: change.by, event: change.event }
    : { ...fields, by: change.by, event: change.event };
  return record;
};

export const evolve = (
  state: ThreadWorkflowState,
  record: ThreadWorkflowRecord,
): ThreadWorkflowState => {
  if (record.kind === "receipt") {
    return {
      ...state,
      lastSeq: record.seq,
      receipts: withReceipt(
        state.receipts,
        record.requestId,
        record,
        openInstance(state)?.instance.id ?? null,
      ),
    };
  }
  const { event } = record;
  if (event._tag === "recovered") {
    return {
      ...emptyState(state.threadId),
      lastSeq: record.seq,
      revision: record.seq,
      lastActivityAt: record.at,
      nextInstanceNumber: event.nextInstanceNumber,
      receipts:
        record.requestId === null
          ? new Map()
          : withReceipt(new Map(), record.requestId, record, null),
    };
  }
  const base: ThreadWorkflowState = {
    ...state,
    lastSeq: record.seq,
    revision: record.seq,
    lastActivityAt: record.at,
    receipts:
      record.requestId === null
        ? state.receipts
        : withReceipt(
            state.receipts,
            record.requestId,
            record,
            event._tag === "started" ? event.instanceId : instanceIdOfEvent(event),
          ),
  };
  const stamp: ThreadWorkflowStamp = { seq: record.seq, at: record.at, by: record.by };

  if (event._tag === "started") {
    const instance: ThreadWorkflowInstance = {
      id: event.instanceId,
      title: event.title,
      template: event.template,
      status: { _tag: "open" },
      currentStepId: event.steps[0]?.id ?? null,
      started: stamp,
      lastChangeAt: record.at,
      steps: event.steps.map((step) => ({
        ...step,
        origin: { _tag: "template" },
        state: { _tag: "open" },
        history: [],
      })),
      history: [record],
    };
    return {
      ...base,
      nextInstanceNumber: Math.max(state.nextInstanceNumber, numberOf(event.instanceId) + 1),
      instances: [
        ...state.instances,
        {
          instance,
          nextStepNumber: Math.max(1, ...event.steps.map((step) => numberOf(step.id) + 1)),
          startDigest: record.inputDigest,
        },
      ],
    };
  }

  const instanceId = instanceIdOfEvent(event);
  const entry = findInstance(state, instanceId);
  // Unreachable for a log decide wrote; evolve stays total rather than throwing on a hand edit.
  if (entry === undefined) return base;
  const updated = applyToInstance(entry, event, stamp, record);
  return {
    ...base,
    instances: state.instances.map((candidate) => (candidate === entry ? updated : candidate)),
  };
};

/**
 * Why `record` is not a legal next record for `state`, or null. The aggregate invariants `decide`
 * keeps, checked on a record instead of a request, so a log that was hand-edited, merged or written
 * by a build with a different policy folds as corrupt instead of as a state `decide` would never
 * have produced. Worded to follow "line N of its log".
 */
export const admits = (state: ThreadWorkflowState, record: ThreadWorkflowRecord): string | null => {
  if (record.requestId !== null && state.receipts.has(record.requestId)) {
    return `reuses request id "${record.requestId}"`;
  }
  if (record.kind === "receipt") return null;
  const { event } = record;
  const open = openInstance(state);
  switch (event._tag) {
    case "recovered":
      // A recovery starts a fresh log or replaces a corrupt one, never a readable one's middle.
      return state.lastSeq === 0 || state.corruption !== null ? null : "recovers mid-log";
    case "started": {
      if (findInstance(state, event.instanceId) !== undefined) {
        return `starts ${event.instanceId}, which already exists`;
      }
      if (open !== undefined) {
        return `starts ${event.instanceId} while ${open.instance.id} is open`;
      }
      const stepIds = new Set(event.steps.map((step) => step.id));
      if (
        stepIds.size !== event.steps.length ||
        event.steps.some((step) => instanceIdOfStep(step.id) !== event.instanceId)
      ) {
        return `starts ${event.instanceId} with step ids that are not its own or repeat`;
      }
      return null;
    }
    case "ticked":
    case "skipped":
    case "removed": {
      const found = findStep(state, event.stepId);
      if (found === undefined) return `changes ${event.stepId}, which does not exist`;
      if (found.entry.instance.status._tag === "closed") {
        return `changes ${event.stepId} on closed ${found.entry.instance.id}`;
      }
      const from = found.step.state._tag;
      const legal =
        event._tag === "ticked"
          ? from === "open" || from === "skipped"
          : event._tag === "skipped"
            ? from === "open"
            : from !== "done" && from !== "removed";
      return legal ? null : `moves ${event.stepId} from ${from} to ${event._tag}`;
    }
    case "inserted": {
      const entry = findInstance(state, event.instanceId);
      if (entry === undefined) return `inserts into ${event.instanceId}, which does not exist`;
      if (entry.instance.status._tag === "closed") {
        return `inserts into ${event.instanceId}, which is closed`;
      }
      const { steps } = entry.instance;
      if (
        instanceIdOfStep(event.step.id) !== event.instanceId ||
        steps.some((step) => step.id === event.step.id)
      ) {
        return `inserts ${event.step.id}, an id ${event.instanceId} cannot take`;
      }
      if (event.afterStepId !== null && !steps.some((step) => step.id === event.afterStepId)) {
        return `inserts after ${event.afterStepId}, which does not exist`;
      }
      return null;
    }
    case "commented": {
      const exists = isStepId(event.target)
        ? findStep(state, event.target) !== undefined
        : findInstance(state, event.target) !== undefined;
      return exists ? null : `comments on ${event.target}, which does not exist`;
    }
    case "reopened": {
      if (isStepId(event.target)) {
        const found = findStep(state, event.target);
        if (found === undefined) return `reopens ${event.target}, which does not exist`;
        if (found.entry.instance.status._tag === "closed") {
          return `reopens ${event.target} on closed ${found.entry.instance.id}`;
        }
        return found.step.state._tag === "open" ? `reopens ${event.target}, which is open` : null;
      }
      const entry = findInstance(state, event.target);
      if (entry === undefined) return `reopens ${event.target}, which does not exist`;
      if (entry.instance.status._tag === "open") return `reopens ${event.target}, which is open`;
      return open === undefined
        ? null
        : `reopens ${event.target} while ${open.instance.id} is open`;
    }
    case "closed": {
      const entry = findInstance(state, event.instanceId);
      if (entry === undefined) return `closes ${event.instanceId}, which does not exist`;
      if (entry.instance.status._tag === "closed") {
        return `closes ${event.instanceId}, which is already closed`;
      }
      const openSteps = entry.instance.steps.filter((step) => step.state._tag === "open");
      return event.outcome === "finished" && openSteps.length > 0
        ? `finishes ${event.instanceId} with ${openSteps.map((step) => step.id).join(", ")} open`
        : null;
    }
  }
};

const withReceipt = (
  receipts: ReadonlyMap<string, Receipt>,
  requestId: string,
  record: ThreadWorkflowRecord,
  instanceId: ThreadWorkflowInstanceId | null,
): ReadonlyMap<string, Receipt> =>
  new Map(receipts).set(requestId, {
    inputDigest: record.inputDigest,
    seq: record.seq,
    instanceId,
  });

const instanceIdOfEvent = (
  event: Exclude<ThreadWorkflowEvent, { readonly _tag: "started" | "recovered" }>,
): ThreadWorkflowInstanceId => {
  switch (event._tag) {
    case "ticked":
    case "skipped":
    case "removed":
      return instanceIdOfStep(event.stepId);
    case "inserted":
    case "closed":
      return event.instanceId;
    case "commented":
    case "reopened":
      return isStepId(event.target) ? instanceIdOfStep(event.target) : event.target;
  }
};

const applyToInstance = (
  entry: InstanceState,
  event: Exclude<ThreadWorkflowEvent, { readonly _tag: "started" | "recovered" }>,
  stamp: ThreadWorkflowStamp,
  record: ThreadWorkflowChangeRecord,
): InstanceState => {
  const { instance } = entry;
  const touched = (
    next: Partial<ThreadWorkflowInstance>,
    nextStepNumber = entry.nextStepNumber,
  ) => {
    const steps = next.steps ?? instance.steps;
    return {
      ...entry,
      nextStepNumber,
      instance: {
        ...instance,
        ...next,
        steps,
        currentStepId: currentStepId(steps),
        lastChangeAt: stamp.at,
      },
    };
  };
  const onStep = (stepId: ThreadWorkflowStepId, change: Partial<ThreadWorkflowStep>) =>
    touched({
      steps: instance.steps.map((step) =>
        step.id === stepId ? { ...step, ...change, history: [...step.history, record] } : step,
      ),
    });
  const onInstance = (next: Partial<ThreadWorkflowInstance>) =>
    touched({ ...next, history: [...instance.history, record] });

  switch (event._tag) {
    case "ticked":
      return onStep(event.stepId, {
        state: { _tag: "done", stamp, comment: event.comment, proof: event.proof },
      });
    case "skipped":
      return onStep(event.stepId, { state: { _tag: "skipped", stamp, reason: event.reason } });
    case "removed":
      return onStep(event.stepId, { state: { _tag: "removed", stamp, reason: event.reason } });
    case "inserted": {
      const step: ThreadWorkflowStep = {
        ...event.step,
        origin: { _tag: "inserted", stamp, reason: event.reason },
        state: { _tag: "open" },
        history: [],
      };
      const anchor = instance.steps.findIndex((candidate) => candidate.id === event.afterStepId);
      const steps = [...instance.steps];
      steps.splice(
        event.afterStepId === null ? 0 : anchor === -1 ? steps.length : anchor + 1,
        0,
        step,
      );
      return touched(
        { steps, history: [...instance.history, record] },
        Math.max(entry.nextStepNumber, numberOf(event.step.id) + 1),
      );
    }
    case "commented":
      return isStepId(event.target) ? onStep(event.target, {}) : onInstance({});
    case "reopened":
      return isStepId(event.target)
        ? onStep(event.target, { state: { _tag: "open" } })
        : onInstance({ status: { _tag: "open" } });
    case "closed":
      return onInstance({
        status: { _tag: "closed", outcome: event.outcome, stamp, reason: event.reason },
      });
  }
};

export type LifecycleAction = "settle" | "archive" | "delete";

const cannot: Record<LifecycleAction, string> = {
  settle: "cannot settle",
  archive: "cannot be archived",
  delete: "cannot be deleted",
};

/**
 * Why the thread may not leave active work, or null. Feeds `ThreadHooks.lifecycleBlocker`. Only a
 * valid open instance blocks: a corrupt log never does, so unreadable state cannot trap a thread.
 */
export const lifecycleBlocker = (
  state: ThreadWorkflowState,
  action: LifecycleAction,
): string | null => {
  if (state.corruption !== null) return null;
  const open = openInstance(state);
  if (open === undefined) return null;
  const { id, title } = open.instance;
  const { open: openSteps, total } = progress(open.instance);
  return `This thread has an open workflow "${title}" (${id}, ${openSteps} of ${total} steps open), so it ${cannot[action]}. Finish it with ${printedCall.close(id, "finished")} once every step is done, skipped or removed, or abandon it with ${printedCall.close(id, "abandoned")}. Do either from the Workflow tab on web or desktop, or ask the agent.`;
};
