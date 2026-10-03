import {
  useBbContext,
  experimental_useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { workstreamHue } from "../domain/workstreamHue.ts";
import { useSharedServerState } from "./serverState.ts";
import { WorkstreamIcon } from "./WorkstreamIcon.tsx";

const SCROLLER = "[data-thread-window] .thread-scrollbar";

// The heading is laid out in the same column as the messages so it shares
// their left edge and type. BB's scroller wraps that column in one extra div.
function messageColumn(scroller: HTMLElement): HTMLElement | null {
  const column = scroller.firstElementChild?.firstElementChild;
  return column instanceof HTMLElement ? column : null;
}

// Type sizes as multiples of the timeline's body font size. The heading is
// always laid out at its expanded size; compacting scales the title and
// subtitle down from their top-left corners, so every line keeps its place
// and only shrinks. The workstream line above them neither moves nor resizes.
const TITLE_SIZE = 1.5;
const SUBTITLE_SIZE = 0.92;
const TITLE_LINE = 4 / 3;
const SUBTITLE_LINE = 1.4;
const PAD_TOP = 0.3;
const EYEBROW_SIZE = 0.8;
/** Eyebrow line plus the gap before the title, when there is a workstream. */
const EYEBROW_BLOCK = 1.25;
const TITLE_COMPACT_SCALE = 0.6; // 0.9x body text
const SUBTITLE_COMPACT_SCALE = 0.78; // 0.72x body text

/** Heading height in px for a body font size. */
function headingHeight(
  base: number,
  compact: boolean,
  hasEyebrow: boolean,
): number {
  const title = TITLE_SIZE * TITLE_LINE * (compact ? TITLE_COMPACT_SCALE : 1);
  const subtitle =
    SUBTITLE_SIZE * SUBTITLE_LINE * (compact ? SUBTITLE_COMPACT_SCALE : 1);
  return Math.round(
    base *
      (PAD_TOP +
        (hasEyebrow ? EYEBROW_BLOCK : 0) +
        title +
        subtitle +
        (compact ? 0.3 : 0.65)),
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
      const initialHeight = headingHeight(baseFontSize, false, true);
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
  const { threads, sections } = experimental_useSidebarThreads();
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
    // The current recap supplies the active subtask when it adds information.
    const subtask = recap?.goal && recap.goal !== goal ? recap.goal : null;
    const section = thread.sectionId
      ? sections.find((item) => item.id === thread.sectionId)
      : null;
    const workstream = section
      ? { name: section.name, hue: workstreamHue(section.id) }
      : null;
    return { goal, subtask, workstream };
  }, [threadId, threads, sections, server.analysis, server.recaps]);

  const base = mount?.baseFontSize ?? 14;
  const hasEyebrow = !!context?.workstream;
  const expandedHeight = headingHeight(base, false, hasEyebrow);
  const compactHeight = headingHeight(base, true, hasEyebrow);
  const eyebrowBlock = hasEyebrow ? base * EYEBROW_BLOCK : 0;
  const subtitle = context?.subtask ?? "";
  const height = compact ? compactHeight : expandedHeight;
  const titleScale = compact ? TITLE_COMPACT_SCALE : 1;
  const subtitleScale = compact ? SUBTITLE_COMPACT_SCALE : 1;
  const titleBlock = base * TITLE_SIZE * TITLE_LINE;
  useLayoutEffect(() => {
    if (!mount) return;
    mount.root.className = "ws-sticky-goal-root";
    mount.root.dataset.compact = String(compact);
    mount.root.style.setProperty("--ws-sticky-fade", fade ? "1" : "0");
    // The reserved gap follows the expanded height, which changes only when the
    // thread gains or loses a workstream line.
    mount.root.style.marginBottom = `${expandedHeight}px`;
    mount.scroller.style.scrollPaddingTop = `${height}px`;
    return () => {
      mount.root.className = "";
      mount.root.style.removeProperty("--ws-sticky-fade");
      delete mount.root.dataset.compact;
    };
  }, [mount, compact, fade, height, expandedHeight]);

  if (!mount || !context) return null;
  // The plate slides and the text scales (transforms only), so no layout runs
  // mid-transition and messages never reflow. Text is anchored at its top-left
  // and shrinks in place; only the subtitle rises, as the title above it gets
  // shorter. Widths are widened by the inverse scale so ellipsis points match
  // the visible size.
  return createPortal(
    <div className="ws-sticky-goal" style={{ height: expandedHeight }}>
      <div
        className="ws-sticky-goal__plate"
        style={{
          transform: `translateY(${compact ? compactHeight - expandedHeight : 0}px)`,
        }}
      />
      <div className="ws-sticky-goal__text" style={{ top: base * PAD_TOP }}>
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
          style={{
            top: eyebrowBlock,
            fontSize: base * TITLE_SIZE,
            width: `${100 / titleScale}%`,
            transform: `scale(${titleScale})`,
            opacity: compact ? 0.88 : 1,
          }}
        >
          {context.goal}
        </h2>
        {subtitle && (
          <div
            className="ws-sticky-goal__subtitle"
            style={{
              fontSize: base * SUBTITLE_SIZE,
              width: `${100 / subtitleScale}%`,
              transform: `translateY(${eyebrowBlock + titleBlock * titleScale}px) scale(${subtitleScale})`,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
    </div>,
    mount.root,
  );
}
