/** Scroll geometry of the timeline's scroll node, in CSS pixels. */
export interface ScrollGeometry {
  readonly offset: number;
  readonly contentLength: number;
  readonly viewportLength: number;
}

/** A gesture that can carry the reader away from the live end. */
export type ReaderGesture =
  | { readonly kind: "wheel"; readonly deltaY: number }
  | { readonly kind: "touch" }
  | { readonly kind: "scrollbar" }
  | { readonly kind: "key"; readonly key: string };

const END_SLACK_PX = 2;
const KEYS_TOWARD_START: ReadonlySet<string> = new Set(["PageUp", "Home", "ArrowUp"]);

export const keyTowardStart = (key: string) => KEYS_TOWARD_START.has(key);

export const geometryOf = (node: HTMLElement): ScrollGeometry => ({
  offset: node.scrollTop,
  contentLength: node.scrollHeight,
  viewportLength: node.clientHeight,
});

const distanceFromEnd = (g: ScrollGeometry) =>
  Math.max(0, g.contentLength - g.viewportLength - g.offset);

const atEnd = (g: ScrollGeometry) => distanceFromEnd(g) <= END_SLACK_PX;

const overflows = (g: ScrollGeometry) => g.contentLength > g.viewportLength + END_SLACK_PX;

/**
 * Whether a gesture takes the reader away from the live end, so the list stops pinning to it. A
 * gesture that cannot move the viewport is ignored: a break with no scroll to follow would never
 * re-arm, and content that fits in the viewport cannot scroll at all. A touch move's direction is
 * not observable, so it counts once the drag has carried the viewport off the end.
 */
export function gestureLeavesEnd(gesture: ReaderGesture, geometry: ScrollGeometry): boolean {
  switch (gesture.kind) {
    case "wheel":
      return gesture.deltaY < 0 && overflows(geometry);
    case "scrollbar":
      return overflows(geometry);
    case "touch":
      return !atEnd(geometry);
    case "key":
      return keyTowardStart(gesture.key) && overflows(geometry);
  }
}

/**
 * The follow state after a scroll event. Reaching the end re-arms following. A scroll that leaves
 * a gap changes nothing, because the list itself moves the viewport while it measures new rows
 * and the pin that follows closes the gap; only a reader's gesture breaks following.
 */
export const followAfterScroll = (following: boolean, geometry: ScrollGeometry) =>
  following || atEnd(geometry);
