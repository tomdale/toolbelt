import { useCallback, useMemo, useSyncExternalStore } from "react";

const KEY = "workstreams:v2:collapsed";
const CHANGED = "workstreams:collapse-changed";
type Stored = Record<string, boolean>;
let fallback = "{}";
let failedAgainst: string | undefined;
function snapshot(): string {
  try {
    const stored = window.localStorage.getItem(KEY) ?? "{}";
    if (stored === failedAgainst) return fallback;
    failedAgainst = undefined;
    return stored;
  } catch {
    return fallback;
  }
}
function parse(raw: string): Stored {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(([, v]) => typeof v === "boolean"),
        )
      : {};
  } catch {
    return {};
  }
}
function subscribe(listener: () => void) {
  const storageChanged = () => {
    failedAgainst = undefined;
    listener();
  };
  window.addEventListener("storage", storageChanged);
  window.addEventListener(CHANGED, listener);
  return () => {
    window.removeEventListener("storage", storageChanged);
    window.removeEventListener(CHANGED, listener);
  };
}
/** Topic identity survives native section deletion and recreation. */
export function groupCollapseKey(sectionId: string, topicId?: string): string {
  return topicId ? `topic:${topicId}` : sectionId;
}

/** Shared per-client visual state, independent of automatic topic grouping. */
export function useCollapsed() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "{}");
  const state = useMemo(() => parse(raw), [raw]);
  const isCollapsed = useCallback(
    (id: string, byDefault = false) => state[id] ?? byDefault,
    [state],
  );
  const toggle = useCallback((id: string, byDefault = false) => {
    const current = parse(snapshot());
    fallback = JSON.stringify({
      ...current,
      [id]: !(current[id] ?? byDefault),
    });
    let stored: string | undefined;
    try {
      stored = window.localStorage.getItem(KEY) ?? "{}";
      window.localStorage.setItem(KEY, fallback);
      failedAgainst = undefined;
    } catch {
      // Quota failures can leave reads working but returning the old snapshot.
      failedAgainst = stored;
    }
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  return { isCollapsed, toggle };
}
