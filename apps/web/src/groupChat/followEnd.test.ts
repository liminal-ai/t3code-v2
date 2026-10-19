import { describe, expect, it } from "vite-plus/test";

import { followAfterScroll, gestureLeavesEnd, type ScrollGeometry } from "./followEnd";

const pinned: ScrollGeometry = { offset: 3371, contentLength: 3867, viewportLength: 496 };
const fits: ScrollGeometry = { offset: 0, contentLength: 300, viewportLength: 496 };
const away: ScrollGeometry = { offset: 1000, contentLength: 3867, viewportLength: 496 };

describe("following the live end", () => {
  it("a reply that lands while pinned keeps following, whatever gap the list leaves", () => {
    // Measured during the swarm: a reply replaced its pending row, the list moved the scroll
    // offset back 44 px while the content grew 90 px, and nothing re-pinned afterwards.
    const drifted: ScrollGeometry = { offset: 3327, contentLength: 3957, viewportLength: 496 };
    expect(followAfterScroll(true, drifted)).toBe(true);
    const ended: ScrollGeometry = { offset: 3327, contentLength: 4491, viewportLength: 518 };
    expect(followAfterScroll(true, ended)).toBe(true);
  });

  it("scrolling back to the end re-arms following, and stopping short does not", () => {
    expect(followAfterScroll(false, pinned)).toBe(true);
    expect(followAfterScroll(false, { ...pinned, offset: pinned.offset - 1 })).toBe(true);
    expect(followAfterScroll(false, { ...pinned, offset: pinned.offset - 40 })).toBe(false);
    expect(followAfterScroll(false, fits)).toBe(true);
  });

  it("a wheel toward the start leaves the end only when there is history to scroll into", () => {
    expect(gestureLeavesEnd({ kind: "wheel", deltaY: -30 }, pinned)).toBe(true);
    expect(gestureLeavesEnd({ kind: "wheel", deltaY: 30 }, pinned)).toBe(false);
    expect(gestureLeavesEnd({ kind: "wheel", deltaY: -30 }, fits)).toBe(false);
  });

  it("a scrollbar drag leaves the end when the content overflows", () => {
    expect(gestureLeavesEnd({ kind: "scrollbar" }, pinned)).toBe(true);
    expect(gestureLeavesEnd({ kind: "scrollbar" }, fits)).toBe(false);
  });

  it("a touch drag leaves the end once it has moved the viewport off it", () => {
    expect(gestureLeavesEnd({ kind: "touch" }, pinned)).toBe(false);
    expect(gestureLeavesEnd({ kind: "touch" }, away)).toBe(true);
  });

  it("keys toward the start leave the end, keys toward the end do not", () => {
    for (const key of ["PageUp", "Home", "ArrowUp"]) {
      expect(gestureLeavesEnd({ kind: "key", key }, pinned)).toBe(true);
      expect(gestureLeavesEnd({ kind: "key", key }, fits)).toBe(false);
    }
    for (const key of ["PageDown", "End", "ArrowDown", "a"]) {
      expect(gestureLeavesEnd({ kind: "key", key }, pinned)).toBe(false);
    }
  });
});
