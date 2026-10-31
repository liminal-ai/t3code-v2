import { describe, expect, it } from "@effect/vitest";

import { ClaudeProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeClaudeLhcInstance } from "./instance.ts";

const input = {
  continuationKey: "claude-lhc:home:/homes/lhc",
  claudeHome: "/homes/lhc",
  compact: { trigger: 700_000, target: 140_000 },
};

describe("makeClaudeLhcInstance", () => {
  it("is stock Claude's capabilities with active steering off", () => {
    const { capabilities } = makeClaudeLhcInstance(input);
    expect(capabilities.turns.supportsActiveSteering).toBe(false);
    expect({
      ...capabilities,
      turns: { ...capabilities.turns, supportsActiveSteering: true },
    }).toEqual(ClaudeProviderCapabilitiesV2);
    expect(ClaudeProviderCapabilitiesV2.turns.supportsActiveSteering).toBe(true);
  });

  it("binds new threads to claude-lhc with the instance's key, home and pair", () => {
    expect(makeClaudeLhcInstance(input).engineBinding).toEqual({
      engine: "claude-lhc",
      continuationKey: "claude-lhc:home:/homes/lhc",
      claudeHome: "/homes/lhc",
      compact: { trigger: 700_000, target: 140_000 },
      nativeContinuation: "required",
      compaction: "provider",
    });
  });

  it("keeps the key and home with a null pair when the instance's pair did not parse", () => {
    expect(makeClaudeLhcInstance({ ...input, compact: null }).engineBinding).toMatchObject({
      engine: "claude-lhc",
      continuationKey: "claude-lhc:home:/homes/lhc",
      claudeHome: "/homes/lhc",
      compact: null,
    });
  });
});
