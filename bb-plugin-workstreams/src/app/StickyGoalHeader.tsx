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

const TITLE_SCALE = [1.14, 0.9] as const;
const SUBTITLE_SCALE = [0.88, 0.72] as const;
const lerp = (range: readonly [number, number], t: number) =>
  range[0] + (range[1] - range[0]) * t;

/** Heading height in px for a body font size at a given scroll progress. */
function headingHeight(base: number, t: number): number {
  return Math.round(
    base * (lerp(TITLE_SCALE, t) * 1.3 + lerp(SUBTITLE_SCALE, t) * 1.4) +
      base * 0.5,
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
      const initialHeight = headingHeight(baseFontSize, 0);
      root.style.height = `${initialHeight}px`;
      const previousScrollPaddingTop =
        scroller.style.getPropertyValue("scroll-padding-top");
      const previousScrollPaddingPriority =
        scroller.style.getPropertyPriority("scroll-padding-top");
      column.prepend(root);
      if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
      else scroller.scrollTop = oldScrollTop + root.offsetHeight;
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

// BB's own overflow fades appear only once content has scrolled out of view,
// so the fade beneath the heading is on exactly when the timeline is detached
// from its top.
function useScrollProgress(scroller: HTMLElement | null): {
  progress: number;
  fade: number;
} {
  const [state, setState] = useState({ progress: 0, fade: 0 });
  useEffect(() => {
    if (!scroller) {
      setState({ progress: 0, fade: 0 });
      return;
    }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const range = scroller.scrollHeight - scroller.clientHeight;
        const fromBottom = Math.max(0, range - scroller.scrollTop);
        // Stay fully expanded near the newest message, then recede over 420px of history.
        const progress = Math.max(0, Math.min(1, (fromBottom - 16) / 420));
        const fade = scroller.scrollTop > 1 ? 1 : 0;
        setState((prev) =>
          prev.progress === progress && prev.fade === fade
            ? prev
            : { progress, fade },
        );
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
  const { progress, fade } = useScrollProgress(mount?.scroller ?? null);

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
    return {
      goal,
      // A workstream/project identifies the broader effort; the current recap
      // supplies the active subtask when it adds information.
      subtitle: [workstream ?? project, subtask]
        .filter(
          (value, index, values) => value && values.indexOf(value) === index,
        )
        .join(" · "),
    };
  }, [threadId, threads, projects, sections, server.analysis, server.recaps]);

  const eased = progress * progress * (3 - 2 * progress);
  const base = mount?.baseFontSize ?? 14;
  const height = headingHeight(base, eased);
  const titleSize = base * lerp(TITLE_SCALE, eased);
  const subtitleSize = base * lerp(SUBTITLE_SCALE, eased);
  useLayoutEffect(() => {
    if (!mount) return;
    mount.root.className = "ws-sticky-goal-root";
    mount.root.dataset.scrollProgress = progress.toFixed(3);
    mount.root.style.setProperty("--ws-sticky-fade", String(fade));
    mount.root.style.height = `${height}px`;
    mount.scroller.style.scrollPaddingTop = `${height}px`;
    return () => {
      mount.root.className = "";
      mount.root.style.removeProperty("height");
      mount.root.style.removeProperty("--ws-sticky-fade");
      delete mount.root.dataset.scrollProgress;
    };
  }, [mount, progress, fade, height]);

  if (!mount || !context) return null;
  return createPortal(
    <div className="ws-sticky-goal">
      <h2
        className="ws-sticky-goal__title"
        style={{ fontSize: titleSize, opacity: 1 - 0.12 * eased }}
      >
        {context.goal}
      </h2>
      {context.subtitle && (
        <div
          className="ws-sticky-goal__subtitle"
          style={{ fontSize: subtitleSize }}
        >
          {context.subtitle}
        </div>
      )}
    </div>,
    mount.root,
  );
}
