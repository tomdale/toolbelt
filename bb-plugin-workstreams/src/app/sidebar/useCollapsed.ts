import { useCallback, useState } from "react";

const KEY = "workstreams:v2:collapsed";

type Stored = Record<string, boolean>;

function load(): Stored {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(KEY) ?? "{}",
    );
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

/**
 * Per-client collapse state for bands and groups. A key the user never
 * touched uses the caller's default, so Dormant can start collapsed while
 * workstreams start open.
 */
export function useCollapsed() {
  const [state, setState] = useState<Stored>(load);
  const isCollapsed = useCallback(
    (id: string, byDefault = false) => state[id] ?? byDefault,
    [state],
  );
  const toggle = useCallback((id: string, byDefault = false) => {
    setState((prev) => {
      const next = { ...prev, [id]: !(prev[id] ?? byDefault) };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Collapse state is a convenience; losing it is harmless.
      }
      return next;
    });
  }, []);
  return { isCollapsed, toggle };
}
