import { useBbContext } from "@get-bb/plugin-sdk/app";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useState } from "react";
import { useGoalContext } from "./goalContext.ts";
import { WorkstreamIcon } from "./WorkstreamIcon.tsx";

const SCROLLER = "[data-thread-window] .thread-scrollbar";

// The heading is laid out in the same column as the messages so it shares
// their left edge and type. BB's scroller wraps that column in one extra div.
function messageColumn(scroller: HTMLElement): HTMLElement | null {
  const column = scroller.firstElementChild?.firstElementChild;
  return column instanceof HTMLElement ? column : null;
}

// Type sizes as multiples of the timeline's body font size. Expanded, the
// heading is the most prominent text on the page: the workstream, a large
// title, and the current subtask. Scrolled away from the newest message it
// scoots up over the title bar as a two-line workstream and goal.
const TITLE_SIZE = 1.5;
const SUBTITLE_SIZE = 0.92;
const TITLE_LINE = 4 / 3;
const SUBTITLE_LINE = 1.4;
const PAD_TOP = 0.85;
const PAD_BOTTOM = 0.65;
const EYEBROW_SIZE = 0.8;
/** Workstream line plus the gap before the title, when there is a workstream. */
const EYEBROW_BLOCK = 1.25;
/** In the title bar the title is set at this multiple of body size. */
const TITLE_BAR_TITLE_SIZE = 0.95;
/** The workstream line is scaled down in the title bar. */
const TITLE_BAR_EYEBROW_SCALE = 0.82;
/** Its height there, in px, including the small gap before the title. */
const TITLE_BAR_EYEBROW_BLOCK = 10;
/** Smallest title-bar gap worth drawing the heading into. */
const MIN_TITLE_BAR_WIDTH = 140;
const TITLE_BAR_GAP = 16;

/** Heading height in px for a body font size. */
function headingHeight(base: number, hasEyebrow: boolean): number {
  return Math.round(
    base *
      (PAD_TOP +
        (hasEyebrow ? EYEBROW_BLOCK : 0) +
        TITLE_SIZE * TITLE_LINE +
        SUBTITLE_SIZE * SUBTITLE_LINE +
        PAD_BOTTOM),
  );
}

type Mount = {
  scroller: HTMLElement;
  /** Parent of the heading: the column that holds the timeline messages. */
  column: HTMLElement;
  /** Body font size of the timeline, so the heading scales with the text. */
  baseFontSize: number;
  /** Zero-height sticky anchor at the top of the column. */
  root: HTMLElement;
  /** Fixed layer over the whole app that draws the heading text. */
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
      const scrollers = document.querySelectorAll<HTMLElement>(SCROLLER);
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
      const initialHeight = headingHeight(baseFontSize, true);
      root.style.marginTop = `${-columnPadTop}px`;
      root.style.marginBottom = `${initialHeight}px`;
      const overlay = document.createElement("div");
      overlay.dataset.workstreamsGoalOverlay = "";
      document.body.append(overlay);
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

/** Where the heading text sits in each of its two places, in viewport px. */
type Placement = {
  /** In the timeline, at the scroller's top edge. */
  pane: { x: number; y: number; width: number };
  /** In the title bar, after the thread title; null when there is no room. */
  bar: { x: number; centerY: number; width: number } | null;
};

function measurePlacement(mount: Mount, base: number): Placement {
  const scrollerRect = mount.scroller.getBoundingClientRect();
  const columnRect = mount.column.getBoundingClientRect();
  // Message text sits a further 1rem inside the column's padding.
  const pane = {
    x: columnRect.left + 32,
    y: scrollerRect.top + base * PAD_TOP,
    width: Math.max(0, columnRect.width - 64),
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
          x,
          centerY: (headerRect.top + headerRect.bottom) / 2,
          width,
        };
      }
    }
  }
  return { pane, bar };
}

