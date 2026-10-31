import { ProviderInstanceId, type OrchestrationV2EngineBinding } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  adoptClaudeGeneration,
  NO_CLAUDE_GENERATION,
  type ClaudeGeneration,
  type ClaudeGenerationFrame,
} from "./generation.ts";
import { claudeThreadTraits } from "./traits.ts";

const BINDING = {
  providerInstanceId: ProviderInstanceId.make("claude-lhc"),
  engine: "claude-lhc",
  continuationKey: "claude-lhc:home:/lhc/home",
  claudeHome: "/lhc/home",
  compact: { trigger: 700_000, target: 140_000 },
  nativeContinuation: "required",
  compaction: "provider",
} satisfies OrchestrationV2EngineBinding;

const ALIAS = "native-alias";

const init = (session_id: string): ClaudeGenerationFrame => ({
  type: "system",
  subtype: "init",
  session_id,
});
const status = (session_id: string): ClaudeGenerationFrame => ({
  type: "system",
  subtype: "status",
  session_id,
});
const boundary = (session_id: string): ClaudeGenerationFrame => ({
  type: "system",
  subtype: "compact_boundary",
  session_id,
});
const assistant = (session_id: string): ClaudeGenerationFrame => ({
  type: "assistant",
  session_id,
});
const result = (session_id: string): ClaudeGenerationFrame => ({
  type: "result",
  subtype: "success",
  session_id,
});
const prompt = (session_id: string): ClaudeGenerationFrame => ({
  type: "command_lifecycle",
  session_id,
});

function replay(frames: ReadonlyArray<ClaudeGenerationFrame>, start = NO_CLAUDE_GENERATION) {
  let generation: ClaudeGeneration = start;
  const resets: Array<{ readonly at: number; readonly replaced: string }> = [];
  const lives: Array<string | null> = [];
  frames.forEach((frame, at) => {
    const step = adoptClaudeGeneration(generation, frame);
    generation = step.generation;
    if (step.replaced !== null) resets.push({ at, replaced: step.replaced });
    lives.push(generation.live);
  });
  return { generation, resets, lives };
}

function assertNeverMovesBack(lives: ReadonlyArray<string | null>) {
  const left = new Set<string>();
  lives.forEach((live, index) => {
    const previous = index === 0 ? null : lives[index - 1];
    if (previous !== null && previous !== undefined && previous !== live) left.add(previous);
    if (live !== null)
      assert.isFalse(left.has(live), `generation moved back to ${live} at ${index}`);
  });
}

describe("adoptClaudeGeneration", () => {
  it("adopts a reopen's init that arrives before the first prompt, and the task list follows it", () => {
    const { generation, resets, lives } = replay([init("g2"), prompt("g2"), assistant("g2")]);
    assertNeverMovesBack(lives);
    assert.equal(generation.live, "g2");
    assert.deepEqual(resets, []);
    assert.equal(
      claudeThreadTraits(BINDING, {
        nativeThreadId: ALIAS,
        generation: generation.live ?? undefined,
      }).filesSessionId,
      "g2",
    );
  });

  it("resets once when a mid-turn compact's init arrives before the old generation's success status", () => {
    const { generation, resets, lives } = replay([
      init("g1"),
      assistant("g1"),
      status("g1"),
      init("g2"),
      status("g1"),
      boundary("g2"),
      assistant("g2"),
      result("g2"),
    ]);
    assertNeverMovesBack(lives);
    assert.equal(generation.live, "g2");
    assert.deepEqual(resets, [{ at: 3, replaced: "g1" }]);
  });

  it("resets once when a mid-turn compact's init arrives after the boundary, and once more for a second compact", () => {
    const { generation, resets, lives } = replay([
      init("g1"),
      status("g1"),
      status("g1"),
      boundary("g1"),
      init("g2"),
      assistant("g2"),
      status("g2"),
      status("g2"),
      boundary("g3"),
      init("g3"),
      result("g3"),
    ]);
    assertNeverMovesBack(lives);
    assert.equal(generation.live, "g3");
    assert.deepEqual(resets, [
      { at: 4, replaced: "g1" },
      { at: 8, replaced: "g2" },
    ]);
  });

  it("keeps the new generation when old-id status, result and boundary frames arrive after its init", () => {
    const { generation, resets, lives } = replay([
      init("g1"),
      init("g2"),
      status("g1"),
      result("g1"),
      boundary("g1"),
      init("g1"),
    ]);
    assertNeverMovesBack(lives);
    assert.equal(generation.live, "g2");
    assert.deepEqual(resets, [{ at: 1, replaced: "g1" }]);
  });

  it("ignores the session id on every frame that does not start a generation", () => {
    const { generation, resets } = replay([
      init("g1"),
      status("g9"),
      result("g9"),
      assistant("g9"),
      prompt("g9"),
    ]);
    assert.equal(generation.live, "g1");
    assert.deepEqual(resets, []);
  });

  it("adopts the first init after a restart once, with no turn open and no reset", () => {
    const { generation, resets, lives } = replay([
      prompt("g3"),
      init("g3"),
      assistant("g3"),
      result("g3"),
      init("g3"),
    ]);
    assertNeverMovesBack(lives);
    assert.equal(generation.live, "g3");
    assert.deepEqual(resets, []);
    assert.deepEqual(lives, [null, "g3", "g3", "g3", "g3"]);
  });

  it("resets once for a manual compact's boundary between turns, before any next prompt or init", () => {
    const { generation, resets, lives } = replay([
      init("g1"),
      result("g1"),
      status("g1"),
      status("g1"),
      boundary("g2"),
      result("g2"),
      prompt("g2"),
      init("g2"),
    ]);
    assertNeverMovesBack(lives);
    assert.equal(generation.live, "g2");
    assert.deepEqual(resets, [{ at: 4, replaced: "g1" }]);
  });

  it("resets once for an init that arrives after one turn settles and before the next prompt", () => {
    const { generation, resets } = replay([init("g1"), result("g1"), init("g2"), prompt("g2")]);
    assert.equal(generation.live, "g2");
    assert.deepEqual(resets, [{ at: 2, replaced: "g1" }]);
  });

  it("never moves a stock session whose init, status and boundary share one session id", () => {
    const { generation, resets } = replay([
      init("stock"),
      status("stock"),
      status("stock"),
      boundary("stock"),
      init("stock"),
      result("stock"),
    ]);
    assert.equal(generation.live, "stock");
    assert.deepEqual(resets, []);
  });
});
