import { useSyncExternalStore } from "react";

/**
 * Which threads have scrolled their in-pane goal heading out of view. The
 * heading lives in the message scroller and the title-bar chip in BB's thread
 * header, so they hand off through this module-level set.
 */
const collapsed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export function setGoalHeadingCollapsed(
  threadId: string,
  isCollapsed: boolean,
): void {
  if (collapsed.has(threadId) === isCollapsed) return;
  if (isCollapsed) collapsed.add(threadId);
  else collapsed.delete(threadId);
  version += 1;
  for (const listener of listeners) listener();
}

export function useGoalHeadingCollapsed(threadId: string): boolean {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  return collapsed.has(threadId);
}
