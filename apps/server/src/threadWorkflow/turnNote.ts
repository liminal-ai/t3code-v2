import {
  THREAD_WORKFLOW_LIMITS,
  type ThreadWorkflowInstanceSummary,
  type ThreadWorkflowStepSummary,
  type ThreadWorkflowSubscriptionView,
} from "@t3tools/contracts";

import { printedCall, progress } from "./domain.ts";

const LIFECYCLE_RULE =
  "This thread cannot settle, archive or be deleted while the workflow is open.";
const CUT_MARK = "… (cut to fit; thread_workflow_get has the whole step)";

const proofLine = (step: ThreadWorkflowStepSummary) =>
  step.proofLevel === "none"
    ? null
    : `Proof wanted (${step.proofLevel}): ${step.proofHint ?? "attach whatever evidence you have"}.`;

const header = (instance: ThreadWorkflowInstanceSummary) =>
  `Workflow "${instance.title}" (${instance.id}, template ${instance.template.id})`;

const stepLines = (
  instance: ThreadWorkflowInstanceSummary,
  step: ThreadWorkflowStepSummary,
  instructions: string,
) => {
  const { currentPosition, total } = progress(instance);
  return [
    `${header(instance)}, step ${currentPosition} of ${total}: ${step.title}`,
    instructions,
    proofLine(step),
    step.waitsForUser
      ? "This step waits for the user. Ask once with your question tool, then tick it with their answer in the comment."
      : null,
    "When it is done, tick it:",
    printedCall.tick(step),
    "If it should not be done, skip it with the reason your intent changed:",
    printedCall.skip(step.id),
  ];
};

const closeLines = (instance: ThreadWorkflowInstanceSummary) => [
  `${header(instance)}: every step is done, skipped or removed.`,
  "Close it:",
  printedCall.close(instance.id, "finished"),
  "If the work is not finished, insert the step it still needs:",
  printedCall.insert(instance.steps.at(-1)?.id),
];

const note = (lines: ReadonlyArray<string | null>) =>
  [
    "<thread-workflow>",
    ...lines,
    `Whole workflow: ${printedCall.get()}`,
    LIFECYCLE_RULE,
    "</thread-workflow>",
  ]
    .filter((line) => line !== null)
    .join("\n");

/** The first `keep` code units, never half a surrogate pair, then the cut mark. */
const cut = (text: string, keep: number) => {
  const head = text.slice(0, Math.max(keep, 0));
  const kept = /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
  return [kept.trimEnd(), CUT_MARK].filter((part) => part !== "").join(" ");
};

/**
 * The `<thread-workflow>` prefix for a turn: the full current step every turn, so no delivery
 * state can go wrong across retries, provider switches or compaction. Empty when no instance is
 * open. The schema caps on titles, instructions and hints keep it under 2,000 characters, except
 * that the printed tick call JSON-escapes the proof hint (a control character becomes six). When
 * that puts the note over, the instructions are cut to fit; a printed call is never cut.
 */
export const turnNote = (view: ThreadWorkflowSubscriptionView): string => {
  if (view.corruption !== null) {
    return [
      "<thread-workflow>",
      `This thread's workflow log cannot be trusted (${view.corruption}), so its workflow is read-only and does not hold the thread open. Ask the user to recover it from the Workflow tab on web or desktop.`,
      "</thread-workflow>",
    ].join("\n");
  }
  const instance = view.instances.find((candidate) => candidate.id === view.activeInstanceId);
  if (instance === undefined) return "";
  const step = instance.steps.find((candidate) => candidate.id === instance.currentStepId);
  if (step === undefined) return note(closeLines(instance));
  const full = note(stepLines(instance, step, step.instructions));
  const over = full.length - THREAD_WORKFLOW_LIMITS.turnNote;
  if (over <= 0) return full;
  const keep = step.instructions.length - over - CUT_MARK.length - " ".length;
  return note(stepLines(instance, step, cut(step.instructions, keep)));
};
