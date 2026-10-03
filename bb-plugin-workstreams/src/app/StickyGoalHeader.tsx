import { useBbContext } from "@get-bb/plugin-sdk/app";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMediaQuery } from "@/components/ui/hooks/use-media-query";
import { useGoalContext } from "./goalContext.ts";
import {
  PAD_TOP,
  PHONE_QUERY,
  PINNED_PAD,
  SUBTITLE_SIZE,
  TITLE_BAR_TITLE_SIZE,
  TITLE_LINE,
  TITLE_SIZE,
  compactBlock,
  eyebrowMetrics,
  headingHeight,
  pinnedHeight,
} from "./goalHeading.ts";
import { WorkstreamIcon } from "./WorkstreamIcon.tsx";

const SCROLLER = "[data-thread-window] .thread-scrollbar";
/** BB's composer shell, which holds the recap and question cards. */
const COMPOSER = "[data-app-composer]";
/**
 * BB's sliding app surface. On a phone it translates aside to reveal the
 * sidebar and the right panel, so whatever is drawn over the thread has to
 * live inside it to travel with the pane.
 */
const INSET = '[data-sidebar="inset"]';

// The heading is laid out in the same column as the messages so it shares
// their left edge and type. BB's scroller wraps that column in one extra div.
function messageColumn(scroller: HTMLElement): HTMLElement | null {
  const column = scroller.firstElementChild?.firstElementChild;
  return column instanceof HTMLElement ? column : null;
}

/** Smallest title-bar gap worth drawing the heading into. */
const MIN_TITLE_BAR_WIDTH = 140;
const TITLE_BAR_GAP = 16;

/** Below this scroller width the title may wrap to a second line. */
const NARROW_PX = 560;
/**
 * Below this scroller height (a phone on its side, or a soft keyboard up) the
 * expanded heading would take too much of the timeline, so it stays compact.
 */
const SHORT_PX = 400;

type Mount = {
  scroller: HTMLElement;
  /** Parent of the heading: the column that holds the timeline messages. */
  column: HTMLElement;
  /** Body font size of the timeline, so the heading scales with the text. */
  baseFontSize: number;
  /** Zero-height sticky anchor at the top of the column. */
  root: HTMLElement;
  /** Zero-size layer over the thread pane that draws the heading text. */
  overlay: HTMLElement;
  threadId: string;
  previousScrollPaddingTop: string;
  previousScrollPaddingPriority: string;
};

function detach(mount: Mount | null): void {
  if (!mount) return;
  mount.root.remove();
  mount.overlay.remove();
  if (mount.previousScrollPaddingTop) {
    mount.scroller.style.setProperty(
      "scroll-padding-top",
      mount.previousScrollPaddingTop,
      mount.previousScrollPaddingPriority,
    );
  } else {
    mount.scroller.style.removeProperty("scroll-padding-top");
  }
}

