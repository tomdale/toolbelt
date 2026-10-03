import {
  useBbContext,
  experimental_useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useSharedServerState } from "./serverState.ts";

const SCROLLER = "[data-thread-window] .thread-scrollbar";

type Mount = {
  scroller: HTMLElement;
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
      if (current?.scroller === scroller) return;
      const wasAtBottom =
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 24;
      const oldScrollTop = scroller.scrollTop;
      detach(current);
      setMount(null);
      const root = document.createElement("div");
      root.dataset.workstreamsStickyGoal = "";
      root.style.height = "64px";
      const previousScrollPaddingTop =
        scroller.style.getPropertyValue("scroll-padding-top");
      const previousScrollPaddingPriority =
        scroller.style.getPropertyPriority("scroll-padding-top");
      scroller.prepend(root);
      if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
      else scroller.scrollTop = oldScrollTop + root.offsetHeight;
      current = {
        scroller,
        root,
        threadId,
        previousScrollPaddingTop,
        previousScrollPaddingPriority,
      };
      scroller.style.scrollPaddingTop = "64px";
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

function useScrollProgress(scroller: HTMLElement | null): number {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!scroller) {
      setProgress(0);
      return;
    }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const range = scroller.scrollHeight - scroller.clientHeight;
        const fromBottom = Math.max(0, range - scroller.scrollTop);
        // Stay fully expanded near the newest message, then recede over 420px of history.
        setProgress(Math.max(0, Math.min(1, (fromBottom - 16) / 420)));
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
  return progress;
}

/**
 * Experimental in-pane prototype. The heading is portalled into BB's native
 * message scroller because the plugin SDK has no thread-content heading slot.
 */
export function StickyGoalHeader(): React.ReactPortal | null {
  const { threadId } = useBbContext();
  const { threads, projects, sections } = experimental_useSidebarThreads();
  const { server } = useSharedServerState();
  const mount = useMessageScroller(threadId);
  const progress = useScrollProgress(mount?.scroller ?? null);

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
  const expanded = 64;
  const compact = 43;
  const height = expanded + (compact - expanded) * eased;
  const titleSize = 18 + (14 - 18) * eased;
  const subtitleSize = 13 + (10.5 - 13) * eased;
  useLayoutEffect(() => {
    if (!mount) return;
    mount.root.className = "ws-sticky-goal-root";
    mount.root.dataset.scrollProgress = progress.toFixed(3);
    mount.root.style.height = `${height}px`;
    mount.scroller.style.scrollPaddingTop = `${height}px`;
    return () => {
      mount.root.className = "";
      mount.root.style.removeProperty("height");
      delete mount.root.dataset.scrollProgress;
    };
  }, [mount, progress, height]);

  if (!mount || !context) return null;
  return createPortal(
    <div className="ws-sticky-goal">
      <h2
        className="ws-sticky-goal__title"
        style={{ fontSize: titleSize, opacity: 1 - 0.18 * eased }}
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
