export interface ClaudeGenerationFrame {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
}

export interface ClaudeGeneration {
  readonly live: string | null;
  readonly retired: ReadonlySet<string>;
}

export interface ClaudeGenerationStep {
  readonly generation: ClaudeGeneration;
  /** The generation this frame replaced, or null when the live generation stayed or was first seen. */
  readonly replaced: string | null;
}

export const NO_CLAUDE_GENERATION: ClaudeGeneration = { live: null, retired: new Set() };

/**
 * claude-lhc mints a new session id when it swaps the CLI, and names it first on that
 * generation's `system/init` or, after a manual compact, on the `compact_boundary`, with no
 * init. Status and result frames from the old process can still arrive after it, so only
 * those two frames move the generation, and an id once replaced is never adopted again.
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
    return { generation, replaced: null };
  }
  if (generation.live === null) {
    return { generation: { live: sessionId, retired: generation.retired }, replaced: null };
  }
  return {
    generation: { live: sessionId, retired: new Set(generation.retired).add(generation.live) },
    replaced: generation.live,
  };
}
