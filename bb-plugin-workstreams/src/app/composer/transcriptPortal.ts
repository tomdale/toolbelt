import { useEffect, useState, type RefObject } from "react";

/*
 * BB has no plugin API for transcript rows, so notices mount into the host's
 * timeline DOM. These selectors are BB internals, not SDK contract: when they
 * stop matching, callers fall back to rendering in the composer banner.
 */
const THREAD_WINDOW = "[data-thread-window]";
const TOP_LEVEL_ROWS = '[data-timeline-row-list="top-level"]';

/**
 * Returns a host element kept as the last child of the transcript row list in
 * the same thread window as `anchor`, or null when the transcript is not found.
 */
export function useTranscriptTail(
  anchor: RefObject<HTMLElement | null>,
  enabled: boolean,
): { host: HTMLElement | null; resolved: boolean } {
  const [result, setResult] = useState<{
    host: HTMLElement | null;
    resolved: boolean;
  }>({ host: null, resolved: false });

  useEffect(() => {
    if (!enabled) {
      setResult({ host: null, resolved: true });
      return;
    }
    const el = document.createElement("div");
    el.className = "ws-transcript-notice";
    let list: Element | null = null;
    let listObserver: MutationObserver | null = null;

    // React appends new rows after our node; move it back to the end.
    const keepLast = () => {
      if (list && list.lastElementChild !== el) list.appendChild(el);
    };
    const attach = () => {
      const next =
        anchor.current?.closest(THREAD_WINDOW)?.querySelector(TOP_LEVEL_ROWS) ??
        null;
      if (next === list) return keepLast();
      listObserver?.disconnect();
      el.remove();
      list = next;
      if (!list) return setResult({ host: null, resolved: true });
      list.appendChild(el);
      listObserver = new MutationObserver(keepLast);
      listObserver.observe(list, { childList: true });
      setResult({ host: el, resolved: true });
    };

    attach();
    // The row list remounts on thread switches and first load. Do not query
    // the whole window for every descendant mutation: editing the composer can
    // produce those on every keystroke, while the list observer above already
    // handles ordinary row additions.
    const windowEl = anchor.current?.closest(THREAD_WINDOW);
    const watchForReplacement = () => {
      if (!list || !windowEl?.contains(list)) attach();
    };
    const windowObserver = new MutationObserver(watchForReplacement);
    if (windowEl)
      windowObserver.observe(windowEl, { childList: true, subtree: true });

    return () => {
      windowObserver.disconnect();
      listObserver?.disconnect();
      el.remove();
      setResult({ host: null, resolved: true });
    };
  }, [anchor, enabled]);

  return result;
}
