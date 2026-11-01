import type { OrchestrationV2EngineBinding } from "@t3tools/contracts";

export interface ClaudeLiveSession {
  readonly nativeThreadId: string;
  readonly generation?: string | undefined;
}

export interface ClaudeThreadTraits {
  readonly filesSessionId: string;
  readonly conversationInTranscript: boolean;
  readonly compactionReplacesProcess: boolean;
}

export function claudeThreadTraits(
  binding: OrchestrationV2EngineBinding | null,
  live: ClaudeLiveSession,
): ClaudeThreadTraits {
  if (binding === null) {
    return {
      filesSessionId: live.nativeThreadId,
      conversationInTranscript: true,
      compactionReplacesProcess: false,
    };
  }
  return {
    filesSessionId: live.generation ?? live.nativeThreadId,
    conversationInTranscript: false,
    compactionReplacesProcess: true,
  };
}

// claude-lhc compacts at no more than this share of the model's window (capCompactPolicyToWindow).
const LHC_TRIGGER_WINDOW_SHARE = 0.8;

interface ClaudeAutoCompactThreshold {
  readonly autoCompactThreshold?: number;
}

// Claude compacts short of its window, but claude-lhc compacts at its trigger, so a bound row
// paints the trigger itself.
export function claudeRowAutoCompactThreshold(
  binding: OrchestrationV2EngineBinding | null,
  maxTokens: number | null,
  stockThreshold: ClaudeAutoCompactThreshold,
): ClaudeAutoCompactThreshold {
  if (binding === null) return stockThreshold;
  if (binding.compact === null) return {};
  const { trigger } = binding.compact;
  return {
    autoCompactThreshold:
      maxTokens === null
        ? trigger
        : Math.min(trigger, Math.floor(maxTokens * LHC_TRIGGER_WINDOW_SHARE)),
  };
}
