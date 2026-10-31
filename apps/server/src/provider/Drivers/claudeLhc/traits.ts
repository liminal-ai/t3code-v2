import type { OrchestrationV2EngineBinding } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export interface ClaudeLiveSession {
  /** The provider row's native session id. */
  readonly nativeThreadId: string;
  /** The session id on the frame being handled. Under LHC it names the live generation. */
  readonly frameSessionId?: string | undefined;
}

/** What a thread's engine changes about the files and process the adapter reads. */
export interface ClaudeThreadTraits {
  /** The session whose files, such as its task list, the running CLI writes. */
  readonly filesSessionId: string;
  /**
   * Whether the session has no conversation to resume, judged by `emptyTranscript`. LHC resumes
   * from its own store, so an empty first-generation file under the native id never blocks it.
   */
  readonly conversationMissing: <E, R>(
    emptyTranscript: Effect.Effect<boolean, E, R>,
  ) => Effect.Effect<boolean, E, R>;
  readonly compactionReplacesProcess: boolean;
}

export function claudeThreadTraits(
  binding: OrchestrationV2EngineBinding | null,
  live: ClaudeLiveSession,
): ClaudeThreadTraits {
  if (binding === null) {
    return {
      filesSessionId: live.nativeThreadId,
      conversationMissing: (emptyTranscript) => emptyTranscript,
      compactionReplacesProcess: false,
    };
  }
  return {
    filesSessionId: live.frameSessionId ?? live.nativeThreadId,
    conversationMissing: () => Effect.succeed(false),
    compactionReplacesProcess: true,
  };
}

/**
 * The auto-compact window the context meter marks: the row's own LHC trigger, or the instance's
 * setting for stock. An LHC binding whose compact policy was invalid marks none.
 */
export function claudeAutoCompactWindow(
  binding: OrchestrationV2EngineBinding | null,
  instanceWindow: string,
): string {
  if (binding === null) return instanceWindow;
  return binding.compact === null ? "" : String(binding.compact.trigger);
}
