import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, findVerifySkill } from "./shared.ts";

export const prototype = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "prototype",
  version: 1,
  title: "Prototype",
  description:
    "A throwaway sketch that settles a design or empirical fork by observing it. The real build follows Feature.",
  source: {
    playbook: "poteto-mode/playbooks/prototype.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "48dd83db0405f6bedbe1e0d8fb4932d08ce40f5c19544ee3b3039cb61421fb0c",
  },
  steps: [
    findVerifySkill,
    {
      title: "Decision scoped",
      slug: "scope-decision",
      instructions:
        "Name the decision the prototype exists to make: a layout, an interaction, a density, or a behavior or timing fork. With no decision there is no prototype; route to Feature. When the design space is open, gather prior art and a short moodboard, and ask the user to pick directions with `thread_workflow_ask` before building. Skip that when the direction is set.",
      proofLevel: "required",
      proofHint: "the decision, in one sentence",
      waitsForUser: false,
    },
    {
      title: "Throwaway variants built",
      slug: "build-variants",
      instructions:
        "Build in the run's `scratch/`, apart from production source: the lightest stack that renders the idea, or the smallest script that exercises the question. Put competing variants behind one labeled switcher, and propose variations nobody asked for. No tests, no abstractions, no production framework.",
      proofLevel: "recommended",
      proofHint: "the scratch path",
      waitsForUser: false,
    },
    {
      title: "Each variant observed",
      slug: "observe-variants",
      instructions:
        "For a visual decision, screenshot each variant and drive the interaction through the project's verify skill. For a behavioral or timing decision, log the timing, print the output or watch the render. The observation is the test. Save the evidence in the run's `proof/`.",
      proofLevel: "required",
      proofHint: "the screenshots or the observed output",
      waitsForUser: false,
    },
    {
      title: "Direction recommended",
      slug: "recommend-direction",
      instructions:
        "Present the variants, the evidence, the tradeoffs and a recommendation, and say plainly the prototype is throwaway. Hand the chosen direction to Feature, or to architect for the shape.",
      proofLevel: "required",
      proofHint: "the recommendation",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
