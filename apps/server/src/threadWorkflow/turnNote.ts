import {
  THREAD_WORKFLOW_LIMITS,
  type ThreadWorkflowInstanceSummary,
  type ThreadWorkflowQuestionSummary,
  type ThreadWorkflowStepSummary,
  type ThreadWorkflowSubscriptionView,
} from "@t3tools/contracts";

import { openQuestions, printedCall, progress } from "./domain.ts";

export const WAITS_FOR_USER = `This step ends with the user's decision. Ask on the workflow: ${printedCall.ask()} and tick it once they answer.`;
const CUT_SUFFIX = " … (cut to fit; thread_workflow_get has the whole step)";
const LISTED_QUESTIONS = 5;
const MIN_LISTED_TITLE = 24;

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

/** The first `keep` code units, never half a surrogate pair. */
const head = (text: string, keep: number) => {
  const kept = text.slice(0, Math.max(keep, 0));
  return /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept;
};

const cut = (text: string, keep: number) =>
  `${head(text, keep).trimEnd()}${CUT_SUFFIX}`.trimStart();

const clip = (text: string, keep: number) =>
  text.length <= keep ? text : `${head(text, keep - 1).trimEnd()}…`;

const questionsLine = (
  questions: ReadonlyArray<ThreadWorkflowQuestionSummary>,
  titleLength: number,
) => {
  if (questions.length === 0) return null;
  const listed = questions
    .slice(0, LISTED_QUESTIONS)
    .map((question) => `${question.id} ${clip(question.title, titleLength)}`)
    .join(" · ");
  const more = questions.length - LISTED_QUESTIONS;
  return `Open questions (${questions.length}): ${listed}${more > 0 ? ` · and ${more} more` : ""}`;
};

/** The widest listed title, down to the floor, at which `note` is within the cap. */
const widestTitleThatFits = (note: (titleLength: number) => string, longestTitle: number) => {
  let low = Math.min(MIN_LISTED_TITLE, longestTitle);
  let high = longestTitle;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (note(middle).length <= THREAD_WORKFLOW_LIMITS.turnNote) low = middle;
    else high = middle - 1;
  }
  return low;
};

const cutToFit = (instructions: string, over: number) =>
  cut(instructions, instructions.length - over - CUT_SUFFIX.length);

/** The note from `lines`, within the cap: clip the listed titles first, then cut the instructions. */
const fitted = (
  lines: (titleLength: number, instructions: string) => ReadonlyArray<string | null>,
  questions: ReadonlyArray<ThreadWorkflowQuestionSummary>,
  instructions: string,
) => {
  const longestTitle = Math.max(0, ...questions.map((question) => question.title.length));
  const note = (titleLength: number) => wrap(lines(titleLength, instructions));
  const full = note(longestTitle);
  if (full.length <= THREAD_WORKFLOW_LIMITS.turnNote) return full;
  const titleLength = widestTitleThatFits(note, longestTitle);
  const clipped = note(titleLength);
  const over = clipped.length - THREAD_WORKFLOW_LIMITS.turnNote;
  if (over <= 0) return clipped;
  return wrap(lines(titleLength, cutToFit(instructions, over)));
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
 * The `<thread-workflow>` prefix for a turn, or "" with no instance open. Schema caps keep it under
 * 2,000 characters unless JSON-escaping the proof hint in the printed tick call pushes it over;
 * then question titles are clipped, then the instructions cut. A printed call is never cut.
 */
export const turnNote = (view: ThreadWorkflowSubscriptionView, form: TurnNoteForm): string => {
  if (view.corruption !== null) {
    return wrap([
      `This thread's workflow log cannot be trusted (${view.corruption}), so its workflow is read-only and does not hold the thread open. Ask the user to recover it from the Workflow tab on web or desktop.`,
    ]);
  }
  const instance = activeInstance(view);
  if (instance === undefined) return "";
  const questions = openQuestions(instance);
  const step = instance.steps.find((candidate) => candidate.id === instance.currentStepId);
  if (step === undefined) {
    return fitted(
      (titleLength) => [...closeLines(instance), questionsLine(questions, titleLength)],
      questions,
      "",
    );
  }
  if (form === "short") {
    return fitted(
      (titleLength) => [...shortLines(instance, step), questionsLine(questions, titleLength)],
      questions,
      "",
    );
  }
  return fitted(
    (titleLength, instructions) => [
      ...fullLines(instance, step, instructions),
      questionsLine(questions, titleLength),
    ],
    questions,
    step.instructions,
  );
};
