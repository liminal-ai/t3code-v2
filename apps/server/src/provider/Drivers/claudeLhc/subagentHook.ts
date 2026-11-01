import type { Settings, SubagentStartHookSpecificOutput } from "@anthropic-ai/claude-agent-sdk";
import { T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH } from "@t3tools/provider-core/server/orchestrationInstructions";

type SettingsHookMatcher = NonNullable<Settings["hooks"]>[string][number];

const output: { readonly hookSpecificOutput: SubagentStartHookSpecificOutput } = {
  hookSpecificOutput: {
    hookEventName: "SubagentStart",
    additionalContext: T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  },
};

// JSON escapes leave no single quote inside the single-quoted word, so every shell prints it verbatim.
export const SUBAGENT_DEVICE_HOOK_COMMAND = `printf '%s' '${JSON.stringify(output).replaceAll("'", "\\u0027")}'`;

const matcher: SettingsHookMatcher = {
  hooks: [{ type: "command", command: SUBAGENT_DEVICE_HOOK_COMMAND }],
};

/**
 * Adds the device-instructions `SubagentStart` hook as a command in the CLI's flag settings, the
 * plain-data copy of the adapter's callback that can cross to the claude-lhc sidecar. The SDK lets
 * `options.settings` replace a `settings` entry in `extraArgs`, so the hook goes in `settings`.
 */
export function withSubagentDeviceHook(settings: string | Settings | undefined) {
  // A settings file path cannot take extra keys, so it goes through unchanged.
  if (typeof settings === "string") return settings;
  return {
    ...settings,
    hooks: {
      ...settings?.hooks,
      SubagentStart: [...(settings?.hooks?.SubagentStart ?? []), matcher],
    },
  } satisfies Settings;
}
