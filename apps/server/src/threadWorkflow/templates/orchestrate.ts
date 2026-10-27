import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const orchestrate = Schema.decodeSync(ThreadWorkflowTemplate)({
  id: "orchestrate",
  version: 1,
  title: "Orchestrate",
  description:
    "A standing program run by one coordinator: many units, many stacked PRs, a fleet of workers.",
  source: {
    playbook: "poteto-mode/playbooks/orchestrate.md",
    commit: "60a54dcd305a321c839bbdf3bd2b5380f501f527",
    sha256: "0d4b5cc5b0909ed67bcced87c06f97773927fdbf9578e275d7f8aeee5e6f781d",
  },
  steps: [
    {
      title: "Frame the program",
      slug: "frame-program",
      instructions:
        "State the done predicate as something countable, the scope, the wall-clock budget and the tracks. If you would do the work yourself in this session, it is not a program: abandon this workflow and run Autonomous run instead.",
      proofLevel: "required",
      proofHint: "the framing text",
      waitsForUser: false,
    },
    {
      title: "Approve the program plan",
      slug: "approve-plan",
      instructions:
        "Present the framing to the user once and ask whether to start. Reversible prep may proceed while you wait.",
      proofLevel: "required",
      proofHint: "the user's answer",
      waitsForUser: true,
    },
    {
      title: "Install the runtime",
      slug: "install-runtime",
      instructions:
        "Run orch init, open the decision trail, write the standing orders before any spawn, and seed frontier.json from existing PRs.",
      proofLevel: "required",
      proofHint: "the store path",
      waitsForUser: false,
    },
    {
      title: "Pilot one unit",
      slug: "pilot-one-unit",
      instructions:
        "Push one unit through brief, worker, verification, stack entry, ledger row and merge. Fix the brief, the verify recipe and the unit size from its evidence before fan-out.",
      proofLevel: "required",
      proofHint: "the pilot's PR and its ledger row",
      waitsForUser: false,
    },
    {
      title: "Scale and drain",
      slug: "scale-and-drain",
      instructions:
        "Keep a rolling window of workers up to the in-flight cap, refill as children finish, and run the queue discipline at every drain until the predicate count is met.",
      proofLevel: "required",
      proofHint: "the final orch status lines",
      waitsForUser: false,
    },
    {
      title: "Land continuously",
      slug: "land-continuously",
      instructions:
        "Ask the user once before the first merge to main, then land verified units as they come. Keep the frontier green before upper-stack work, and give every landed PR a verdict for its head SHA.",
      proofLevel: "required",
      proofHint: "the user's answer, the frontier generation and the ledger summary",
      waitsForUser: true,
    },
    {
      title: "Close the program",
      slug: "close-program",
      instructions:
        "Drain the final inbox, reconcile every agent to a terminal row, confirm the predicate on the real artifact, and audit the trail. Leave the store intact.",
      proofLevel: "required",
      proofHint: "the closing counts",
      waitsForUser: false,
    },
    {
      title: "Report",
      slug: "report",
      instructions: "Write the reply the playbook's reply contract names.",
      proofLevel: "recommended",
      proofHint: "where the report is",
      waitsForUser: false,
    },
  ],
});
