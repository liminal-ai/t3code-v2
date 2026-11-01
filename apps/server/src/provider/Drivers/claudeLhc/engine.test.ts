import { assert, describe, it } from "@effect/vitest";

import { parseClaudeEngine } from "./engine.ts";

const lhc = (lhcCompactTrigger?: string, lhcCompactTarget?: string) =>
  parseClaudeEngine({
    contextEngine: "claude-lhc",
    ...(lhcCompactTrigger === undefined ? {} : { lhcCompactTrigger }),
    ...(lhcCompactTarget === undefined ? {} : { lhcCompactTarget }),
  });

describe("parseClaudeEngine", () => {
  it("reads stock Claude without touching the LHC fields", () => {
    assert.deepStrictEqual(
      parseClaudeEngine({ contextEngine: "claude", lhcCompactTrigger: "nonsense" }),
      { engine: "claude" },
    );
  });

  it("reads 700000 and 140000 as the compact pair", () => {
    assert.deepStrictEqual(lhc("700000", "140000"), {
      engine: "claude-lhc",
      compact: { trigger: 700000, target: 140000 },
    });
    assert.deepStrictEqual(lhc(" 40000 ", "20000"), {
      engine: "claude-lhc",
      compact: { trigger: 40000, target: 20000 },
    });
  });

  it("names each empty field as a problem", () => {
    assert.deepStrictEqual(lhc(), {
      engine: "claude-lhc",
      compact: null,
      problem: "Set LHC compact trigger and LHC compact target to run LHC threads.",
    });
    assert.deepStrictEqual(lhc("700000", "  "), {
      engine: "claude-lhc",
      compact: null,
      problem: "Set LHC compact target to run LHC threads.",
    });
  });

  it("refuses a value that is not a whole number of tokens", () => {
    for (const value of ["abc", "1e6", "70000.5", "-5", "0", "007", "700,000"]) {
      assert.deepStrictEqual(lhc(value, "140000"), {
        engine: "claude-lhc",
        compact: null,
        problem: `LHC compact trigger must be a whole number of tokens, not "${value}".`,
      });
    }
    assert.deepStrictEqual(lhc("abc", ""), {
      engine: "claude-lhc",
      compact: null,
      problem:
        'Set LHC compact target to run LHC threads. LHC compact trigger must be a whole number of tokens, not "abc".',
    });
  });

  it("refuses a target at or above the trigger", () => {
    assert.deepStrictEqual(lhc("140000", "140000"), {
      engine: "claude-lhc",
      compact: null,
      problem: "LHC compact target (140000) must be below LHC compact trigger (140000).",
    });
    assert.deepStrictEqual(lhc("140000", "700000"), {
      engine: "claude-lhc",
      compact: null,
      problem: "LHC compact target (700000) must be below LHC compact trigger (140000).",
    });
  });
});