/** Find the active thread's native message scroller as BB remounts its pane. */
function useMessageScroller(threadId: string | null): Mount | null {
  const [mount, setMount] = useState<Mount | null>(null);

  useEffect(() => {
    if (!threadId) {
      setMount(null);
      return;
    }

    let current: Mount | null = null;
    const attach = () => {
      // The composer's banners (the recap card, question cards) scroll their
      // own text with the same class; they are never the message scroller.
      const scrollers = [
        ...document.querySelectorAll<HTMLElement>(SCROLLER),
      ].filter((element) => !element.closest(COMPOSER));
      // Until the SDK exposes a pane-scoped mount point, avoid placing this
      // focused-thread heading in an ambiguous multi-pane layout.
      if (scrollers.length !== 1) {
        detach(current);
        current = null;
        setMount(null);
        return;
      }
      const scroller = scrollers[0]!;
      const column = messageColumn(scroller);
      if (!column) return;
      if (current?.column === column && current.root.parentElement === column) {
        return;
      }
      const wasAtBottom =
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 24;
      const oldScrollTop = scroller.scrollTop;
      detach(current);
      setMount(null);
      const root = document.createElement("div");
      root.dataset.workstreamsStickyGoal = "";
      const columnStyle = getComputedStyle(column);
      const baseFontSize = Number.parseFloat(columnStyle.fontSize) || 14;
      // The root cancels the column's top padding so it sits exactly at the
      // scroller's top edge, and takes no height of its own: the heading is
      // drawn over the timeline from a fixed reserved gap, so collapsing and
      // expanding never reflow the messages (which would shift scroll
      // position mid-animation).
      const columnPadTop = Number.parseFloat(columnStyle.paddingTop) || 0;
      const initialHeight = headingHeight(baseFontSize, true, 1);
      root.style.marginTop = `${-columnPadTop}px`;
      root.style.marginBottom = `${initialHeight}px`;
      const overlay = document.createElement("div");
      overlay.dataset.workstreamsGoalOverlay = "";
      // Inside the sliding surface rather than the body, so the heading moves
      // with the pane. BB translates that surface to open the mobile sidebar
      // and right panel, frame by frame while a swipe is in progress, with no
      // resize or scroll event a fixed layer could follow.
      (scroller.closest<HTMLElement>(INSET) ?? document.body).append(overlay);
      const previousScrollPaddingTop =
        scroller.style.getPropertyValue("scroll-padding-top");
      const previousScrollPaddingPriority =
        scroller.style.getPropertyPriority("scroll-padding-top");
      column.prepend(root);
      const added = initialHeight - columnPadTop;
      if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
      else scroller.scrollTop = oldScrollTop + added;
      current = {
        scroller,
        column,
        baseFontSize,
        root,
        overlay,
        threadId,
        previousScrollPaddingTop,
        previousScrollPaddingPriority,
      };
      scroller.style.scrollPaddingTop = `${initialHeight}px`;
      setMount(current);
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      detach(current);
      current = null;
      setMount(null);
    };
  }, [threadId]);

  return mount;
}

// The heading leaves once, rather than tracking the scroll position. It
// collapses after scrolling this far from the newest message and returns only
// when back within the lower threshold, so hovering near the boundary cannot
// make it flicker.
const COLLAPSE_ENTER_PX = 240;
const COLLAPSE_EXIT_PX = 120;

function useScrollState(scroller: HTMLElement | null): {
  collapsed: boolean;
  // BB's own overflow fades appear only once content has scrolled out of view,
  // so the fade beneath the heading is on exactly when the timeline is
  // detached from its top.
  fade: boolean;
} {
  const [state, setState] = useState({ collapsed: false, fade: false });
  useEffect(() => {
    // A new scroller (another thread) starts expanded until it is measured.
    setState({ collapsed: false, fade: false });
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const range = scroller.scrollHeight - scroller.clientHeight;
        const fromBottom = Math.max(0, range - scroller.scrollTop);
        const fade = scroller.scrollTop > 1;
        setState((prev) => {
          const collapsed = prev.collapsed
            ? fromBottom > COLLAPSE_EXIT_PX
            : fromBottom > COLLAPSE_ENTER_PX;
          return prev.collapsed === collapsed && prev.fade === fade
            ? prev
            : { collapsed, fade };
        });
      });
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [scroller]);
  return state;
}

/**
 * Where the heading text sits in each of its two places, in px from the
 * overlay's origin.
 */
type Placement = {
  /** In the timeline, at the scroller's top edge. */
  pane: { x: number; y: number; width: number };
  /** The timeline is phone-width: the title may wrap and the bar is cramped. */
  narrow: boolean;
  /** The timeline is too short to spare room for the expanded heading. */
  short: boolean;
  /** In the title bar, after the thread title; null when there is no room. */
  bar: { x: number; centerY: number; width: number } | null;
};

