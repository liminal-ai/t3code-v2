import { describe, expect, it } from "vite-plus/test";

import {
  idleOlderPage,
  mayRequestOlder,
  olderFailedAgain,
  olderRead,
  olderRequested,
} from "./olderPages";

describe("older pages in the lanes", () => {
  it("a failed read is not asked for again until a scroll or its backoff", () => {
    const pending = olderRequested(200);
    expect(mayRequestOlder(pending, { before: 200, reason: "underfill", now: 0 })).toBe(false);
    const failed = olderRead(pending, "failed", 1_000);
    expect(mayRequestOlder(failed, { before: 200, reason: "underfill", now: 1_001 })).toBe(false);
    expect(mayRequestOlder(failed, { before: 200, reason: "scroll", now: 1_001 })).toBe(true);
    expect(mayRequestOlder(failed, { before: 200, reason: "underfill", now: 3_001 })).toBe(true);
    expect(mayRequestOlder(failed, { before: 150, reason: "underfill", now: 1_001 })).toBe(true);
  });

  it("repeated failures back off further, and a read that lands clears the failure", () => {
    const first = olderRead(olderRequested(200), "failed", 0);
    const second = olderFailedAgain(first, 10_000);
    expect(second.kind === "failed" && second.retryAt - 10_000).toBeGreaterThan(
      first.kind === "failed" ? first.retryAt : 0,
    );
    expect(olderRead(olderRequested(200), "loaded", 0)).toEqual(idleOlderPage);
    expect(olderRead(olderRequested(200), "empty", 0)).toEqual(idleOlderPage);
    expect(mayRequestOlder(idleOlderPage, { before: null, reason: "scroll", now: 0 })).toBe(false);
  });
});
