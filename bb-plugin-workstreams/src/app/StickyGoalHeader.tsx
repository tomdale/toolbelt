import {
  useBbContext,
  experimental_useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useSharedServerState } from "./serverState.ts";

const SCROLLER = "[data-thread-window] .thread-scrollbar";

// The heading is laid out in the same column as the messages so it shares
// their left edge and type. BB's scroller wraps that column in one extra div.
function messageColumn(scroller: HTMLElement): HTMLElement | null {
  const column = scroller.firstElementChild?.firstElementChild;
  return column instanceof HTMLElement ? column : null;
}

// Type sizes as multiples of the timeline's body font size. Expanded, the
// heading is the most prominent text on the page: an eyebrow naming the
// broader effort, a large title, and the current subtask. Compacted, it drops
// to a title and one muted line so it stays out of the way while reading.
const EXPANDED = { eyebrow: 0.78, title: 1.5, subtitle: 0.92 } as const;
const COMPACT = { title: 0.9, subtitle: 0.72 } as const;

/**
 * Heading height in px for a body font size. Both states always budget for
 * every line so each height is constant, whatever the thread has to show.
 */
function headingHeight(base: number, compact: boolean): number {
  return Math.round(
    base *
      (compact
        ? COMPACT.title * 1.3 + COMPACT.subtitle * 1.4 + 0.5
        : EXPANDED.title * 1.25 +
          EXPANDED.eyebrow * 1.5 +
          EXPANDED.subtitle * 1.4 +
          1),
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
      const initialHeight = headingHeight(baseFontSize, false);
      // The root takes no height of its own: the heading is drawn over the
      // timeline from a fixed reserved gap, so expanding and compacting never
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

// The heading collapses once, rather than tracking the scroll position. It
// compacts after scrolling this far from the newest message and expands again
// only when back within the lower threshold, so hovering near the boundary
// cannot make it flicker.
const COMPACT_ENTER_PX = 240;
const COMPACT_EXIT_PX = 120;

function useScrollState(scroller: HTMLElement | null): {
  compact: boolean;
  // BB's own overflow fades appear only once content has scrolled out of view,
  // so the fade beneath the heading is on exactly when the timeline is
  // detached from its top.
  fade: boolean;
} {
  const [state, setState] = useState({ compact: false, fade: false });
  useEffect(() => {
    if (!scroller) {
      setState({ compact: false, fade: false });
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
          const compact = prev.compact
            ? fromBottom > COMPACT_EXIT_PX
            : fromBottom > COMPACT_ENTER_PX;
          return prev.compact === compact && prev.fade === fade
            ? prev
            : { compact, fade };
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
  const { threads, projects, sections } = experimental_useSidebarThreads();
  const { server } = useSharedServerState();
  const mount = useMessageScroller(threadId);
  const { compact, fade } = useScrollState(mount?.scroller ?? null);

  const context = useMemo(() => {
    if (!threadId) return null;
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return null;
    const analysis = server.analysis[threadId];
    const recap = server.recaps[threadId];
    const goal =
      analysis?.goal ??
      (thread.title ? thread.displayTitle : "Building a clear thread goal");
    const project = projects.find((item) => item.id === thread.projectId)?.name;
    const subtask = recap?.goal && recap.goal !== goal ? recap.goal : null;
    const workstream = thread.sectionId
      ? sections.find((item) => item.id === thread.sectionId)?.name
      : null;
    // A workstream/project identifies the broader effort; the current recap
    // supplies the active subtask when it adds information.
    return { goal, eyebrow: workstream ?? project ?? null, subtask };
  }, [threadId, threads, projects, sections, server.analysis, server.recaps]);

  const base = mount?.baseFontSize ?? 14;
  const expandedHeight = headingHeight(base, false);
  const compactHeight = headingHeight(base, true);
  // Compacted, the eyebrow folds into the subtitle line.
  const compactSubtitle = [context?.eyebrow, context?.subtask]
    .filter(Boolean)
    .join(" · ");
  const height = compact ? compactHeight : expandedHeight;
  useLayoutEffect(() => {
    if (!mount) return;
    mount.root.className = "ws-sticky-goal-root";
    mount.root.dataset.compact = String(compact);
    mount.root.style.setProperty("--ws-sticky-fade", fade ? "1" : "0");
    mount.scroller.style.scrollPaddingTop = `${height}px`;
    return () => {
      mount.root.className = "";
      mount.root.style.removeProperty("--ws-sticky-fade");
      delete mount.root.dataset.compact;
    };
  }, [mount, compact, fade, height]);

  if (!mount || !context) return null;
  // Expanded and compact are separate layers that crossfade. Nothing resizes
  // or reflows during the transition: the plate slides (transform) and the
  // layers fade (opacity), both composited off the main thread.
  return createPortal(
    <div className="ws-sticky-goal" style={{ height: expandedHeight }}>
      <div
        className="ws-sticky-goal__plate"
        style={{
          transform: `translateY(${compact ? compactHeight - expandedHeight : 0}px)`,
        }}
      />
      <div
        className="ws-sticky-goal__layer"
        aria-hidden={compact}
        style={{
          height: expandedHeight,
          paddingBottom: base * 0.65,
          opacity: compact ? 0 : 1,
        }}
      >
        {context.eyebrow && (
          <div
            className="ws-sticky-goal__eyebrow"
            style={{ fontSize: base * EXPANDED.eyebrow }}
          >
            {context.eyebrow}
          </div>
        )}
        <h2
          className="ws-sticky-goal__title"
          style={{ fontSize: base * EXPANDED.title }}
        >
          {context.goal}
        </h2>
        {context.subtask && (
          <div
            className="ws-sticky-goal__subtitle"
            style={{ fontSize: base * EXPANDED.subtitle }}
          >
            {context.subtask}
          </div>
        )}
      </div>
      <div
        className="ws-sticky-goal__layer"
        aria-hidden={!compact}
        style={{
          height: compactHeight,
          paddingBottom: base * 0.3,
          opacity: compact ? 1 : 0,
        }}
      >
        <h2
          className="ws-sticky-goal__title"
          style={{ fontSize: base * COMPACT.title, opacity: 0.88 }}
        >
          {context.goal}
        </h2>
        {compactSubtitle && (
          <div
            className="ws-sticky-goal__subtitle"
            style={{ fontSize: base * COMPACT.subtitle }}
          >
            {compactSubtitle}
          </div>
        )}
      </div>
    </div>,
    mount.root,
  );
}
