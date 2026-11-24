import { describe, expect, it } from "vite-plus/test";

import {
  blockingProblems,
  formatTokenAmount,
  parseTokenAmount,
  resolveLimbaseCompaction,
  type LimbaseCompaction,
} from "./forkSettings.ts";

const ONE_M = { trigger: 700_000, target: 120_000 };

const resolve = (
  thread: LimbaseCompaction,
  instance: LimbaseCompaction = {},
  contextWindow: number | null = 1_000_000,
) =>
  resolveLimbaseCompaction({
    thread,
    instance,
    defaults: contextWindow === null ? undefined : ONE_M,
    contextWindow,
    hardLimit: contextWindow === null ? null : contextWindow - Math.ceil(contextWindow * 0.08),
    coldReturnSize: 300_000,
  });

const messages = (
  thread: LimbaseCompaction,
  instance?: LimbaseCompaction,
  window: number | null = 1_000_000,
) => resolve(thread, instance, window).problems.map(({ severity, message }) => [severity, message]);

describe("Limbase compaction settings", () => {
  it("takes each field from the thread, then the instance, then Limbase's default", () => {
    const resolved = resolve({ downTo: { tokens: 90_000 } }, { compactAt: { tokens: 600_000 } });
    expect(resolved.policy).toEqual({ trigger: 600_000, target: 90_000 });
    expect([resolved.compactAt?.source, resolved.downTo?.source]).toEqual(["instance", "thread"]);
    expect(resolve({}).policy).toEqual(ONE_M);
    expect(resolve({}).compactAt?.source).toBe("default");
  });

  it("turns a share of the window into tokens, and waits while the window is unknown", () => {
    expect(resolve({ compactAt: { percent: 50 }, downTo: { percent: 10 } }).policy).toEqual({
      trigger: 500_000,
      target: 100_000,
    });
    const unknown = resolve({ compactAt: { percent: 50 }, downTo: { tokens: 90_000 } }, {}, null);
    expect(unknown.policy).toBeUndefined();
    expect(unknown.compactAt?.tokens).toBeNull();
    expect(unknown.problems).toEqual([]);
  });

  it("refuses a down to under 24k or not below compact at, and a compact at past the window", () => {
    expect(messages({ downTo: { tokens: 20_000 } })).toEqual([
      ["error", "Down to must be at least 24k."],
    ]);
    expect(messages({ downTo: { tokens: 150_000 } }, { compactAt: { tokens: 140_000 } })).toEqual([
      ["error", "Down to (150k) must be below compact at (140k)."],
    ]);
    expect(messages({ compactAt: { tokens: 300_000 } }, {}, 200_000)).toContainEqual([
      "error",
      "Compact at (300k) must fit the model's 200k window.",
    ]);
    expect(resolve({ downTo: { tokens: 20_000 } }).policy).toBeUndefined();
  });

  it("compares two shares without a window", () => {
    expect(messages({}, { compactAt: { percent: 40 }, downTo: { percent: 50 } }, null)).toEqual([
      ["error", "Down to (50%) must be below compact at (40%)."],
    ]);
  });

  it("warns, and still applies, an inherited compact at past the window and a target at 300k", () => {
    const inherited = resolve({}, { compactAt: { tokens: 700_000 } }, 200_000);
    expect(inherited.problems.map(({ severity, message }) => [severity, message])).toEqual([
      [
        "warning",
        "700k is past the model's 200k window, so Limbase compacts at its hard limit, 184k.",
      ],
    ]);
    expect(inherited.policy).toEqual({ trigger: 700_000, target: 120_000 });
    expect(messages({ downTo: { tokens: 300_000 } })).toEqual([
      ["warning", "At 300k or more, Limbase turns cold return off."],
    ]);
  });

  it("blocks a write only on errors about a field that level sets", () => {
    const resolved = resolve({}, { compactAt: { tokens: 140_000 }, downTo: { tokens: 150_000 } });
    expect(blockingProblems(resolved, "thread")).toEqual([]);
    expect(blockingProblems(resolved, "instance")).toHaveLength(1);
    const own = resolve({ downTo: { tokens: 150_000 } }, { compactAt: { tokens: 140_000 } });
    expect(blockingProblems(own, "thread")).toHaveLength(1);
  });

  it("reads tokens and shares as people write them, and writes them back", () => {
    expect(
      ["700k", "1.5m", "700,000", "70%", " 12.5 % ", "0", "101%", "abc", ""].map(parseTokenAmount),
    ).toEqual([
      { tokens: 700_000 },
      { tokens: 1_500_000 },
      { tokens: 700_000 },
      { percent: 70 },
      { percent: 12.5 },
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(
      [{ tokens: 700_000 }, { tokens: 1_500_000 }, { tokens: 24_500 }, { percent: 70 }].map(
        formatTokenAmount,
      ),
    ).toEqual(["700k", "1.5M", "24.5k", "70%"]);
  });
});
