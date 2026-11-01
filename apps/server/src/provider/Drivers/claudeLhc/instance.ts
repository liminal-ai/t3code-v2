import type {
  OrchestrationV2EngineCompactPolicy,
  OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import type { ProviderEngineBindingTemplate } from "@t3tools/provider-core/server/driver";

import { ClaudeProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

export interface ClaudeLhcInstanceInput {
  readonly continuationKey: string;
  readonly claudeHome: string;
  readonly compact: OrchestrationV2EngineCompactPolicy | null;
}

export interface ClaudeLhcInstance {
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly engineBinding: ProviderEngineBindingTemplate;
}

// A steer the CLI has not started holds claude-lhc's automatic compact for as long as it waits.
const CLAUDE_LHC_CAPABILITIES = {
  ...ClaudeProviderCapabilitiesV2,
  turns: { ...ClaudeProviderCapabilitiesV2.turns, supportsActiveSteering: false },
} satisfies OrchestrationV2ProviderCapabilities;

export function makeClaudeLhcInstance(input: ClaudeLhcInstanceInput): ClaudeLhcInstance {
  return {
    capabilities: CLAUDE_LHC_CAPABILITIES,
    engineBinding: {
      engine: "claude-lhc",
      continuationKey: input.continuationKey,
      claudeHome: input.claudeHome,
      compact: input.compact,
      nativeContinuation: "required",
      compaction: "provider",
    },
  };
}
