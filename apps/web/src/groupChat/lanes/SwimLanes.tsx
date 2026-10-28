import type {
  GroupChatGroupId,
  GroupChatMemberId,
  GroupChatMessage,
  GroupChatMessageId,
} from "@t3tools/contracts";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { Button } from "../../components/ui/button";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { useStableCallback } from "../../hooks/useStableCallback";
import { isEditableFocused } from "../../lib/editableFocus";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { followAfter, type FollowEvent, geometryOf, keyTowardStart } from "../followEnd";
import { memberColor, memberSubtitle } from "../MemberChip";
import { type GroupView, loadOlder } from "../store";
import { onControl } from "./keys";
import { ACCENT, LaneCard, PendingCard } from "./LaneCard";
import {
  idleOlderPage,
  mayRequestOlder,
  olderFailedAgain,
  type OlderPageReason,
  type OlderPageState,
  olderRead,
  olderRequested,
} from "./olderPages";
import {
  type AlignMode,
  alignTurn,
  type Block,
  buildModel,
  type Focus,
  focalOf,
  focusFor,
  type Lane,
  type Link,
  type Model,
  type Selection,
  type Spacer,
  stepSelection,
} from "./model";

/** The slide, the links and the light-up all end within a second of the selection. */
const SLIDE_MS = 300;
const LIGHT_LEAD_MS = 160;
const LIGHT_STAGGER_MS = 240;
const LINK_STAGGER_MS = 240;
const HEADER_PX = 40;
const OLDER_THRESHOLD_PX = 240;

const underfilled = (element: HTMLElement) =>
  element.scrollHeight - element.clientHeight < OLDER_THRESHOLD_PX;
const MARKDOWN_ROOT_MARGIN = "200% 0px";
const OPERATOR_LANE_MIN_PX = 150;
const MEMBER_LANE_MIN_PX = 176;
const LANE_GAP_PX = 16;
const FIELD_PADDING_PX = 32;
const MODE_KEY = "t3.groupChat.lanes.mode";

const readMode = (): AlignMode => (localStorage.getItem(MODE_KEY) === "line" ? "line" : "packed");

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Box {
  readonly l: number;
  readonly r: number;
  readonly t: number;
  readonly b: number;
  readonly cx: number;
  readonly labelY: number;
}

interface DrawnLink extends Link {
  readonly d: string;
  readonly length: number;
  readonly delay: number;
  readonly dot: { readonly x: number; readonly y: number } | null;
}

function bezierLength(
  x1: number,
  y1: number,
  cx1: number,
  cy1: number,
  cx2: number,
  cy2: number,
  x2: number,
  y2: number,
): number {
  let length = 0;
  let px = x1;
  let py = y1;
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    const u = 1 - t;
    const x = u * u * u * x1 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x2;
    const y = u * u * u * y1 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * y2;
    length += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return length;
}

function pathFor(link: Link, a: Box, z: Box) {
  if (link.style === "primary" || link.style === "chain") {
    const dx = Math.max(18, (z.l - a.r) * 0.5);
    return {
      d: `M${a.r},${a.labelY} C${a.r + dx},${a.labelY} ${z.l - dx},${z.labelY} ${z.l},${z.labelY}`,
      length: bezierLength(a.r, a.labelY, a.r + dx, a.labelY, z.l - dx, z.labelY, z.l, z.labelY),
      start: { x: a.r, y: a.labelY },
    };
  }
  const leftward = a.cx > z.cx;
  const x1 = leftward ? a.l + 14 : a.r - 14;
  const x2 = leftward ? z.r - 14 : z.l + 14;
  const bend = leftward ? 26 : 30;
  return {
    d: `M${x1},${a.b} C${x1},${a.b + bend} ${x2},${z.t - bend} ${x2},${z.t}`,
    length: bezierLength(x1, a.b, x1, a.b + bend, x2, z.t - bend, x2, z.t),
    start: { x: x1, y: a.b },
  };
}

