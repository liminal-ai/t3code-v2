export type ClaudeContextEngine = "claude" | "claude-lhc";

// Reads the raw key, because instance config is stored unvalidated and must be
// read the same way before and after the settings schema knows the key.
export function claudeContextEngineOf(config: unknown): ClaudeContextEngine {
  return typeof config === "object" &&
    config !== null &&
    "contextEngine" in config &&
    config.contextEngine === "claude-lhc"
    ? "claude-lhc"
    : "claude";
}
