import type {
  GroupChatGroupId,
  GroupChatMemberId,
  GroupChatMessage,
  GroupChatMessageId,
} from "@t3tools/contracts";
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { Button } from "../../components/ui/button";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { useStableCallback } from "../../hooks/useStableCallback";
import { isEditableFocused } from "../../lib/editableFocus";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { memberColor } from "../MemberChip";
import { type GroupView, loadOlder } from "../store";
import { ACCENT, LaneCard, PendingCard } from "./LaneCard";
import {
  type AlignMode,
  alignTurn,
  type Block,
  buildModel,
  firstReplyOfLaterRound,
  type Focus,
  focusFor,
  type Lane,
  type Link,
  type Model,
  type Selection,
  type Spacer,
  stepSelection,
} from "./model";

const SLIDE_MS = 500;
const LIGHT_LEAD_MS = 260;
const LIGHT_STEP_MS = 120;
const LINK_STEP_MS = 120;
const HEADER_PX = 40;
const OLDER_THRESHOLD_PX = 240;
const MODE_KEY = "t3.groupChat.lanes.mode";

const readMode = (): AlignMode => (localStorage.getItem(MODE_KEY) === "line" ? "line" : "packed");

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Box {
  readonly l: number;
  readonly r: number;
  readonly t: number;
  readonly b: number;
  readonly cx: number;
  /** The label line, where ordinary links attach. */
  readonly y: number;
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

/**
 * An ordinary link runs from the right edge of one card to the left edge of the next at the label
 * line. A discussion link runs from the bottom of a previous-round reply down into the reply it fed.
 */
function pathFor(link: Link, a: Box, z: Box) {
  if (link.style === "primary" || link.style === "chain") {
    const dx = Math.max(18, (z.l - a.r) * 0.5);
    return {
      d: `M${a.r},${a.y} C${a.r + dx},${a.y} ${z.l - dx},${z.y} ${z.l},${z.y}`,
      length: bezierLength(a.r, a.y, a.r + dx, a.y, z.l - dx, z.y, z.l, z.y),
      start: { x: a.r, y: a.y },
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
    y: r.top - base.top + Math.min(22, r.height / 2),
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
      delay: i * LINK_STEP_MS,
      dot: link.style === "primary" ? path.start : null,
    });
  });
  return drawn;
}

/** Draws a link outward once, when it mounts. A silent redraw keeps the element and only moves it. */
function animateLink(element: SVGPathElement | null) {
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
    duration: element.dataset.style === "primary" ? 380 : 300,
    delay,
    easing: "cubic-bezier(.3,.7,.2,1)",
    fill: "both",
  });
}

function animateDot(element: SVGCircleElement | null) {
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
          s.before !== other[i]!.before ||
          Math.abs(s.height - other[i]!.height) > 0.5,
      )
    ) {
      return false;
    }
  }
  return true;
};

/** The packed block the selection sits in: the focused card's, else the first with the turn. */
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
  readonly gen: number;
  readonly links: ReadonlyArray<DrawnLink>;
}

interface LayoutInputs {
  readonly selection: Selection | null;
  readonly mode: AlignMode;
  readonly model: Model;
  readonly focus: Focus;
}

/** What the layout keeps between runs. Refs and setters, never read during render. */
interface LayoutContext {
  readonly cardEls: Map<string, HTMLElement>;
  readonly field: RefObject<HTMLDivElement | null>;
  readonly scroller: RefObject<HTMLDivElement | null>;
  token: number;
  laidOut: string;
  resized: boolean;
  generation: number;
  drawnSignature: string;
  spacers: Spacers;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly setSpacers: (spacers: Spacers) => void;
  readonly setSliding: (sliding: boolean) => void;
  readonly setDrawn: (update: (current: Drawn) => Drawn) => void;
  readonly setLightBaseMs: (ms: number) => void;
}

/** Keeps the turn in view: all of it when it fits, otherwise its focal card near the top. */
function keepInView(ctx: LayoutContext, inputs: LayoutInputs, behavior: ScrollBehavior) {
  const element = ctx.scroller.current;
  const { selection, focus, model } = inputs;
  if (element === null || selection === null) return;
  const rects = [...focus.emphasis.keys()]
    .map((id) => ctx.cardEls.get(id)?.getBoundingClientRect())
    .filter((rect): rect is DOMRect => rect !== undefined);
  if (rects.length === 0) return;
  const viewport = element.getBoundingClientRect();
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const focalId = selection.messageId ?? model.turnByKey.get(selection.turnKey)?.promptId ?? null;
  const focal =
    (focalId === null ? undefined : ctx.cardEls.get(focalId)?.getBoundingClientRect()) ?? rects[0]!;
  if (bottom - top <= viewport.height - HEADER_PX - 24) {
    if (top < viewport.top + HEADER_PX + 8) {
      element.scrollBy({ top: top - viewport.top - HEADER_PX - 12, behavior });
    } else if (bottom > viewport.bottom - 12) {
      element.scrollBy({ top: bottom - viewport.bottom + 16, behavior });
    }
  } else if (focal.top < viewport.top + HEADER_PX || focal.bottom > viewport.bottom - 20) {
    element.scrollBy({ top: focal.top - viewport.top - HEADER_PX - 50, behavior });
  }
}