const samePlacement = (a: Placement | null, b: Placement): boolean =>
  !!a &&
  Math.abs(a.pane.x - b.pane.x) < 0.5 &&
  Math.abs(a.pane.y - b.pane.y) < 0.5 &&
  Math.abs(a.pane.width - b.pane.width) < 0.5 &&
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
  // Until settled the heading stays expanded in place.
  const collapsed = settled && scrolledAway;
  const base = mount?.baseFontSize ?? 14;
  const placement = usePlacement(mount, base);

  const hasEyebrow = !!context?.workstream;
  const height = headingHeight(base, hasEyebrow);
  useLayoutEffect(() => {
    if (!mount) return;
    mount.root.className = settled
      ? "ws-sticky-goal-root ws-sticky-goal-root--animated"
      : "ws-sticky-goal-root";
    mount.root.dataset.collapsed = String(collapsed);
    // Two feathered fades, each in place and each fading on its own: one
    // hangs below the expanded plate, the other sits under the title bar once
    // the heading has left. Neither moves with the heading.
    mount.root.style.setProperty("--ws-plate-height", `${height}px`);
    mount.root.style.setProperty(
      "--ws-fade-below-plate",
      fade && !collapsed ? "1" : "0",
    );
    mount.root.style.setProperty(
      "--ws-fade-below-bar",
      fade && collapsed ? "1" : "0",
    );
    // The reserved gap follows the heading height, which changes only when the
    // thread gains or loses a workstream line.
    mount.root.style.marginBottom = `${height}px`;
    mount.scroller.style.scrollPaddingTop = collapsed ? "0px" : `${height}px`;
    return () => {
      mount.root.className = "";
      mount.root.style.removeProperty("--ws-plate-height");
      mount.root.style.removeProperty("--ws-fade-below-plate");
      mount.root.style.removeProperty("--ws-fade-below-bar");
      delete mount.root.dataset.collapsed;
    };
  }, [mount, collapsed, fade, height, settled]);

  // The heading replaces BB's own thread title in the title bar, but only
  // while it is actually drawn: a thread without a goal keeps its title.
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

  // With no room in the title bar the text simply fades where it is.
  const inBar = collapsed && placement.bar !== null;
  const titleScale = (base * TITLE_BAR_TITLE_SIZE) / (base * TITLE_SIZE);
  const eyebrowBlock = hasEyebrow ? base * EYEBROW_BLOCK : 0;
  const barEyebrowBlock = hasEyebrow ? TITLE_BAR_EYEBROW_BLOCK : 0;
  const barTitleHeight = base * TITLE_BAR_TITLE_SIZE * TITLE_LINE;
  const barBlock = barEyebrowBlock + barTitleHeight;
  const spot =
    inBar && placement.bar
      ? {
          x: placement.bar.x,
          y: placement.bar.centerY - barBlock / 2,
          width: placement.bar.width,
        }
      : placement.pane;
  const titleOffset = inBar ? barEyebrowBlock : eyebrowBlock;
  const titleWidth = inBar ? spot.width / titleScale : spot.width;

  // Only transforms and opacity move: the plate stays at the top of the
  // scroller and fades, while the text glides to the title bar.
  const text = (
    <div
      className="ws-goal-overlay__group"
      style={{
        transform: `translate(${spot.x}px, ${spot.y}px)`,
        width: spot.width,
        opacity: collapsed && !inBar ? 0 : 1,
      }}
    >
      {context.workstream && (
        <div
          className="ws-sticky-goal__workstream"
          style={
            {
              fontSize: base * EYEBROW_SIZE,
              maxWidth: inBar
                ? spot.width / TITLE_BAR_EYEBROW_SCALE
                : undefined,
              transform: `scale(${inBar ? TITLE_BAR_EYEBROW_SCALE : 1})`,
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
          transform: `translateY(${titleOffset}px) scale(${inBar ? titleScale : 1})`,
        }}
      >
        {context.goal}
      </h2>
      {context.subtask && (
        <div
          className="ws-sticky-goal__subtitle"
          style={{
            fontSize: base * SUBTITLE_SIZE,
            transform: `translateY(${eyebrowBlock + base * TITLE_SIZE * TITLE_LINE}px)`,
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
          style={{ height, opacity: collapsed ? 0 : 1 }}
        >
          <div className="ws-sticky-goal__plate" />
        </div>,
        mount.root,
      )}
      {createPortal(text, mount.overlay)}
    </>
  );
}