function measurePlacement(mount: Mount, base: number): Placement {
  // Everything is relative to the overlay's own origin. The overlay sits in
  // the same sliding surface as the pane, so these coordinates do not change
  // while the surface moves.
  const origin = mount.overlay.getBoundingClientRect();
  const scrollerRect = mount.scroller.getBoundingClientRect();
  const columnRect = mount.column.getBoundingClientRect();
  // Line the heading up with the message text. BB insets that text from the
  // column by a width that varies with the viewport, so read it from a rendered
  // prose message (they alone carry the inset); fall back to the desktop inset.
  let textLeft = columnRect.left + 32;
  let textRight = columnRect.right - 32;
  for (const message of mount.scroller.querySelectorAll<HTMLElement>(
    "[data-message-column]",
  )) {
    const rect = message.getBoundingClientRect();
    const style = getComputedStyle(message);
    const padLeft = Number.parseFloat(style.paddingLeft) || 0;
    const padRight = Number.parseFloat(style.paddingRight) || 0;
    if (rect.width > 0 && padLeft > 0) {
      textLeft = rect.left + padLeft;
      textRight = rect.right - padRight;
      break;
    }
  }
  const pane = {
    x: textLeft - origin.left,
    y: scrollerRect.top + base * PAD_TOP - origin.top,
    width: Math.max(0, textRight - textLeft),
  };

  // The title bar is the header above the thread window in the same pane. Its
  // title cluster is on the left and its actions are the next sibling of the
  // flexible region that holds the cluster.
  let bar: Placement["bar"] = null;
  const header = mount.scroller
    .closest("[data-split-pane-id]")
    ?.querySelector<HTMLElement>(":scope > header");
  const title = header?.querySelector<HTMLElement>(".bb-thread-title");
  if (header && title) {
    let cluster: HTMLElement = title;
    while (
      cluster.parentElement &&
      !cluster.parentElement.classList.contains("flex-1")
    ) {
      cluster = cluster.parentElement;
    }
    const actions = cluster.parentElement?.nextElementSibling;
    if (actions && cluster.parentElement) {
      const headerRect = header.getBoundingClientRect();
      const x = cluster.getBoundingClientRect().right + TITLE_BAR_GAP;
      const width = actions.getBoundingClientRect().left - TITLE_BAR_GAP - x;
      if (width >= MIN_TITLE_BAR_WIDTH) {
        bar = {
          x: x - origin.left,
          centerY: (headerRect.top + headerRect.bottom) / 2 - origin.top,
          width,
        };
      }
    }
  }
  return {
    pane,
    bar,
    narrow: scrollerRect.width < NARROW_PX,
    short: scrollerRect.height < SHORT_PX,
  };
}

const samePlacement = (a: Placement | null, b: Placement): boolean =>
  !!a &&
  Math.abs(a.pane.x - b.pane.x) < 0.5 &&
  Math.abs(a.pane.y - b.pane.y) < 0.5 &&
  Math.abs(a.pane.width - b.pane.width) < 0.5 &&
  a.narrow === b.narrow &&
  a.short === b.short &&
  (a.bar === null) === (b.bar === null) &&
  (a.bar === null ||
    b.bar === null ||
    (Math.abs(a.bar.x - b.bar.x) < 0.5 &&
      Math.abs(a.bar.centerY - b.bar.centerY) < 0.5 &&
      Math.abs(a.bar.width - b.bar.width) < 0.5));

/** Keeps the heading's two resting places current as the layout moves. */
function usePlacement(mount: Mount | null, base: number): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null);
  useEffect(() => {
    if (!mount) {
      setPlacement(null);
      return;
    }
    let frame = 0;
    const header = mount.scroller
      .closest("[data-split-pane-id]")
      ?.querySelector<HTMLElement>(":scope > header");
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = measurePlacement(mount, base);
        setPlacement((prev) => (samePlacement(prev, next) ? prev : next));
      });
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(mount.scroller);
    resize.observe(mount.column);
    if (header) resize.observe(header);
    // The thread title's width, and the actions beside it, change as titles
    // load and plugins add or drop header actions.
    const mutations = new MutationObserver(measure);
    if (header) {
      mutations.observe(header, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [mount, base]);
  return placement;
}

// How long a newly attached thread holds still before the heading may animate.
// BB scrolls a fresh thread to its newest message and content keeps loading
// for a moment; the heading must not glide to match that, only to match the
// reader's own scrolling.
const SETTLE_MS = 500;

function useSettled(mount: Mount | null): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (!mount) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [mount]);
  return settled;
}

