export interface ScrollGeometry {
  readonly offset: number;
  readonly contentLength: number;
  readonly viewportLength: number;
}

export type FollowEvent =
  | { readonly kind: "scroll" }
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

function leavesEnd(event: FollowEvent, geometry: ScrollGeometry): boolean {
  switch (event.kind) {
    case "scroll":
      return false;
    case "wheel":
      return event.deltaY < 0 && overflows(geometry);
    case "scrollbar":
      return overflows(geometry);
    case "touch":
      return !atEnd(geometry);
    case "key":
      return keyTowardStart(event.key) && overflows(geometry);
  }
}

export const followAfter = (following: boolean, event: FollowEvent, geometry: ScrollGeometry) =>
  leavesEnd(event, geometry) ? false : following || atEnd(geometry);
