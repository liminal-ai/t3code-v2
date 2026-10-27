import {
  THREAD_WORKFLOW_LIMITS,
  type ThreadWorkflowInstanceSummary,
  type ThreadWorkflowStepSummary,
  type ThreadWorkflowSubscriptionView,
} from "@t3tools/contracts";

import { printedCall, progress } from "./domain.ts";

export const WAITS_FOR_USER =
  "This step ends with the user's decision. Ask them in chat, and tick it with their answer quoted.";
const CUT_SUFFIX = " … (cut to fit; thread_workflow_get has the whole step)";

export type TurnNoteForm = "full" | "short";

const proofLine = (step: ThreadWorkflowStepSummary) =>
  step.proofLevel === "none"
    ? null
    : `Proof wanted (${step.proofLevel}): ${step.proofHint ?? "attach whatever evidence you have"}.`;

const position = (instance: ThreadWorkflowInstanceSummary, step: ThreadWorkflowStepSummary) => {
  const { currentPosition, total } = progress(instance);
  return `step ${currentPosition} of ${total}: ${step.slug} (${step.id})`;
};

const fullLines = (
  instance: ThreadWorkflowInstanceSummary,
  step: ThreadWorkflowStepSummary,
  instructions: string,
) => [
  `Workflow "${instance.title}" (${instance.id}), ${position(instance, step)}`,
  step.title,
  instructions,
  proofLine(step),
  step.waitsForUser ? WAITS_FOR_USER : null,
  `Done: ${printedCall.tick(step)}`,
];

const shortLines = (instance: ThreadWorkflowInstanceSummary, step: ThreadWorkflowStepSummary) => [
  `Workflow ${instance.id}, ${position(instance, step)}`,
];

// No step is open here, so the cap on open steps never stops the insert.
const closeLines = (instance: ThreadWorkflowInstanceSummary) => [
  `Workflow "${instance.title}" (${instance.id}): every step is done, skipped or removed.`,
  "Close it:",
  printedCall.close(instance.id, "finished"),
  "If the work is not finished, insert the step it still needs:",
  printedCall.insert(instance.steps.at(-1)?.id),
];

const wrap = (lines: ReadonlyArray<string | null>) =>
  ["<thread-workflow>", ...lines, "</thread-workflow>"].filter((line) => line !== null).join("\n");

/** The first `keep` code units, never half a surrogate pair, then the cut suffix. */
const cut = (text: string, keep: number) => {
  const head = text.slice(0, Math.max(keep, 0));
  const kept = /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
  return `${kept.trimEnd()}${CUT_SUFFIX}`.trimStart();
};

const activeInstance = (view: ThreadWorkflowSubscriptionView) =>
  view.instances.find((candidate) => candidate.id === view.activeInstanceId);

export const openStep = (view: ThreadWorkflowSubscriptionView) => {
  const instance = activeInstance(view);
  const step = instance?.steps.find((candidate) => candidate.id === instance.currentStepId);
  return instance === undefined || step === undefined ? null : { instance, step };
};

export const noWorkflowNote = () =>
  wrap([
    `No workflow is open on this thread. Before task work, pick the playbook and start its workflow: ${printedCall.start("<template>")}. Templates: ${printedCall.get()}. Discussion and status replies need none.`,
  ]);

/**
 * The `<thread-workflow>` prefix for a turn, or "" with no instance open. The schema caps on
 * titles, instructions and hints keep the full form under 2,000 characters, except that the
 * printed tick call JSON-escapes the proof hint (a control character becomes six). When that puts
 * the note over, the instructions are cut to fit; a printed call is never cut.
 */
export const turnNote = (view: ThreadWorkflowSubscriptionView, form: TurnNoteForm): string => {
  if (view.corruption !== null) {
    return wrap([
      `This thread's workflow log cannot be trusted (${view.corruption}), so its workflow is read-only and does not hold the thread open. Ask the user to recover it from the Workflow tab on web or desktop.`,
    ]);
  }
  const instance = activeInstance(view);
  if (instance === undefined) return "";
  const step = instance.steps.find((candidate) => candidate.id === instance.currentStepId);
  if (step === undefined) return wrap(closeLines(instance));
  if (form === "short") return wrap(shortLines(instance, step));
  const full = wrap(fullLines(instance, step, step.instructions));
  const over = full.length - THREAD_WORKFLOW_LIMITS.turnNote;
  if (over <= 0) return full;
  const keep = step.instructions.length - over - CUT_SUFFIX.length;
  return wrap(fullLines(instance, step, cut(step.instructions, keep)));
};
