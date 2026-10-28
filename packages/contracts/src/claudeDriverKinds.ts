import { ProviderDriverKind } from "./providerInstance.ts";

export const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
export const CLAUDE_LHC_DRIVER_KIND = ProviderDriverKind.make("claude-lhc");

export const isClaudeDriverKind = (kind: string | null | undefined): boolean =>
  kind === CLAUDE_DRIVER_KIND || kind === CLAUDE_LHC_DRIVER_KIND;