const boxOf = (element: HTMLElement | undefined, base: DOMRect): Box | null => {
  if (element === undefined) return null;
  const r = element.getBoundingClientRect();
  return {
    l: r.left - base.left,
    r: r.right - base.left,
    t: r.top - base.top,
    b: r.bottom - base.top,
    cx: (r.left + r.right) / 2 - base.left,
    labelY: r.top - base.top + Math.min(22, r.height / 2),
  };
};

function drawLinks(links: ReadonlyArray<Link>, box: (id: GroupChatMessageId) => Box | null) {
  const drawn: DrawnLink[] = [];
  links.forEach((link, i) => {
    const a = box(link.from);
    const z = box(link.to);
    if (a === null || z === null) return;
    const path = pathFor(link, a, z);
    drawn.push({
      ...link,
      d: path.d,
      length: path.length,
      delay: links.length <= 1 ? 0 : (i / (links.length - 1)) * LINK_STAGGER_MS,
      dot: link.style === "primary" ? path.start : null,
    });
  });
  return drawn;
}

function drawLinkOnMount(element: SVGPathElement | null) {
  if (element === null || reduceMotion()) return;
  const delay = Number(element.dataset.delay);
  if (element.dataset.style === "seen") {
    element.animate([{ opacity: 0 }, { opacity: 0.7 }], {
      duration: 240,
      delay,
      easing: "ease",
      fill: "both",
    });
    return;
  }
  const length = Number(element.dataset.length);
  element.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], {
    duration: element.dataset.style === "primary" ? 300 : 240,
    delay,
    easing: "cubic-bezier(.3,.7,.2,1)",
    fill: "both",
  });
}

function popDotOnMount(element: SVGCircleElement | null) {
  if (element === null || reduceMotion()) return;
  element.animate(
    [
      { opacity: 0, transform: "scale(.2)" },
      { opacity: 1, transform: "scale(1)" },
    ],
    { duration: 220, fill: "both" },
  );
}

const LINK_CLASS: Record<Link["style"], string> = {
  primary: "[stroke-width:2]",
  chain: "opacity-75 [stroke-width:1.4]",
  named: "[stroke-width:2]",
  seen: "opacity-70 [stroke-dasharray:3_3] [stroke-width:1.4]",
};

const sameSpacers = (
  a: ReadonlyMap<string, ReadonlyArray<Spacer>>,
  b: ReadonlyMap<string, ReadonlyArray<Spacer>>,
) => {
  if (a.size !== b.size) return false;
  for (const [key, spacers] of a) {
    const other = b.get(key);
    if (other === undefined || other.length !== spacers.length) return false;
    if (
      spacers.some(
        (s, i) =>
          s.lane !== other[i]!.lane ||
          s.beforeIndex !== other[i]!.beforeIndex ||
          Math.abs(s.height - other[i]!.height) > 0.5,
      )
    ) {
      return false;
    }
  }
  return true;
};

function blockOfSelection(model: Model, selection: Selection) {
  const packed = model.blocks.filter(
    (b): b is Extract<Block, { kind: "packed" }> => b.kind === "packed",
  );
  return (
    packed.find((b) =>
      b.items.some(
        (item) =>
          item.turnKey === selection.turnKey &&
          (selection.messageId === null || item.id === selection.messageId),
      ),
    ) ?? packed.find((b) => b.items.some((item) => item.turnKey === selection.turnKey))
  );
}

type Spacers = ReadonlyMap<string, ReadonlyArray<Spacer>>;

interface Drawn {
  readonly drawId: number;
  readonly links: ReadonlyArray<DrawnLink>;
}

interface LayoutInputs {
  readonly selection: Selection | null;
  readonly mode: AlignMode;
  readonly model: Model;
  readonly focus: Focus;
}

