import { ProviderInstanceId, type OrchestrationV2EngineBinding } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { claudeAutoCompactWindow, claudeThreadTraits } from "./traits.ts";

const BINDING = {
  providerInstanceId: ProviderInstanceId.make("claude-lhc"),
  engine: "claude-lhc",
  continuationKey: "claude-lhc:home:/lhc/home",
  claudeHome: "/lhc/home",
  compact: { trigger: 700_000, target: 140_000 },
  nativeContinuation: "required",
  compaction: "provider",
} satisfies OrchestrationV2EngineBinding;

const LIVE = { nativeThreadId: "native-alias", generation: "generation-2" };

describe("claudeThreadTraits", () => {
  it("keeps stock Claude on its native session and its transcript", () => {
    assert.deepEqual(claudeThreadTraits(null, LIVE), {
      filesSessionId: "native-alias",
      conversationInTranscript: true,
      compactionReplacesProcess: false,
    });
  });

  it("reads LHC files under the live generation and its conversation outside the transcript", () => {
    assert.deepEqual(claudeThreadTraits(BINDING, LIVE), {
      filesSessionId: "generation-2",
      conversationInTranscript: false,
      compactionReplacesProcess: true,
    });
  });

  it("falls back to the native id for LHC files when no frame names a generation", () => {
    assert.equal(
      claudeThreadTraits(BINDING, { nativeThreadId: "native-alias" }).filesSessionId,
      "native-alias",
    );
  });
});

describe("claudeAutoCompactWindow", () => {
  it("marks nothing for an invalid policy and the instance window for stock, whatever the model's window", () => {
    assert.equal(claudeAutoCompactWindow({ ...BINDING, compact: null }, "300000", 200_000), "");
    assert.equal(claudeAutoCompactWindow(null, "300000", 200_000), "300000");
    assert.equal(claudeAutoCompactWindow(null, "300000", null), "300000");
    assert.equal(claudeAutoCompactWindow(null, "", 200_000), "");
  });

  // From long-horizon-context packages/claude-lhc/test/compact-policy.test.ts at f64af8df.
  it.each([
    { window: 200_000, trigger: 700_000, effective: "160000" },
    { window: 1_000_000, trigger: 700_000, effective: "700000" },
    { window: null, trigger: 700_000, effective: "700000" },
  ])(
    "matches claude-lhc's trigger for $trigger on a $window window",
    ({ window, trigger, effective }) => {
      const binding = { ...BINDING, compact: { trigger, target: 140_000 } };
      assert.equal(claudeAutoCompactWindow(binding, "300000", window), effective);
    },
  );

  it.each([
    { trigger: 100_000, effective: "100000" },
    { trigger: 160_000, effective: "160000" },
    { trigger: 180_000, effective: "160000" },
  ])(
    "marks an LHC trigger of $trigger on a 200k window at $effective",
    ({ trigger, effective }) => {
      const binding = { ...BINDING, compact: { trigger, target: 50_000 } };
      assert.equal(claudeAutoCompactWindow(binding, "300000", 200_000), effective);
    },
  );
});
