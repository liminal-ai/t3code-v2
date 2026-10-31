import { ProviderInstanceId, type OrchestrationV2EngineBinding } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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

const LIVE = { nativeThreadId: "native-alias", frameSessionId: "generation-2" };

describe("claudeThreadTraits", () => {
  it.effect("keeps stock Claude on its native session and its transcript check", () =>
    Effect.gen(function* () {
      const traits = claudeThreadTraits(null, LIVE);
      assert.equal(traits.filesSessionId, "native-alias");
      assert.isTrue(yield* traits.conversationMissing(Effect.succeed(true)));
      assert.isFalse(yield* traits.conversationMissing(Effect.succeed(false)));
      assert.isFalse(traits.compactionReplacesProcess);
    }),
  );

  it.effect(
    "reads LHC files under the live generation and never reports a missing conversation",
    () =>
      Effect.gen(function* () {
        let checkedTranscript = false;
        const traits = claudeThreadTraits(BINDING, LIVE);
        assert.equal(traits.filesSessionId, "generation-2");
        assert.isFalse(
          yield* traits.conversationMissing(
            Effect.sync(() => {
              checkedTranscript = true;
              return true;
            }),
          ),
        );
        assert.isFalse(checkedTranscript);
        assert.isTrue(traits.compactionReplacesProcess);
      }),
  );

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
