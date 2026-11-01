import { ProviderInstanceId, type OrchestrationV2EngineBinding } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { claudeRowAutoCompactThreshold, claudeThreadTraits } from "./traits.ts";

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

describe("claudeRowAutoCompactThreshold", () => {
  const STOCK = { autoCompactThreshold: 267_000 };

  it("paints nothing for an invalid policy and Claude's own threshold for stock, whatever the model's window", () => {
    assert.deepEqual(
      claudeRowAutoCompactThreshold({ ...BINDING, compact: null }, 200_000, STOCK),
      {},
    );
    assert.deepEqual(claudeRowAutoCompactThreshold(null, 200_000, STOCK), STOCK);
    assert.deepEqual(claudeRowAutoCompactThreshold(null, null, STOCK), STOCK);
    assert.deepEqual(claudeRowAutoCompactThreshold(null, 200_000, {}), {});
  });

  // From long-horizon-context packages/claude-lhc/test/compact-policy.test.ts at f64af8df.
  it.each([
    { window: 200_000, trigger: 700_000, effective: 160_000 },
    { window: 1_000_000, trigger: 700_000, effective: 700_000 },
    { window: null, trigger: 700_000, effective: 700_000 },
  ])(
    "matches claude-lhc's trigger for $trigger on a $window window",
    ({ window, trigger, effective }) => {
      const binding = { ...BINDING, compact: { trigger, target: 140_000 } };
      assert.deepEqual(claudeRowAutoCompactThreshold(binding, window, STOCK), {
        autoCompactThreshold: effective,
      });
    },
  );

  it.each([
    { trigger: 100_000, effective: 100_000 },
    { trigger: 160_000, effective: 160_000 },
    { trigger: 180_000, effective: 160_000 },
  ])(
    "marks an LHC trigger of $trigger on a 200k window at $effective",
    ({ trigger, effective }) => {
      const binding = { ...BINDING, compact: { trigger, target: 50_000 } };
      assert.deepEqual(claudeRowAutoCompactThreshold(binding, 200_000, STOCK), {
        autoCompactThreshold: effective,
      });
    },
  );
});
