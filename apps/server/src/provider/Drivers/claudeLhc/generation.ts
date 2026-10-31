import {
  backgroundWorkNotification,
  type BackgroundWork,
} from "@t3tools/provider-core/server/notification";

export const CLAUDE_CONTEXT_REBUILT_NOTE =
  "Claude rebuilt its context in a new process, so work still running in the old process ended.";

export interface ClaudeGenerationFrame {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
}

export interface ClaudeGeneration {
  readonly live: string | null;
  readonly retired: ReadonlySet<string>;
}

export type ClaudeGenerationStep =
  | { readonly kind: "stayed" }
  | { readonly kind: "first"; readonly generation: ClaudeGeneration }
  | { readonly kind: "replaced"; readonly generation: ClaudeGeneration; readonly replaced: string };

export const NO_CLAUDE_GENERATION: ClaudeGeneration = { live: null, retired: new Set() };

/**
 * claude-lhc mints a new session id when it swaps the CLI, and names it first on that
 * generation's `system/init` or, after a manual compact, on the `compact_boundary`, with no
 * init. Status and result frames from the old process can still arrive after it.
 */
export function adoptClaudeGeneration(
  generation: ClaudeGeneration,
  frame: ClaudeGenerationFrame,
): ClaudeGenerationStep {
  const sessionId = frame.session_id;
  if (
    frame.type !== "system" ||
    (frame.subtype !== "init" && frame.subtype !== "compact_boundary") ||
    sessionId === undefined ||
    sessionId === generation.live ||
    generation.retired.has(sessionId)
  ) {
    return { kind: "stayed" };
  }
  if (generation.live === null) {
    return { kind: "first", generation: { live: sessionId, retired: generation.retired } };
  }
  return {
    kind: "replaced",
    generation: { live: sessionId, retired: new Set(generation.retired).add(generation.live) },
    replaced: generation.live,
  };
}

export function claudeContextRebuiltNotice(ended: ReadonlyArray<BackgroundWork>): string | null {
  const notification = backgroundWorkNotification(
    ended.map((work) => ({ ...work, outcome: "cancelled" as const })),
  );
  return notification === null ? null : `${notification.summary}. ${CLAUDE_CONTEXT_REBUILT_NOTE}`;
}