/**
 * Line mode slides lanes by spacers before the selected turn, then the links are drawn once the
 * slide has settled. A geometry change (a reply landing, a card expanding, a resize) repositions
 * at once and redraws silently, and a resize also brings the selection back into view.
 */
function relayout(ctx: LayoutContext, inputs: LayoutInputs) {
  const { selection, mode, model, focus } = inputs;
  const my = ++ctx.token;
  clearTimeout(ctx.timer);
  const cause =
    selection === null ? "" : `${selection.turnKey}|${selection.messageId ?? ""}|${mode}`;
  const userChange = cause !== ctx.laidOut;
  ctx.laidOut = cause;

  const next = new Map<string, ReadonlyArray<Spacer>>();
  if (mode === "line" && selection !== null) {
    const block = blockOfSelection(model, selection);
    if (block !== undefined) {
      const lanesItems = model.lanes.map((lane) => {
        const items = block.items.filter((item) => item.lane === lane.id);
        return {
          lane: lane.id,
          items,
          heights: items.map((item) => ctx.cardEls.get(item.id)?.offsetHeight ?? 0),
        };
      });
      next.set(
        block.key,
        alignTurn({
          lanesItems,
          turnKey: selection.turnKey,
          focusMessageId: selection.messageId,
          strategy: "lowest",
        }),
      );
    }
  }
  const moved = !sameSpacers(next, ctx.spacers);
  if (moved) {
    ctx.spacers = next;
    ctx.setSpacers(next);
  }
  const slide = moved && userChange && !reduceMotion();
  ctx.setSliding(slide);

  if (selection === null) {
    ctx.drawnSignature = "";
    ctx.setDrawn((current) => (current.links.length === 0 ? current : { ...current, links: [] }));
    ctx.setLightBaseMs(0);
    return;
  }
  if (userChange) ctx.generation += 1;
  const delay = slide ? SLIDE_MS : 0;
  ctx.setLightBaseMs(delay);
  const draw = () => {
    if (my !== ctx.token) return;
    const base = ctx.field.current?.getBoundingClientRect();
    if (base === undefined) return;
    const links = drawLinks(focus.links, (id) => boxOf(ctx.cardEls.get(id), base));
    const signature = `${ctx.generation}:${links.map((link) => link.d).join("|")}`;
    if (signature !== ctx.drawnSignature) {
      ctx.drawnSignature = signature;
      ctx.setDrawn(() => ({ gen: ctx.generation, links }));
    }
    if (userChange) keepInView(ctx, inputs, "smooth");
    else if (ctx.resized) {
      ctx.resized = false;
      keepInView(ctx, inputs, "auto");
    }
  };
  if (delay === 0) draw();
  else ctx.timer = setTimeout(draw, delay + 40);
}

