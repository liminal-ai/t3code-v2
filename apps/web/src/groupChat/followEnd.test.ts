import { describe, expect, it } from "vite-plus/test";

import { followAfter, type ScrollGeometry } from "./followEnd";

const pinned: ScrollGeometry = { offset: 3371, contentLength: 3867, viewportLength: 496 };
const fits: ScrollGeometry = { offset: 0, contentLength: 300, viewportLength: 496 };
const away: ScrollGeometry = { offset: 1000, contentLength: 3867, viewportLength: 496 };
const scroll = { kind: "scroll" } as const;

describe("following the live end", () => {
  it("a reply that lands while pinned keeps following, whatever gap the list leaves", () => {
    const drifted: ScrollGeometry = { offset: 3327, contentLength: 3957, viewportLength: 496 };
    expect(followAfter(true, scroll, drifted)).toBe(true);
    const ended: ScrollGeometry = { offset: 3327, contentLength: 4491, viewportLength: 518 };
    expect(followAfter(true, scroll, ended)).toBe(true);
  });

  it("scrolling back to the end re-arms following, and stopping short does not", () => {
    expect(followAfter(false, scroll, pinned)).toBe(true);
    expect(followAfter(false, scroll, { ...pinned, offset: pinned.offset - 1 })).toBe(true);
    expect(followAfter(false, scroll, { ...pinned, offset: pinned.offset - 40 })).toBe(false);
    expect(followAfter(false, scroll, fits)).toBe(true);
  });

  it("a wheel toward the start leaves the end only when there is history to scroll into", () => {
    expect(followAfter(true, { kind: "wheel", deltaY: -30 }, pinned)).toBe(false);
    expect(followAfter(true, { kind: "wheel", deltaY: 30 }, pinned)).toBe(true);
    expect(followAfter(true, { kind: "wheel", deltaY: -30 }, fits)).toBe(true);
  });

  it("a scrollbar drag leaves the end when the content overflows", () => {
    expect(followAfter(true, { kind: "scrollbar" }, pinned)).toBe(false);
    expect(followAfter(true, { kind: "scrollbar" }, fits)).toBe(true);
  });

  it("a touch drag leaves the end once it has moved the viewport off it", () => {
    expect(followAfter(true, { kind: "touch" }, pinned)).toBe(true);
    expect(followAfter(true, { kind: "touch" }, away)).toBe(false);
  });

  it("keys toward the start leave the end, keys toward the end do not", () => {
    for (const key of ["PageUp", "Home", "ArrowUp"]) {
      expect(followAfter(true, { kind: "key", key }, pinned)).toBe(false);
      expect(followAfter(true, { kind: "key", key }, fits)).toBe(true);
    }
    for (const key of ["PageDown", "End", "ArrowDown", "a"]) {
      expect(followAfter(true, { kind: "key", key }, pinned)).toBe(true);
    }
  });

  it("a gesture at the end re-arms following that a jump had turned off", () => {
    expect(followAfter(false, { kind: "wheel", deltaY: 30 }, pinned)).toBe(true);
    expect(followAfter(false, { kind: "wheel", deltaY: 30 }, away)).toBe(false);
  });
});
