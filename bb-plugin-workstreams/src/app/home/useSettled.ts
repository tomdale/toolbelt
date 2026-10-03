import { useEffect, useState } from "react";

/** How long a surface waits for what it needs before drawing without it. */
export const SETTLE_MS = 3000;

/**
 * True once `ready`, or once it has been missing for {@link SETTLE_MS}. A read
 * that never answers (the server is down) must not hold a surface back for
 * good; this lets it fall back to what it has.
 */
export function useSettled(ready: boolean, timeoutMs = SETTLE_MS): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setLate(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [ready, timeoutMs]);
  return ready || late;
}
