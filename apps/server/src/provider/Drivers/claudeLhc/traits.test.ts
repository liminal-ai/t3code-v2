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
  it("marks the row's LHC trigger, nothing for an invalid policy, and the instance window for stock", () => {
    assert.equal(claudeAutoCompactWindow(BINDING, "300000"), "700000");
    assert.equal(claudeAutoCompactWindow({ ...BINDING, compact: null }, "300000"), "");
    assert.equal(claudeAutoCompactWindow(null, "300000"), "300000");
    assert.equal(claudeAutoCompactWindow(null, ""), "");
  });
});