interface LayoutState {
  readonly cardEls: Map<string, HTMLElement>;
  readonly field: RefObject<HTMLDivElement | null>;
  readonly scroller: RefObject<HTMLDivElement | null>;
  token: number;
  laidOut: Pick<LayoutInputs, "selection" | "mode">;
  spacers: Spacers;
  sliding: boolean;
  /** A draw waits for the commit that applies new spacers or ends a slide. */
  drawPending: boolean;
  drawId: number;
  drawnSignature: string;
  /** The scroll the next draw owes the reader: smooth after a selection, instant after a resize. */
  scrollPending: ScrollBehavior | null;
  /** The reader is at the end, so a card that lands or grows there keeps the end in view. */
  followingEnd: boolean;
  readonly setSpacers: (spacers: Spacers) => void;
  readonly setSliding: (sliding: boolean) => void;
  readonly setDrawn: (update: (current: Drawn) => Drawn) => void;
  readonly setLightBaseMs: (ms: number) => void;
}

function keepInView(state: LayoutState, inputs: LayoutInputs, behavior: ScrollBehavior) {
  const element = state.scroller.current;
  const { selection, focus, model } = inputs;
  if (element === null || selection === null) return;
  const scrollBy = (top: number) => {
    state.followingEnd = false;
    element.scrollBy({ top, behavior });
  };
  const rects = [...focus.emphasis.keys()]
    .map((id) => state.cardEls.get(id)?.getBoundingClientRect())
    .filter((rect): rect is DOMRect => rect !== undefined);
  if (rects.length === 0) return;
  const viewport = element.getBoundingClientRect();
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const focalId = selection.messageId ?? model.turnByKey.get(selection.turnKey)?.prompt ?? null;
  const focal =
    (focalId === null ? undefined : state.cardEls.get(focalId)?.getBoundingClientRect()) ??
    rects[0]!;
  if (bottom - top <= viewport.height - HEADER_PX - 24) {
    if (top < viewport.top + HEADER_PX + 8) scrollBy(top - viewport.top - HEADER_PX - 12);
    else if (bottom > viewport.bottom - 12) scrollBy(bottom - viewport.bottom + 16);
  } else if (focal.top < viewport.top + HEADER_PX || focal.bottom > viewport.bottom - 20) {
    scrollBy(focal.top - viewport.top - HEADER_PX - 50);
  }
}

const turnIndexOf = (model: Model) =>
  new Map(model.turns.map((turn) => [turn.key, turn.index] as const));

function placeSpacers(state: LayoutState, inputs: LayoutInputs): boolean {
  const { selection, mode, model } = inputs;
  const next = new Map<string, ReadonlyArray<Spacer>>();
  if (mode === "line" && selection !== null) {
    const block = blockOfSelection(model, selection);
    if (block !== undefined) {
      const lanesItems = model.lanes.map((lane) => {
        const items = block.items.filter((item) => item.lane === lane.id);
        return {
          lane: lane.id,
          items,
          heights: items.map((item) => state.cardEls.get(item.id)?.offsetHeight ?? 0),
        };
      });
      next.set(
        block.key,
        alignTurn({ lanesItems, turnKey: selection.turnKey, turnIndex: turnIndexOf(model) }),
      );
    }
  }
  const moved = !sameSpacers(next, state.spacers);
  if (moved) {
    state.spacers = next;
    state.setSpacers(next);
  }
  return moved;
}

function setSliding(state: LayoutState, sliding: boolean): boolean {
  const changed = sliding !== state.sliding;
  state.sliding = sliding;
  state.setSliding(sliding);
  return changed;
}

/** Measures the cards as they stand and draws the links, then pays the scroll the reader is owed. */
function draw(state: LayoutState, inputs: LayoutInputs) {
  const base = state.field.current?.getBoundingClientRect();
  if (base === undefined) return;
  const links = drawLinks(inputs.focus.links, (id) => boxOf(state.cardEls.get(id), base));
  const signature = `${state.drawId}:${links.map((link) => link.d).join("|")}`;
  if (signature !== state.drawnSignature) {
    state.drawnSignature = signature;
    state.setDrawn(() => ({ drawId: state.drawId, links }));
  }
  if (state.scrollPending !== null) {
    keepInView(state, inputs, state.scrollPending);
    state.scrollPending = null;
  }
}

