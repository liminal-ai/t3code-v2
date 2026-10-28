import { describe } from "@effect/vitest";
import { CLAUDE_LHC_DRIVER_KIND } from "@t3tools/contracts";

import { CLAUDE_LHC_FORK_REFUSAL } from "../../provider/Drivers/ClaudeLhcDriver.ts";
import {
  ClaudeAdapterV2Driver,
  claudeProviderCapabilities,
  createClaudeAdapterV2,
} from "../Adapters/ClaudeAdapterV2.ts";
import { makeClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import {
  itRunsReplayFixtures,
  runReplayFixture,
  type ReplayFixtureCase,
} from "./ProviderReplayFixtures.ts";

const ClaudeLhcOrchestratorReplayHarness = makeClaudeOrchestratorReplayHarness({
  ...ClaudeAdapterV2Driver,
  driverKind: CLAUDE_LHC_DRIVER_KIND,
  create: (input) =>
    createClaudeAdapterV2(input, {
      capabilities: claudeProviderCapabilities({ forkRefusal: CLAUDE_LHC_FORK_REFUSAL }),
    }),
});

function runClaudeLhcReplayFixture(input: ReplayFixtureCase) {
  return runReplayFixture({
    ...input,
    harness: ClaudeLhcOrchestratorReplayHarness,
    transformTranscript: (transcript) => ({ ...transcript, provider: CLAUDE_LHC_DRIVER_KIND }),
  });
}

describe("Claude LHC replay fixtures", () => {
  itRunsReplayFixtures(CLAUDE_LHC_DRIVER_KIND, runClaudeLhcReplayFixture);
});
