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

export function claudeAutoCompactWindow(
  binding: OrchestrationV2EngineBinding | null,
  instanceWindow: string,
): string {
  if (binding === null) return instanceWindow;
  return binding.compact === null ? "" : String(binding.compact.trigger);
}
