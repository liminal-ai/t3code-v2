import type {
  ThreadWorkflowInstanceSummary,
  ThreadWorkflowStepSummary,
  ThreadWorkflowSubscriptionView,
} from "@t3tools/contracts";

import { printedCall, progress } from "./domain.ts";

const LIFECYCLE_RULE =
  "This thread cannot settle, archive or be deleted while the workflow is open.";

const proofLine = (step: ThreadWorkflowStepSummary) =>
  step.proofLevel === "none"
    ? null
    : `Proof wanted (${step.proofLevel}): ${step.proofHint ?? "attach whatever evidence you have"}.`;

const header = (instance: ThreadWorkflowInstanceSummary) =>
  `Workflow "${instance.title}" (${instance.id}, template ${instance.template.id})`;

const stepLines = (instance: ThreadWorkflowInstanceSummary, step: ThreadWorkflowStepSummary) => {
  const { currentPosition, total } = progress(instance);
  return [
    `${header(instance)}, step ${currentPosition} of ${total}: ${step.title}`,
    step.instructions,
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

/**
 * The `<thread-workflow>` prefix for a turn: the full current step every turn, so no delivery
 * state can go wrong across retries, provider switches or compaction. Empty when no instance is
 * open. Schema caps on titles, instructions and hints keep it under 2,000 characters.
 */
export const turnNote = (view: ThreadWorkflowSubscriptionView): string => {
  if (view.corruption !== null) {
    return [
      "<thread-workflow>",
      `This thread's workflow log cannot be trusted (${view.corruption}), so the thread cannot settle, archive or be deleted. Ask the user to recover it from the Workflow tab on web or desktop.`,
      "</thread-workflow>",
    ].join("\n");
  }
  const instance = view.instances.find((candidate) => candidate.id === view.activeInstanceId);
  if (instance === undefined) return "";
  const step = instance.steps.find((candidate) => candidate.id === instance.currentStepId);
  return [
    "<thread-workflow>",
    ...(step === undefined ? closeLines(instance) : stepLines(instance, step)),
    `Whole workflow: ${printedCall.get()}`,
    LIFECYCLE_RULE,
    "</thread-workflow>",
  ]
    .filter((line) => line !== null)
    .join("\n");
};
