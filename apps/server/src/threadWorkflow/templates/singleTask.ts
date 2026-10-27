import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Derived from the Feature playbook; steps 9 and 10 also draw on Opening a PR. */
export const singleTask = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "single-task",
  version: 1,
  title: "Single task",
  description:
    "One feature, bug fix or refactor delivered as one PR, from grounding through merge.",
  source: {
    playbook: "poteto-mode/playbooks/feature.md",
    commit: "60a54dcd305a321c839bbdf3bd2b5380f501f527",
    sha256: "ae090c9db6298710fdc982f23ae59370af2da90265d56fc45f30858515fb9c40",
  },
  steps: [
    {
      title: "Ground the affected subsystem",
      slug: "ground-subsystem",
      instructions:
        "Run the how skill over the code this change touches, so the design starts from how it works today, not from a guess.",
      proofLevel: "recommended",
      proofHint: "the write-up path or a short summary",
      waitsForUser: false,
    },
    {
      title: "Design the data shape",
      slug: "design-data-shape",
      instructions:
        "Name the data shape and its organizing structure before any logic. Run the architect skill for parallel design exploration. For a one-file change, skip with that reason.",
      proofLevel: "recommended",
      proofHint: "the design directory or the named shape",
      waitsForUser: false,
    },
    {
      title: "Talk it through with the user",
      slug: "talk-it-through",
      instructions:
        "If the work decides what the data is, writes text in the user's voice (rules, skills, prompts), or changes who can do what, talk it through with the user before building. If it does none of these, skip this step and say so.",
      proofLevel: "required",
      proofHint: "the user's answer, quoted",
      waitsForUser: true,
    },
    {
      title: "Write the throughput checkpoint",
      slug: "throughput-checkpoint",
      instructions:
        "Write four items: blocking first steps, independent workstreams, shared mutable state, smallest safe decomposition. Keep a dimension that does not apply as n/a with the reason.",
      proofLevel: "preferred",
      proofHint: "the checkpoint text",
      waitsForUser: false,
    },
    {
      title: "Delegate the implementation",
      slug: "delegate-implementation",
      instructions:
        "Hand the code to a subagent on your feature model with file paths, the named data shape and success criteria. Use arena when the code admits several valid shapes. The playbook allows no skip here; a skip records that you broke it.",
      proofLevel: "required",
      proofHint: "the delegate's taskId and the commit SHA it produced",
      waitsForUser: false,
    },
    {
      title: "Verify on the matching surface",
      slug: "verify-on-surface",
      instructions:
        "Run the change where its users meet it: the test, the CLI, the UI. Inconclusive or the wrong surface is not a pass.",
      proofLevel: "required",
      proofHint: "the command and its result, or a screenshot path",
      waitsForUser: false,
    },
    {
      title: "Rebase into small ordered commits",
      slug: "rebase-commits",
      instructions:
        "Make each commit a unit that builds and passes its check, ordered so the sequence proves itself to a reviewer.",
      proofLevel: "recommended",
      proofHint: "git log --oneline",
      waitsForUser: false,
    },
    {
      title: "Interrogate a contested design",
      slug: "interrogate-design",
      instructions:
        "If the design is contested, run the interrogate skill before shipping. If it is not, skip with that reason.",
      proofLevel: "recommended",
      proofHint: "the report path",
      waitsForUser: false,
    },
    {
      title: "Open the PR",
      slug: "open-pr",
      instructions:
        "Run the Opening a PR playbook and link the PR to this thread with link_pull_request.",
      proofLevel: "required",
      proofHint: "the PR URL",
      waitsForUser: false,
    },
    {
      title: "Merge to main",
      slug: "merge-to-main",
      instructions:
        "Ask the user once whether to merge. When they say go, merge and confirm the merge landed.",
      proofLevel: "required",
      proofHint: "the user's answer and the merge SHA",
      waitsForUser: true,
    },
  ],
});
