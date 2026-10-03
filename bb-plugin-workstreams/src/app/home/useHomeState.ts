import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Which Home groups, folds, and thread trees the user opened or closed on this
 * device. It is its own store rather than the sidebar's: the two lists start
 * from different defaults, and a phone's drawer and Home screen are both
 * mounted at once, so sharing one key would let either overwrite the other.
 */
export const HOME_STATE_KEY = "workstreams:v1:home";

type Open = Record<string, boolean>;

function read(): Open {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(HOME_STATE_KEY) ?? "{}",
    );
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "boolean"),
    );
  } catch {
    return {};
  }
}

function write(open: Open): void {
  try {
    window.localStorage.setItem(HOME_STATE_KEY, JSON.stringify(open));
  } catch {
    // Open and closed state is a convenience; losing it is harmless.
  }
}

/** A key the user never touched is open or closed by the caller's default. */
export function useHomeState() {
  const [open, setOpen] = useState<Open>(read);
  // Only a change the user made is written, and after it commits.
  const changed = useRef(false);
  useEffect(() => {
    if (changed.current) write(open);
  }, [open]);
  const isOpen = useCallback(
    (id: string, byDefault: boolean) => open[id] ?? byDefault,
    [open],
  );
  const update = useCallback((change: (current: Open) => Open) => {
    changed.current = true;
    setOpen(change);
  }, []);
  const toggle = useCallback(
    (id: string, byDefault: boolean) =>
      update((current) => ({ ...current, [id]: !(current[id] ?? byDefault) })),
    [update],
  );
  /** Opens or closes every id at once (Expand all / Collapse all). */
  const setAll = useCallback(
    (ids: readonly string[], value: boolean) =>
      update((current) => ({
        ...current,
        ...Object.fromEntries(ids.map((id) => [id, value])),
      })),
    [update],
  );
  return { isOpen, toggle, setAll };
}
