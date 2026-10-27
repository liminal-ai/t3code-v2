import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, RUN_FOLDER } from "./shared.ts";

export const investigation = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "investigation",
  version: 1,
  title: "Investigation",
  description:
    "A read-only question answered with a cited explanation or a recommendation, not a code change.",
  source: {
    playbook: "poteto-mode/playbooks/investigation.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "dc66bcf6af3a074fc7f67aa5e12b93ef571a4fb4d8e17f2f1af5ae5359f42e46",
  },
  steps: [
    {
      title: "Question routed and run folder made",
      slug: "route-question",
      instructions: `Route the question through the how skill, and through the why skill too for a motivation question. Keep the throughput checkpoint to one line: \`n/a, read-only investigation\`. ${RUN_FOLDER}`,
      proofLevel: "recommended",
      proofHint: "the skills routed to",
      waitsForUser: false,
    },
    {
      title: "Cited answer written",
      slug: "write-answer",
      instructions:
        "Write the how-shaped answer (Overview, Key Concepts, How It Works, Where Things Live, Gotchas), or a recommendation with a tradeoffs table when the question picks between alternatives. Give your real judgment with reasons, and push back when the premise is wrong. Apply unslop. No PR: if a code change follows, route it to Bug fix or Feature.",
      proofLevel: "required",
      proofHint: "where the answer is",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
