import { assert, describe, it } from "@effect/vitest";

import { claudeContextEngineOf } from "./instanceConfig.ts";

describe("claudeContextEngineOf", () => {
  it("reads both engine literals", () => {
    assert.strictEqual(claudeContextEngineOf({ contextEngine: "claude-lhc" }), "claude-lhc");
    assert.strictEqual(claudeContextEngineOf({ contextEngine: "claude" }), "claude");
  });

  it("treats an absent key as stock Claude", () => {
    assert.strictEqual(claudeContextEngineOf({ homePath: "/home/me/.claude" }), "claude");
    assert.strictEqual(claudeContextEngineOf(undefined), "claude");
  });

  it("treats a malformed config as stock Claude", () => {
    assert.strictEqual(claudeContextEngineOf(null), "claude");
    assert.strictEqual(claudeContextEngineOf("claude-lhc"), "claude");
    assert.strictEqual(claudeContextEngineOf(["claude-lhc"]), "claude");
    assert.strictEqual(claudeContextEngineOf({ contextEngine: "CLAUDE-LHC" }), "claude");
    assert.strictEqual(claudeContextEngineOf({ contextEngine: 1 }), "claude");
  });
});
