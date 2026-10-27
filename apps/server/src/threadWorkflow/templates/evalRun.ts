import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

export const evalRun = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "eval",
  version: 1,
  title: "Eval",
  description:
    "A blinded test of how a skill, structure or prompt change affects agent behavior, before promoting it.",
  source: {
    playbook: "poteto-mode/playbooks/eval.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "1f52d21fd443014592546202a6e282a74aad17a8a7826e55103d3da8f7bdfe21",
  },
  steps: [
    findVerifySkill,
    {
      title: "Variant, rubric and sanitized setups ready",
      slug: "frame-eval",
      instructions:
        "State the variant under test and what counts as success, and write a 3 to 6 criterion rubric for the judge only. Set up one sanitized working dir per candidate with the variant in place and the context an organic task would have. Hold every blinding rule in the playbook: no eval vocabulary, no leaked meta, no chain-eliciting cues, no mention of other candidates.",
      proofLevel: "required",
      proofHint: "the rubric and the candidate dirs",
      waitsForUser: false,
    },
    {
      title: "Candidates run and judged blind",
      slug: "run-candidates",
      instructions:
        "Write one organic prompt. Spawn N candidates on different models per arena's Phase B, each in its own dir with the same prompt. Spawn one judge on a different model family per arena's Phase C, which sees the outputs by sanitized label and the rubric, never a model name.",
      proofLevel: "required",
      proofHint: "the candidates' taskIds and the judge's verdict",
      waitsForUser: false,
    },
    {
      title: "Chain graded from transcripts and synthesized",
      slug: "grade-and-synthesize",
      instructions:
        "Read each candidate's thread with t3_thread_read in activity view to the end, and grade chain-following from the files it opened and the shape of its code, never from its own claims. Read every output yourself and compare with the judge's verdict. Recommend whether to promote the variant.",
      proofLevel: "required",
      proofHint: "the synthesis and the recommendation",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