/**
 * Experimental in-pane prototype. A zero-height sticky anchor in the column of
 * BB's native message scroller carries the heading's plate (the plugin SDK has
 * no thread-content heading slot); the text is drawn in a fixed layer above the
 * app so that, once the timeline scrolls, it can glide up over the title bar.
 */
export function StickyGoalHeader(): React.ReactElement | null {
  const { threadId } = useBbContext();
  const context = useGoalContext(threadId);
  const mount = useMessageScroller(threadId);
  const { collapsed: scrolledAway, fade } = useScrollState(
    mount?.scroller ?? null,
  );
  const settled = useSettled(mount);
  const base = mount?.baseFontSize ?? 14;
  const placement = usePlacement(mount, base);
  // Until settled the heading stays expanded in place, unless the timeline is
  // too short for it.
  const collapsed = (settled && scrolledAway) || (placement?.short ?? false);

  const hasEyebrow = !!context?.workstream;
  const phone = useMediaQuery(PHONE_QUERY);
  const eyebrow = hasEyebrow ? eyebrowMetrics(base, phone) : null;
  // On a phone the title may take two lines; it is measured, once placed.
  const measureRef = useRef<HTMLHeadingElement>(null);
  const [wrappedLines, setWrappedLines] = useState(1);
  const title = context?.title;
  const paneWidth = placement?.pane.width ?? 0;
  const narrow = placement?.narrow ?? false;
  useLayoutEffect(() => {
    const probe = measureRef.current;
    if (!narrow || !probe) {
      setWrappedLines(1);
      return;
    }
    const line = base * TITLE_SIZE * TITLE_LINE;
    setWrappedLines(
      Math.min(2, Math.max(1, Math.round(probe.scrollHeight / line))),
    );
  }, [narrow, title, paneWidth, base, hasEyebrow]);
  const titleLines = narrow ? wrappedLines : 1;
  const height = headingHeight(base, hasEyebrow, titleLines);
  // Collapsed, the heading goes to the title bar when it has room there, and
  // otherwise stays pinned at the top of the timeline in its compact form.
  const pinned = collapsed && !!placement && placement.bar === null;
  const platePinnedHeight = pinnedHeight(base, eyebrow);
  const fadeAnchor = pinned ? platePinnedHeight : height;
  useLayoutEffect(() => {
    if (!mount) return;
    mount.root.className = settled
      ? "ws-sticky-goal-root ws-sticky-goal-root--animated"
      : "ws-sticky-goal-root";
    mount.root.dataset.collapsed = String(collapsed);
    // Two feathered fades, each in place and each fading on its own: one
    // hangs below the expanded plate, the other sits under the title bar once
    // the heading has left. Neither moves with the heading.
    mount.root.style.setProperty("--ws-plate-height", `${fadeAnchor}px`);
    mount.root.style.setProperty(
      "--ws-fade-below-plate",
      fade && (!collapsed || pinned) ? "1" : "0",
    );
    mount.root.style.setProperty(
      "--ws-fade-below-bar",
      fade && collapsed && !pinned ? "1" : "0",
    );
    // The reserved gap follows the heading height, which changes only when the
    // thread gains or loses a workstream line.
    mount.root.style.marginBottom = `${height}px`;
    mount.scroller.style.scrollPaddingTop = pinned
      ? `${platePinnedHeight}px`
      : collapsed
        ? "0px"
        : `${height}px`;
    return () => {
      mount.root.className = "";
      mount.root.style.removeProperty("--ws-plate-height");
      mount.root.style.removeProperty("--ws-fade-below-plate");
      mount.root.style.removeProperty("--ws-fade-below-bar");
      delete mount.root.dataset.collapsed;
    };
  }, [
    mount,
    collapsed,
    pinned,
    fade,
    height,
    fadeAnchor,
    platePinnedHeight,
    settled,
  ]);

  // The heading replaces BB's own thread title in the title bar, but only
  // while it is actually drawn, so the title never shows twice.
  const showing = !!(mount && context && placement);
  useLayoutEffect(() => {
    if (!mount || !showing) return;
    const header = mount.scroller
      .closest("[data-split-pane-id]")
      ?.querySelector<HTMLElement>(":scope > header");
    header?.setAttribute("data-ws-hide-title", "");
    return () => header?.removeAttribute("data-ws-hide-title");
  }, [mount, showing]);

  useLayoutEffect(() => {
    if (!mount) return;
    mount.overlay.className = settled
      ? "ws-goal-overlay ws-goal-overlay--animated"
      : "ws-goal-overlay";
    return () => {
      mount.overlay.className = "";
    };
  }, [mount, settled]);

  if (!mount || !context || !placement) return null;

  const inBar = collapsed && placement.bar !== null;
  // Both collapsed homes set the text in the same compact form.
  const compact = inBar || pinned;
  const titleScale = (base * TITLE_BAR_TITLE_SIZE) / (base * TITLE_SIZE);
  const eyebrowBlock = eyebrow ? eyebrow.expandedBlock : 0;
  const barEyebrowBlock = eyebrow ? eyebrow.compactBlock : 0;
  const barBlock = compactBlock(base, eyebrow);
  const paneTop = placement.pane.y - base * PAD_TOP;
  const spot =
    inBar && placement.bar
      ? {
          x: placement.bar.x,
          y: placement.bar.centerY - barBlock / 2,
          width: placement.bar.width,
        }
      : pinned
        ? {
            x: placement.pane.x,
            y: paneTop + base * PINNED_PAD,
            width: placement.pane.width,
          }
        : placement.pane;
  const titleOffset = compact ? barEyebrowBlock : eyebrowBlock;
  const titleWidth = compact ? spot.width / titleScale : spot.width;
  const wraps = narrow && !compact && titleLines > 1;
  const titleBlock = base * TITLE_SIZE * TITLE_LINE * titleLines;

  // Only transforms and opacity move: the plate stays at the top of the
  // scroller and fades, while the text glides to the title bar.
  const text = (
    <div
      className="ws-goal-overlay__group"
      style={{
        transform: `translate(${spot.x}px, ${spot.y}px)`,
        width: spot.width,
        opacity: collapsed && !compact ? 0 : 1,
      }}
    >
      {context.workstream && eyebrow && (
        <div
          className="ws-sticky-goal__workstream"
          style={
            {
              fontSize: eyebrow.size,
              maxWidth: compact ? spot.width / eyebrow.compactScale : undefined,
              transform: `scale(${compact ? eyebrow.compactScale : 1})`,
              "--ws-hue": context.workstream.hue,
            } as React.CSSProperties
          }
        >
          <WorkstreamIcon className="size-4 text-current" />
          <span>{context.workstream.name}</span>
        </div>
      )}
      <h2
        className="ws-sticky-goal__title"
        style={{
          fontSize: base * TITLE_SIZE,
          width: titleWidth,
          transform: `translateY(${titleOffset}px) scale(${compact ? titleScale : 1})`,
          ...(wraps
            ? {
                display: "-webkit-box",
                whiteSpace: "normal",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: 2,
              }
            : null),
        }}
      >
        {context.title}
      </h2>
      {/* Measures how many lines the title needs at the timeline's width. */}
      {narrow && (
        <h2
          ref={measureRef}
          aria-hidden
          className="ws-sticky-goal__title ws-sticky-goal__probe"
          style={{ fontSize: base * TITLE_SIZE, width: placement.pane.width }}
        >
          {context.title}
        </h2>
      )}
      {context.subtask && (
        <div
          className="ws-sticky-goal__subtitle"
          style={{
            fontSize: base * SUBTITLE_SIZE,
            transform: `translateY(${eyebrowBlock + titleBlock}px)`,
            opacity: collapsed ? 0 : 1,
          }}
        >
          {context.subtask}
        </div>
      )}
    </div>
  );

  return (
    <>
      {createPortal(
        <div
          className="ws-sticky-goal"
          style={{ height, opacity: inBar ? 0 : 1 }}
        >
          <div
            className="ws-sticky-goal__plate"
            style={{
              transform: `translateY(${pinned ? platePinnedHeight - height : 0}px)`,
            }}
          />
        </div>,
        mount.root,
      )}
      {createPortal(text, mount.overlay)}
    </>
  );
}
