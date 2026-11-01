export type ClaudeContextEngine = "claude" | "claude-lhc";

export function claudeContextEngineOf(config: unknown): ClaudeContextEngine {
  return typeof config === "object" &&
    config !== null &&
    "contextEngine" in config &&
    config.contextEngine === "claude-lhc"
    ? "claude-lhc"
    : "claude";
}
