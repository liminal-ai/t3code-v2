import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { cleanup, reflectAndUpkeep, RUN_FOLDER } from "./shared.ts";

export const retroRound = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "retro-round",
  version: 1,
  title: "Retro round",
  description:
    "Several threads' reflects reviewed together, the user's decisions recorded, and the approved changes landed.",
  source: {
    playbook: "reflect/SKILL.md",
    commit: "47b5f218d3dfdec82229c39a3f4e37439f01d87a",
    sha256: "3b268f9aaf0f5f2fafc51ea4882fea8f5ec86ae1abb7133d9ce7b2492ac99f7a",
  },
  steps: [
    {
      title: "Round opened",
      slug: "open-round",
      instructions: `Run \`node ~/.agents/skills/reflect/scripts/retro.mjs status\`, then \`retro.mjs open\`, which copies the waiting reflects into a new round folder. Read its README.md for the inputs. ${RUN_FOLDER}`,
      proofLevel: "required",
      proofHint: "the round folder",
      waitsForUser: false,
    },
    {
      title: "Synthesis written",
      slug: "write-synthesis",
      instructions:
        "Read every input the README lists, then write `synthesis.md` in the round folder: the topics the threads share, each with its evidence and the change it proposes.",
      proofLevel: "required",
      proofHint: "the synthesis path",
      waitsForUser: false,
    },
    {
      title: "Decisions recorded in the user's words",
      slug: "record-decisions",
      instructions:
        "Walk the user through the synthesis stop by stop and record `decisions.md` in their own words. The user decides which proposed changes to make, and each stop needs that call before its change is grouped. Settle anything an experiment can answer without them.",
      proofLevel: "required",
      proofHint: "the decisions.md path",
      waitsForUser: true,
    },
    {
      title: "Merge gate reviewed and changes grouped",
      slug: "group-changes",
      instructions:
        "Write `merge-gate.md` on how the merge gate script has done since the last round. Sort the approved changes into groups by body of work, each with a lead. Each edit lands where the skill's source lives, a pstack skill through a PR to `liminal-ai/pstack-lim` against `lim`, never only in the installed copy. Name the owner of a vendor or user-only skill and leave that edit to them.",
      proofLevel: "required",
      proofHint: "merge-gate.md and the groups with their leads",
      waitsForUser: false,
    },
    {
      title: "Each group landed through its PRs and gates",
      slug: "land-groups",
      instructions:
        "Each lead runs its group through its PRs, a counterpart verdict and the merge gate. Reinstall pstack per pstack-lim's FORK.md once its PRs merge, and record each PR in `decisions.md`.",
      proofLevel: "required",
      proofHint: "each group's PR URLs and merge SHAs",
      waitsForUser: false,
    },
    {
      title: "Follow-ups filed and round closed",
      slug: "close-out-tickets",
      instructions:
        "Read the open tickets in the Linear project that owns each follow-up the user kept, in team LH, then file them as a few tickets grouped by body of work, adding to a grouped ticket that already covers the work. Add each ticket id to `decisions.md`. Then run `retro.mjs close <round>`, which refuses until synthesis.md, decisions.md and merge-gate.md exist.",
      proofLevel: "required",
      proofHint: "the ticket ids and the close output",
      waitsForUser: false,
    },
    reflectAndUpkeep,
    cleanup,
  ],
});