function clearFocus(state: LayoutState) {
  state.drawnSignature = "";
  state.drawPending = false;
  state.scrollPending = null;
  state.setDrawn((current) => (current.links.length === 0 ? current : { ...current, links: [] }));
  state.setLightBaseMs(0);
}

/** A change of selection or mode: lanes that move slide, and the links follow once the slide ends. */
function layoutSelection(state: LayoutState, inputs: LayoutInputs) {
  state.token += 1;
  const moved = placeSpacers(state, inputs);
  const slide = moved && !reduceMotion();
  const slidingChanged = setSliding(state, slide);
  if (inputs.selection === null) {
    clearFocus(state);
    return;
  }
  state.drawId += 1;
  state.setLightBaseMs(slide ? SLIDE_MS : 0);
  state.scrollPending = "smooth";
  if (moved || slidingChanged || state.drawPending) state.drawPending = true;
  else draw(state, inputs);
}

/** Cards moved or changed size: reposition at once, and redraw in place once the commit shows it. */
function layoutGeometry(state: LayoutState, inputs: LayoutInputs) {
  state.token += 1;
  const moved = placeSpacers(state, inputs);
  const slidingChanged = setSliding(state, false);
  if (inputs.selection === null) {
    clearFocus(state);
    return;
  }
  if (moved || slidingChanged || state.drawPending) state.drawPending = true;
  else draw(state, inputs);
}

function layout(state: LayoutState, inputs: LayoutInputs) {
  const changed =
    inputs.selection !== state.laidOut.selection || inputs.mode !== state.laidOut.mode;
  state.laidOut = { selection: inputs.selection, mode: inputs.mode };
  if (changed) layoutSelection(state, inputs);
  else layoutGeometry(state, inputs);
}

const laneTitle = (lane: Lane) =>
  lane.member === null
    ? ""
    : memberSubtitle(lane.member) + (lane.member.removedAt === null ? "" : " (removed)");

const laneDot = (lane: Lane) =>
  lane.member === null ? "var(--muted-foreground)" : memberColor(lane.member.color);

function LaneDivider({
  block,
  selected,
  dimmed,
  onSelect,
}: {
  readonly block: Extract<Block, { kind: "divider" }>;
  readonly selected: boolean;
  readonly dimmed: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="lane-divider"
      data-turn={block.turnKey}
      data-tone={block.tone}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      className={cn(
        "group/divider relative z-[1] flex w-full cursor-pointer items-center gap-2.5 pt-1 pb-3 text-2xs text-muted-foreground transition-opacity duration-300",
        dimmed && "opacity-50",
      )}
    >
      <span className="flex-1 border-t border-dashed border-border" />
      <span
        className={cn(
          "whitespace-nowrap rounded-full bg-background px-2 py-px group-hover/divider:text-foreground",
          selected && "text-foreground",
        )}
      >
        <strong
          className={cn(
            "font-semibold",
            block.tone === "ended" ? "text-foreground" : "text-foreground/72",
          )}
        >
          {block.label}
        </strong>
        {block.detail === null ? null : <span> · {block.detail}</span>}
      </span>
      <span className="flex-1 border-t border-dashed border-border" />
    </button>
  );
}

