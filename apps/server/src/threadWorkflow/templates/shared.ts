import type { ThreadWorkflowStepSeed } from "@t3tools/contracts";

type Step = (typeof ThreadWorkflowStepSeed)["Encoded"];

export const RUN_FOLDER =
  "Make the run folder `<project>/.pstack/runs/<run>/` with `scratch/` and `proof/`, and take the before snapshot per `~/.agents/skills/poteto-mode/references/cleanup-protocol.md`.";

const MERGE_GATE = "~/.agents/skills/poteto-mode/scripts/merge-gate/merge-gate";

export const findVerifySkill: Step = {
  title: "Verify skill named and run folder made",
  slug: "find-verify-skill",
  instructions: `Find the project's verify skill, \`.agents/skills/verify-<app>/\` in the repo or the one the project's instructions name, and name it in a comment on this step. If the project has none, say so, use \`control-ui\` or \`control-cli\` in its place, and carry \`/create-verification-skill\` to close-out as owed work. ${RUN_FOLDER}`,
  proofLevel: "required",
  proofHint: "the verify skill's path, or that the project has none",
  waitsForUser: false,
};

export const mergeThroughGate = (extra?: string): Step => ({
  title: "PR merged through the gate",
  slug: "merge-through-gate",
  instructions: [
    "Run Opening a PR and link it with link_pull_request.",
    "A verifier on the counterpart of the author's model family, never the author, drives the change through the project's verify skill, covers `.agents/merge-brief.md`, and posts `pstack-verdict:` on the PR.",
    `Merge only with \`${MERGE_GATE} --repo <owner/name> --pr <n>\`, adding \`--method merge\` where the repo requires merge commits and \`--plan\` with \`--plan-pr\` when a plan covers the PR.`,
    extra,
  ]
    .filter((sentence) => sentence !== undefined)
    .join(" "),
  proofLevel: "required",
  proofHint: "the PR URL, the verdict line and the merge SHA",
  waitsForUser: false,
});

const closeOut: Step = {
  title: "Owed work filed as grouped tickets",
  slug: "close-out-tickets",
  instructions:
    "Read the open tickets in the Linear project the repo's AGENTS.md names, then file what is owed, including any `/create-verification-skill` the first step carried, as a few tickets grouped by body of work, never one per item. Add to a grouped ticket that already covers the work. Record each ticket id where the run keeps its decisions. With nothing owed, skip with that reason.",
  proofLevel: "recommended",
  proofHint: "the ticket ids",
  waitsForUser: false,
};

export const reflectAndUpkeep: Step = {
  title: "Thread reflected and verify skill kept current",
  slug: "reflect-and-upkeep",
  instructions:
    "A thread that merged changes to a project or ran across sessions runs `/reflect`, then `/maintain-verification-skill` scoped to the gaps the thread exposed, updating the project's verify skill and `.agents/merge-brief.md` in one PR through the merge gate. pstack itself changes only in a retro round. A thread that neither merged changes nor ran across sessions may skip with that reason.",
  proofLevel: "recommended",
  proofHint: "the reflect path and the upkeep PR URL, or the skip reason",
  waitsForUser: false,
};

export const cleanup: Step = {
  title: "Run cleaned up",
  slug: "cleanup",
  instructions:
    "Run the cleanup protocol in `~/.agents/skills/poteto-mode/references/cleanup-protocol.md`. A cleanup agent reviews the whole thread and every subagent's thread, the run folder, the diff against the before snapshot, and the code changes. It keeps cited proof, removes what is clearly from the run, and lists the rest for you. Remove or check what you can, and put only what you cannot settle in front of the user.",
  proofLevel: "required",
  proofHint: "the cleanup report's path",
  waitsForUser: false,
};

export const closingSteps = [closeOut, reflectAndUpkeep, cleanup];
