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

export function claudeAutoCompactWindow(
  binding: OrchestrationV2EngineBinding | null,
  instanceWindow: string,
  maxTokens: number | null,
): string {
  if (binding === null) return instanceWindow;
  if (binding.compact === null) return "";
  const { trigger } = binding.compact;
  return String(
    maxTokens === null
      ? trigger
      : Math.min(trigger, Math.floor(maxTokens * LHC_TRIGGER_WINDOW_SHARE)),
  );
}