const laneTitle = (lane: Lane) =>
  lane.member === null
    ? ""
    : lane.member.thread.title + (lane.member.removedAt === null ? "" : " (removed)");

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
  const model = useMemo(() => buildModel(view), [view]);
  const [mode, setMode] = useState<AlignMode>(readMode);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [spacers, setSpacers] = useState<Spacers>(new Map());
  const [sliding, setSliding] = useState(false);
  const [drawn, setDrawn] = useState<Drawn>({ gen: 0, links: [] });
  const [lightBaseMs, setLightBaseMs] = useState(0);
  const field = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const layout = useRef<LayoutContext>(null);
  layout.current ??= {
    cardEls: new Map(),
    field,
    scroller,
    token: 0,
    laidOut: "",
    resized: false,
    generation: 0,
    drawnSignature: "",
    spacers: new Map(),
    timer: undefined,
    setSpacers,
    setSliding,
    setDrawn,
    setLightBaseMs,
  };
  const olderAnchor = useRef<{
    readonly lowSeq: number;
    readonly scrollHeight: number;
    readonly scrollTop: number;
  } | null>(null);

  const selection = selected !== null && model.turnByKey.has(selected.turnKey) ? selected : null;
  const turn = selection === null ? null : model.turnByKey.get(selection.turnKey)!;
  const focus: Focus = useMemo(() => {
    const colorOf = (memberId: GroupChatMemberId) => {
      const member = view.members.get(memberId);
      return member === undefined ? "var(--muted-foreground)" : memberColor(member.color);
    };
    return focusFor(model, selection, colorOf, ACCENT);
  }, [model, selection, view.members]);
  const lightOrder = useMemo(
    () => new Map(focus.order.map((id, index) => [id, index] as const)),
    [focus.order],
  );

  const selectMessage = useStableCallback((message: GroupChatMessage) => {
    setSelected({ turnKey: message.turnKey, messageId: message.id });
  });
  const step = useStableCallback((delta: 1 | -1) => {
    setSelected(stepSelection(model, selection, delta));
  });
  const relayoutLatest = useStableCallback(() => {
    relayout(layout.current!, { selection, mode, model, focus });
  });
  const registerSlot = useStableCallback((element: HTMLDivElement | null) => {
    if (element === null) return;
    const ctx = layout.current!;
    const id = element.dataset.itemId!;
    ctx.cardEls.set(id, element);
    const stop = observeResize(element, relayoutLatest);
    return () => {
      stop();
      if (ctx.cardEls.get(id) === element) ctx.cardEls.delete(id);
    };
  });
  const switchMode = (next: AlignMode) => {
    setMode(next);
    localStorage.setItem(MODE_KEY, next);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isCommandPaletteOpen()) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditableFocused(event.target)) return;
      if (event.target instanceof Element && event.target.closest("[role=dialog]") !== null) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        step(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        step(-1);
      } else if (event.key === "Escape") {
        setSelected((current) => {
          if (current !== null) event.preventDefault();
          return null;
        });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [step]);

  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    let width = element.clientWidth;
    return observeResize(element, () => {
      const next = element.clientWidth;
      if (next === width) return;
      width = next;
      layout.current!.resized = true;
      relayoutLatest();
    });
  }, [relayoutLatest]);

  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, []);

  useLayoutEffect(() => {
    const ctx = layout.current!;
    relayout(ctx, { selection, mode, model, focus });
    return () => clearTimeout(ctx.timer);
  }, [selection, mode, model, focus]);

  const onScroll = () => {
    const element = scroller.current;
    if (element === null || olderAnchor.current !== null) return;
    if (element.scrollTop >= OLDER_THRESHOLD_PX || view.olderBefore === null || view.loadingOlder) {
      return;
    }
    olderAnchor.current = {
      lowSeq: view.lowSeq,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
    void loadOlder(groupId).then(
      (loaded) => {
        if (!loaded) olderAnchor.current = null;
      },
      () => {
        olderAnchor.current = null;
      },
    );
  };

  // An older page lands above everything loaded, so the view is moved by what it added.
  useLayoutEffect(() => {
    const element = scroller.current;
    const anchor = olderAnchor.current;
    if (element === null || anchor === null || anchor.lowSeq === view.lowSeq) return;
    element.scrollTop = anchor.scrollTop + (element.scrollHeight - anchor.scrollHeight);
    olderAnchor.current = null;
  }, [view.lowSeq]);

  const spacerFor = (blockKey: string, lane: string, index: number) =>
    spacers.get(blockKey)?.find((s) => s.lane === lane && s.before === index)?.height ?? 0;

  const lightDelayFor = (id: GroupChatMessageId) => {
    const emphasis = focus.emphasis.get(id);
    const index = lightOrder.get(id) ?? 0;
    return emphasis !== undefined && index > 0 && emphasis !== "selected" && emphasis !== "anchor"
      ? lightBaseMs + LIGHT_LEAD_MS + (index - 1) * LIGHT_STEP_MS
      : 0;
  };

  const laneCount = model.lanes.length;
  // Three members fit a 1024-wide window beside the sidebar; more lanes scroll sideways.
  const columns = `minmax(150px, 1fr) repeat(${laneCount - 1}, minmax(176px, 1fr))`;
  const minWidth = 150 + (laneCount - 1) * 176 + (laneCount - 1) * 16 + 32;
  const position =
    turn === null
      ? `${model.turns.length} ${model.turns.length === 1 ? "turn" : "turns"}`
      : `${turn.label === "Turn" ? "Turn" : `${turn.label} · turn`} ${turn.index + 1} of ${model.turns.length}${
          focus.summary === null ? "" : ` · ${focus.summary}`
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
        <span className="ms-auto hidden xl:inline">
          Click a message to select its turn · j and k move between turns · Esc clears
        </span>
      </div>
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
        onScroll={onScroll}
        onClick={() => setSelected(null)}
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
                <g key={`${drawn.gen}-${link.from}-${link.to}`}>
                  <path
                    ref={animateLink}
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
                      ref={animateDot}
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
                      messageId: target === undefined ? null : firstReplyOfLaterRound(target),
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
                              sliding && "transition-[margin-top] duration-500 ease-drawer",
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
