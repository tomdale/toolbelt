import { useBbContext } from "@get-bb/plugin-sdk/app";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useState } from "react";
import { useGoalContext } from "./goalContext.ts";
import { setGoalHeadingCollapsed } from "./stickyGoalState.ts";
import { WorkstreamIcon } from "./WorkstreamIcon.tsx";

const SCROLLER = "[data-thread-window] .thread-scrollbar";

// The heading is laid out in the same column as the messages so it shares
// their left edge and type. BB's scroller wraps that column in one extra div.
function messageColumn(scroller: HTMLElement): HTMLElement | null {
  const column = scroller.firstElementChild?.firstElementChild;
  return column instanceof HTMLElement ? column : null;
}

// Type sizes as multiples of the timeline's body font size. The expanded
// heading is the most prominent text on the page: the workstream, a large
// title, and the current subtask. Scrolled away from the newest message it
// leaves the page entirely and the title bar carries the workstream and goal
// (see GoalTitleChip).
const TITLE_SIZE = 1.5;
const SUBTITLE_SIZE = 0.92;
const TITLE_LINE = 4 / 3;
const SUBTITLE_LINE = 1.4;
const PAD_TOP = 0.85;
const PAD_BOTTOM = 0.65;
const EYEBROW_SIZE = 0.8;
/** Workstream line plus the gap before the title, when there is a workstream. */
const EYEBROW_BLOCK = 1.25;

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
  root: HTMLElement;
  threadId: string;
  previousScrollPaddingTop: string;
  previousScrollPaddingPriority: string;
};

function detach(mount: Mount | null): void {
  if (!mount) return;
  mount.root.remove();
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
      const baseFontSize =
        Number.parseFloat(getComputedStyle(column).fontSize) || 14;
      const initialHeight = headingHeight(baseFontSize, true);
      // The root takes no height of its own: the heading is drawn over the
      // timeline from a fixed reserved gap, so collapsing and expanding never
      // reflow the messages (which would shift scroll position mid-animation).
      root.style.marginBottom = `${initialHeight}px`;
      const previousScrollPaddingTop =
        scroller.style.getPropertyValue("scroll-padding-top");
      const previousScrollPaddingPriority =
        scroller.style.getPropertyPriority("scroll-padding-top");
      column.prepend(root);
      if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
      else scroller.scrollTop = oldScrollTop + initialHeight;
      current = {
        scroller,
        column,
        baseFontSize,
        root,
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
    if (!scroller) {
      setState({ collapsed: false, fade: false });
      return;
    }
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
 * Experimental in-pane prototype. The heading is portalled into the column of
 * BB's native message scroller because the plugin SDK has no thread-content heading slot.
 */
export function StickyGoalHeader(): React.ReactPortal | null {
  const { threadId } = useBbContext();
  const context = useGoalContext(threadId);
  const mount = useMessageScroller(threadId);
  const { collapsed, fade } = useScrollState(mount?.scroller ?? null);

  // Tell the title bar when to take over.
  useEffect(() => {
    if (!threadId || !mount) return;
    setGoalHeadingCollapsed(threadId, collapsed);
    return () => setGoalHeadingCollapsed(threadId, false);
  }, [threadId, mount, collapsed]);

  const base = mount?.baseFontSize ?? 14;
  const hasEyebrow = !!context?.workstream;
  const height = headingHeight(base, hasEyebrow);
  const eyebrowBlock = hasEyebrow ? base * EYEBROW_BLOCK : 0;
  useLayoutEffect(() => {
    if (!mount) return;
    mount.root.className = "ws-sticky-goal-root";
    mount.root.dataset.collapsed = String(collapsed);
    mount.root.style.setProperty("--ws-sticky-fade", fade ? "1" : "0");
    // The reserved gap follows the heading height, which changes only when the
    // thread gains or loses a workstream line.
    mount.root.style.marginBottom = `${height}px`;
    mount.scroller.style.scrollPaddingTop = collapsed ? "0px" : `${height}px`;
    return () => {
      mount.root.className = "";
      mount.root.style.removeProperty("--ws-sticky-fade");
      delete mount.root.dataset.collapsed;
    };
  }, [mount, collapsed, fade, height]);

  if (!mount || !context) return null;
  // Collapsing slides the heading up out of the scroller and fades its text
  // (transforms and opacity only), so no layout runs mid-transition and
  // messages never reflow. The plate's feathered fade rides along and ends up
  // as a soft edge under the title bar.
  return createPortal(
    <div className="ws-sticky-goal" style={{ height }}>
      <div
        className="ws-sticky-goal__body"
        style={{
          transform: `translateY(${collapsed ? -height : 0}px)`,
        }}
      >
        <div className="ws-sticky-goal__plate" />
        <div
          className="ws-sticky-goal__text"
          style={{ top: base * PAD_TOP, opacity: collapsed ? 0 : 1 }}
        >
          {context.workstream && (
            <div
              className="ws-sticky-goal__workstream"
              style={
                {
                  fontSize: base * EYEBROW_SIZE,
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
            style={{ top: eyebrowBlock, fontSize: base * TITLE_SIZE }}
          >
            {context.goal}
          </h2>
          {context.subtask && (
            <div
              className="ws-sticky-goal__subtitle"
              style={{
                fontSize: base * SUBTITLE_SIZE,
                transform: `translateY(${eyebrowBlock + base * TITLE_SIZE * TITLE_LINE}px)`,
              }}
            >
              {context.subtask}
            </div>
          )}
        </div>
      </div>
    </div>,
    mount.root,
  );
}