export function SwimLanes({ groupId, view }: { groupId: GroupChatGroupId; view: GroupView }) {
  const model = buildModel(view);
  const [mode, setMode] = useState<AlignMode>(readMode);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [spacers, setSpacers] = useState<Spacers>(new Map());
  const [sliding, setSliding] = useState(false);
  const [drawn, setDrawn] = useState<Drawn>({ drawId: 0, links: [] });
  const [lightBaseMs, setLightBaseMs] = useState(0);
  const [markdownIds, setMarkdownIds] = useState<ReadonlySet<string>>(() => new Set());
  const field = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const markdownObserver = useRef<IntersectionObserver | null>(null);
  // Built once in a state initializer so render never reads or writes the ref.
  const [initialLayout] = useState<LayoutState>(() => ({
    cardEls: new Map(),
    field,
    scroller,
    token: 0,
    laidOut: { selection: null, mode: "packed" },
    spacers: new Map(),
    sliding: false,
    drawPending: false,
    drawId: 0,
    drawnSignature: "",
    scrollPending: null,
    followingEnd: true,
    setSpacers,
    setSliding,
    setDrawn,
    setLightBaseMs,
  }));
  const layoutState = useRef<LayoutState>(initialLayout);
  const olderPage = useRef<OlderPageState>(idleOlderPage);
  const [olderRetryAt, setOlderRetryAt] = useState<number | null>(null);
  const olderAnchor = useRef<{
    readonly lowSeq: number;
    readonly scrollHeight: number;
    readonly scrollTop: number;
  } | null>(null);

  const selection = selected !== null && model.turnByKey.has(selected.turnKey) ? selected : null;
  const turn = selection === null ? null : model.turnByKey.get(selection.turnKey)!;
  const colorOf = (memberId: GroupChatMemberId) => {
    const member = view.members.get(memberId);
    return member === undefined ? "var(--muted-foreground)" : memberColor(member.color);
  };
  const focus: Focus = focusFor(model, selection, colorOf, ACCENT);
  const lightIndex = new Map(focus.lightOrder.map((id, index) => [id, index] as const));

  const selectMessage = useStableCallback((message: GroupChatMessage) => {
    setSelected({ turnKey: message.turnKey, messageId: message.id });
  });
  const step = useStableCallback((delta: 1 | -1) => {
    setSelected(stepSelection(model, selection, delta));
  });
  const clearSelection = useStableCallback(() => {
    if (selection === null) return false;
    setSelected(null);
    return true;
  });
  const relayoutGeometry = useStableCallback((resized: boolean) => {
    const state = layoutState.current!;
    if (resized && state.scrollPending === null) state.scrollPending = "auto";
    layoutGeometry(state, { selection, mode, model, focus });
    const element = scroller.current;
    if (element !== null && state.followingEnd && (!resized || selection === null)) {
      element.scrollTop = element.scrollHeight;
    }
  });
  const follow = useStableCallback((event: FollowEvent) => {
    const element = scroller.current;
    const state = layoutState.current!;
    if (element !== null) {
      state.followingEnd = followAfter(state.followingEnd, event, geometryOf(element));
    }
  });
  const registerSlot = useStableCallback((element: HTMLDivElement | null) => {
    if (element === null) return;
    const state = layoutState.current!;
    const id = element.dataset.itemId!;
    state.cardEls.set(id, element);
    markdownObserver.current?.observe(element);
    return () => {
      markdownObserver.current?.unobserve(element);
      if (state.cardEls.get(id) === element) state.cardEls.delete(id);
    };
  });
  const switchMode = (next: AlignMode) => {
    setMode(next);
    localStorage.setItem(MODE_KEY, next);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a captured document key listener, so the chat underneath never sees a key the lanes took.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isCommandPaletteOpen()) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditableFocused(event.target) || onControl(event.target)) return;
      if (event.target instanceof Element && event.target.closest("[role=dialog]") !== null) return;
      if (event.key === "j" || event.key === "ArrowDown") step(1);
      else if (event.key === "k" || event.key === "ArrowUp") step(-1);
      else if (event.key === "Escape" && !clearSelection()) return;
      else if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [step, clearSelection]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- only a reader's gesture on the scroller leaves the end; a pin or the lanes' own scroll never does.
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => follow({ kind: "wheel", deltaY: event.deltaY });
    const onTouchMove = () => follow({ kind: "touch" });
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === element) follow({ kind: "scrollbar" });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        keyTowardStart(event.key) &&
        !event.defaultPrevented &&
        !isEditableFocused(event.target)
      ) {
        follow({ kind: "key", key: event.key });
      }
    };
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: true });
    element.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [follow]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a resize of the scroller re-lays out the lanes.
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    let size = `${element.clientWidth}x${element.clientHeight}`;
    return observeResize(element, () => {
      const next = `${element.clientWidth}x${element.clientHeight}`;
      if (next === size) return;
      size = next;
      relayoutGeometry(true);
    });
  }, [relayoutGeometry]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one resize subscription for every card, so many resized cards lay out once.
  useLayoutEffect(() => {
    const state = layoutState.current!;
    const slots = model.blocks.flatMap((block) =>
      block.kind === "packed"
        ? block.items.flatMap((item) => state.cardEls.get(item.id) ?? [])
        : [],
    );
    return observeResize(slots, () => relayoutGeometry(false));
  }, [model, relayoutGeometry]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the lanes open pinned to the end before the first paint.
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cards render markdown once they near the viewport, which only an IntersectionObserver reports.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const ids = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => (entry.target as HTMLElement).dataset.itemId!);
        if (ids.length === 0) return;
        setMarkdownIds((current) => {
          if (ids.every((id) => current.has(id))) return current;
          return new Set([...current, ...ids]);
        });
      },
      { root: scroller.current, rootMargin: MARKDOWN_ROOT_MARGIN },
    );
    markdownObserver.current = observer;
    for (const element of layoutState.current!.cardEls.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      markdownObserver.current = null;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- card positions are measured from the committed DOM before paint.
  useLayoutEffect(() => {
    layout(layoutState.current!, { selection, mode, model, focus });
  }, [selection, mode, model, focus]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the commit that applied new spacers, or ended a slide, is the one to measure.
  useLayoutEffect(() => {
    const state = layoutState.current!;
    if (!state.drawPending || spacers !== state.spacers || sliding !== state.sliding) return;
    state.drawPending = false;
    const inputs = { selection, mode, model, focus };
    if (!sliding) {
      draw(state, inputs);
      return;
    }
    const my = state.token;
    const timer = setTimeout(() => {
      if (my === state.token) draw(state, inputs);
    }, SLIDE_MS + 40);
    return () => clearTimeout(timer);
  }, [spacers, sliding, selection, mode, model, focus]);

  const requestOlder = useStableCallback((reason: OlderPageReason) => {
    const element = scroller.current;
    const before = view.olderBefore;
    if (element === null || before === null || view.loadingOlder) return;
    const now = Date.now();
    if (!mayRequestOlder(olderPage.current, { before, reason, now })) return;
    const wasFailed = olderPage.current.kind === "failed";
    olderPage.current = olderRequested(before);
    olderAnchor.current = {
      lowSeq: view.lowSeq,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
    void loadOlder(groupId).then(
      (loaded) => {
        olderPage.current = olderRead(olderPage.current, loaded ? "loaded" : "empty", Date.now());
        if (!loaded) olderAnchor.current = null;
      },
      () => {
        const failed = olderRead(olderPage.current, "failed", Date.now());
        const next = wasFailed ? olderFailedAgain(failed, Date.now()) : failed;
        olderPage.current = next;
        olderAnchor.current = null;
        setOlderRetryAt(next.kind === "failed" ? next.retryAt : null);
      },
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the retry timer calls requestOlder, which cannot schedule itself; each failure resets it.
  useEffect(() => {
    if (olderRetryAt === null) return;
    const timer = setTimeout(
      () => {
        setOlderRetryAt(null);
        const element = scroller.current;
        if (element !== null && underfilled(element)) requestOlder("underfill");
      },
      Math.max(0, olderRetryAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [olderRetryAt, requestOlder]);
  const onScroll = () => {
    const element = scroller.current;
    if (element === null) return;
    follow({ kind: "scroll" });
    if (element.scrollTop < OLDER_THRESHOLD_PX) requestOlder("scroll");
  };

  const followedSeq = useRef(view.highSeq);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a newer message, never an older page, moves a reader who is at the end, after it commits.
  useLayoutEffect(() => {
    const element = scroller.current;
    const newer = view.highSeq > followedSeq.current;
    followedSeq.current = view.highSeq;
    if (element !== null && newer && layoutState.current!.followingEnd) {
      element.scrollTop = element.scrollHeight;
    }
  }, [view.highSeq]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an older page keeps the reader's place and fills a short view once it commits.
  useLayoutEffect(() => {
    const element = scroller.current;
    const anchor = olderAnchor.current;
    if (element === null) return;
    if (anchor !== null && anchor.lowSeq !== view.lowSeq) {
      element.scrollTop = anchor.scrollTop + (element.scrollHeight - anchor.scrollHeight);
      olderAnchor.current = null;
    }
    if (view.olderBefore === null || view.loadingOlder) return;
    if (underfilled(element)) requestOlder("underfill");
  }, [view.lowSeq, view.olderBefore, view.loadingOlder, requestOlder]);

  const spacerFor = (blockKey: string, lane: string, index: number) =>
    spacers.get(blockKey)?.find((s) => s.lane === lane && s.beforeIndex === index)?.height ?? 0;

  const lightDelayFor = (id: GroupChatMessageId) => {
    const emphasis = focus.emphasis.get(id);
    const index = lightIndex.get(id) ?? 0;
    if (emphasis === undefined || index === 0 || emphasis === "selected" || emphasis === "anchor") {
      return 0;
    }
    const lit = focus.lightOrder.length - 1;
    const stagger = lit <= 1 ? 0 : ((index - 1) / (lit - 1)) * LIGHT_STAGGER_MS;
    return lightBaseMs + LIGHT_LEAD_MS + stagger;
  };

  const memberLanes = model.lanes.length - 1;
  const columns = `minmax(${OPERATOR_LANE_MIN_PX}px, 1fr) repeat(${memberLanes}, minmax(${MEMBER_LANE_MIN_PX}px, 1fr))`;
  const minWidth =
    OPERATOR_LANE_MIN_PX + memberLanes * (MEMBER_LANE_MIN_PX + LANE_GAP_PX) + FIELD_PADDING_PX;
  const position =
    turn === null
      ? `${model.turns.length} ${model.turns.length === 1 ? "turn" : "turns"}`
      : `${turn.label === "Turn" ? "Turn" : `${turn.label} · turn`} ${turn.index + 1} of ${model.turns.length}${
          focus.statusLine === null ? "" : ` · ${focus.statusLine}`
        }`;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="swim-lanes"
      data-mode={mode}
      data-focus={selection === null ? undefined : ""}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
        <ToggleGroup
          aria-label="Lane layout"
          variant="segmented"
          value={[mode]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "packed" || value === "line") switchMode(value);
          }}
        >
          <Toggle value="packed" data-testid="lanes-mode-packed">
            Packed
          </Toggle>
          <Toggle value="line" data-testid="lanes-mode-line">
            Line up on select
          </Toggle>
        </ToggleGroup>
        <Button
          size="xs"
          variant="outline"
          onClick={() => step(-1)}
          aria-label="Previous turn"
          disabled={turn !== null && turn.index === 0}
        >
          ↑ Prev turn
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => step(1)}
          aria-label="Next turn"
          disabled={turn !== null && turn.index === model.turns.length - 1}
        >
          Next turn ↓
        </Button>
        <span data-testid="turn-position" className="tabular-nums">
          {position}
        </span>
        <span className="ms-auto hidden 2xl:inline">
          Click a message to select its turn · j and k move between turns · Esc clears
        </span>
      </div>
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
        onScroll={onScroll}
        onClick={(event) => {
          if (!onControl(event.target)) setSelected(null);
        }}
      >
        <div className="px-4 pb-10" style={{ minWidth }}>
          <div
            className="sticky top-0 z-10 grid gap-x-4 border-b border-border bg-background py-2 text-xs font-semibold"
            style={{ gridTemplateColumns: columns }}
          >
            {model.lanes.map((lane) => (
              <div
                key={lane.id}
                data-testid="lane-header"
                className="flex min-w-0 items-center gap-1.5"
                style={{ color: lane.member === null ? undefined : laneDot(lane) }}
              >
                <span
                  className="size-[7px] shrink-0 rounded-full"
                  style={{ background: laneDot(lane) }}
                />
                <span className="shrink-0">
                  {lane.member === null ? "You" : `@${lane.member.handle}`}
                </span>
                <span className="min-w-0 truncate font-normal text-muted-foreground">
                  {laneTitle(lane)}
                </span>
              </div>
            ))}
          </div>
          <div ref={field} className="relative pt-3">
            <svg
              className="pointer-events-none absolute inset-0 z-0 size-full overflow-visible"
              aria-hidden="true"
            >
              {drawn.links.map((link) => (
                <g key={`${drawn.drawId}-${link.from}-${link.to}`}>
                  <path
                    ref={drawLinkOnMount}
                    d={link.d}
                    fill="none"
                    data-testid="lane-link"
                    data-style={link.style}
                    data-from={link.from}
                    data-to={link.to}
                    data-delay={link.delay}
                    data-length={link.length}
                    className={cn("[stroke-linecap:round]", LINK_CLASS[link.style])}
                    style={
                      link.style === "seen"
                        ? { stroke: link.color }
                        : {
                            stroke: link.color,
                            strokeDasharray: link.length,
                            strokeDashoffset: 0,
                          }
                    }
                  />
                  {link.dot === null ? null : (
                    <circle
                      ref={popDotOnMount}
                      cx={link.dot.x}
                      cy={link.dot.y}
                      r={3.2}
                      style={{
                        fill: link.color,
                        transformOrigin: `${link.dot.x}px ${link.dot.y}px`,
                      }}
                    />
                  )}
                </g>
              ))}
            </svg>
            {model.blocks.map((block) =>
              block.kind === "divider" ? (
                <LaneDivider
                  key={block.key}
                  block={block}
                  selected={turn?.key === block.turnKey}
                  dimmed={selection !== null && turn?.key !== block.turnKey}
                  onSelect={() => {
                    const target = model.turnByKey.get(block.turnKey);
                    setSelected({
                      turnKey: block.turnKey,
                      messageId: target === undefined ? null : focalOf(target),
                    });
                  }}
                />
              ) : (
                <div
                  key={block.key}
                  data-testid="lane-block"
                  className="grid items-start gap-x-4 pb-2.5"
                  style={{ gridTemplateColumns: columns }}
                >
                  {model.lanes.map((lane) => {
                    const items = block.items.filter((item) => item.lane === lane.id);
                    return (
                      <div key={lane.id} className="flex min-w-0 flex-col" data-lane={lane.id}>
                        {items.map((item, index) => (
                          <div
                            key={item.id}
                            ref={registerSlot}
                            data-item-id={item.id}
                            className={cn(
                              "relative z-[1]",
                              sliding && "transition-[margin-top] duration-300 ease-drawer",
                            )}
                            style={{
                              marginTop:
                                spacerFor(block.key, lane.id, index) + (index === 0 ? 0 : 10),
                            }}
                          >
                            {item.kind === "message" ? (
                              <LaneCard
                                message={item.message}
                                member={
                                  item.message.author._tag === "member"
                                    ? view.members.get(item.message.author.memberId)
                                    : undefined
                                }
                                recipients={item.message.recipients.map((id) =>
                                  view.members.get(id),
                                )}
                                discussion={
                                  item.message.discussionId === null
                                    ? undefined
                                    : view.discussions.get(item.message.discussionId)
                                }
                                emphasis={focus.emphasis.get(item.message.id)}
                                dimmed={selection !== null && !focus.emphasis.has(item.message.id)}
                                lightDelayMs={lightDelayFor(item.message.id)}
                                markdown={markdownIds.has(item.id)}
                                onSelect={selectMessage}
                              />
                            ) : (
                              <PendingCard
                                delivery={item.delivery}
                                member={view.members.get(item.delivery.memberId)}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ),
            )}
            {model.turns.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">No messages yet.</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
