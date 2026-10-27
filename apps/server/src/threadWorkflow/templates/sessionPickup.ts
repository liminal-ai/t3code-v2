import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { closingSteps, RUN_FOLDER } from "./shared.ts";

export const sessionPickup = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "session-pickup",
  version: 1,
  title: "Session pickup",
  description:
    "A prior agent's in-flight work resumed from its trail, without redoing what it finished.",
  source: {
    playbook: "poteto-mode/playbooks/session-pickup.md",
    commit: "5b090aff34e36677a0d6d53b7db6a74bedc709d1",
    sha256: "3eb82ad7c5d9bb9904ad3ac55bbd5a1b1efe04b0db6865526c493cbfd5e5488d",
  },
  steps: [
    {
      title: "Prior trail located and read",
      slug: "locate-trail",
      instructions: `Find the prior trail: a T3 thread in this project (t3_thread_list or t3_thread_search, then t3_thread_read in activity view), a cloud-agent URL, a pushed branch, or a resume note in \`~/.local/state/pstack/resume/\`. Parse a long transcript in a subagent and keep the reduced timeline. ${RUN_FOLDER}`,
      proofLevel: "required",
      proofHint: "the trail's location",
      waitsForUser: false,
    },
    {
      title: "Resume point named",
      slug: "name-resume-point",
      instructions:
        "Reconstruct the branch and worktree, what landed, the open todos (the thread's workflow or the prior todo file, reopened) and the decisions made. Diff done against planned and name the resume point. The trail is authoritative: do not redo finished work or re-run the prior repro.",
      proofLevel: "required",
      proofHint: "the resume point and what was inherited",
      waitsForUser: false,
    },
    {
      title: "Inherited claims checked",
      slug: "check-claims",
      instructions:
        "Check the inherited claims against the original goal on the real artifact, through the project's verify skill when the claim is about the app. A passing prior self-report is not the proof.",
      proofLevel: "required",
      proofHint: "each claim and what checked it",
      waitsForUser: false,
    },
    {
      title: "Remaining work routed",
      slug: "route-remaining-work",
      instructions:
        "Pick the verdict: continue, ship a finished recommendation, ratify or override a prior conclusion, or postmortem a failed run. To continue, skip the closing steps below with the reason that the routed workflow carries them, close this workflow, and start the routed playbook's template.",
      proofLevel: "required",
      proofHint: "the verdict and the routed template",
      waitsForUser: false,
    },
    ...closingSteps,
  ],
});
