/**
 * Sidebar motion that keeps changes the user didn't make from jolting the
 * list: rows and bands open and close their height instead of popping, so
 * everything below slides, and workstreams glide to their new place when a
 * priority change reorders them.
 *
 * Motion is skipped where Web Animations are unavailable (tests, old
 * engines) and under reduced motion; there every change applies at once.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  type RefObject,
} from "react";

/**
 * How long a row or band takes to open, and to close (`.ws-presence` in
 * styles.css). One duration and curve for both, so a row closing while
 * another opens nets out without the list bobbing.
 */
export const ENTER_MS = 260;
export const LEAVE_MS = 260;
const FLIP_MS = 320;
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/** Whether sidebar motion runs here and now. */
export function canAnimate(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof Element === "undefined" || !("animate" in Element.prototype))
    return false;
  return !(
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export type PresencePhase = "enter" | "idle" | "leave";
export type PresenceEntry<T> = {
  readonly key: string;
  readonly item: T;
  readonly phase: PresencePhase;
};

/**
 * The next rendered list: `items` in order, each new one entering, plus
 * each item that just left, still showing its last value, in its former
 * place after the nearest earlier neighbor that remains. Without `animate`,
 * it is `items` exactly.
 */
export function mergePresence<T>(
  previous: readonly PresenceEntry<T>[],
  items: readonly T[],
  keyOf: (item: T) => string,
  animate: boolean,
): PresenceEntry<T>[] {
  const before = new Map(previous.map((entry) => [entry.key, entry]));
  const out: PresenceEntry<T>[] = items.map((item) => {
    const key = keyOf(item);
    const old = before.get(key);
    const phase: PresencePhase = !animate
      ? "idle"
      : !old || old.phase === "leave"
        ? "enter"
        : old.phase;
    return { key, item, phase };
  });
  if (!animate) return out;
  const present = new Set(out.map((entry) => entry.key));
  previous.forEach((entry, index) => {
    if (present.has(entry.key)) return;
    let at = 0;
    for (let i = index - 1; i >= 0; i--) {
      const found = out.findIndex((o) => o.key === previous[i]!.key);
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    out.splice(at, 0, { key: entry.key, item: entry.item, phase: "leave" });
    present.add(entry.key);
  });
  return out;
}

/**
 * `items` with entering and leaving phases (see {@link mergePresence}). The
 * first render enters nothing, so the list appears as it is. Each phase ends
 * on a timer rather than an animation event, so a missed event never strands
 * a row.
 */
export function usePresence<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): PresenceEntry<T>[] {
  const committed = useRef<PresenceEntry<T>[] | null>(null);
  const timers = useRef(
    new Map<
      string,
      { phase: PresencePhase; id: ReturnType<typeof setTimeout> }
    >(),
  );
  const [, settle] = useReducer((n: number) => n + 1, 0);
  const entries = mergePresence(
    committed.current ?? [],
    items,
    keyOf,
    committed.current !== null && canAnimate(),
  );
  useLayoutEffect(() => {
    committed.current = entries;
  });
  useEffect(() => {
    const live = new Set(entries.map((entry) => entry.key));
    for (const [key, timer] of timers.current)
      if (!live.has(key)) {
        clearTimeout(timer.id);
        timers.current.delete(key);
      }
    for (const entry of entries) {
      const timer = timers.current.get(entry.key);
      if (timer?.phase === entry.phase) continue;
      if (timer) clearTimeout(timer.id);
      timers.current.delete(entry.key);
      if (entry.phase === "idle") continue;
      const { key, phase } = entry;
      const id = setTimeout(
        () => {
          timers.current.delete(key);
          committed.current = (committed.current ?? []).flatMap((e) =>
            e.key !== key || e.phase !== phase
              ? [e]
              : phase === "leave"
                ? []
                : [{ ...e, phase: "idle" as const }],
          );
          settle();
        },
        phase === "enter" ? ENTER_MS : LEAVE_MS,
      );
      timers.current.set(key, { phase, id });
    }
  });
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer.id);
      pending.clear();
    };
  }, []);
  return entries;
}

/**
 * Props for an element that opens and closes with its phase (`.ws-presence`
 * in styles.css). A leaving element is inert and hidden from assistive
 * technology, so it can't be clicked or read while it closes.
 */
export function presenceProps(phase: PresencePhase) {
  return {
    "data-presence": phase === "idle" ? undefined : phase,
    "aria-hidden": phase === "leave" ? true : undefined,
    inert: phase === "leave" ? true : undefined,
  } as const;
}

/**
 * Glides the list's top-level `[data-flip-key]` children from where they
 * were at `capture()` to where they are once `token` changes. Positions are
 * captured across the whole list, so an item that comes out of a fold starts
 * from its place inside it.
 *
 * `moved` names the item the change is about. It would slide across its
 * neighbors, so instead it fades in at its new place once they have mostly
 * made room.
 */
export function useFlip(
  container: RefObject<HTMLElement | null>,
  token: string,
): (moved?: string) => void {
  const before = useRef<Map<string, number> | null>(null);
  const movedKey = useRef<string | undefined>(undefined);
  const capture = useCallback(
    (moved?: string) => {
      const root = container.current;
      if (!root || !canAnimate()) return;
      movedKey.current = moved;
      const top = root.getBoundingClientRect().top;
      before.current = new Map(
        [...root.querySelectorAll<HTMLElement>("[data-flip-key]")].map((el) => [
          el.dataset.flipKey!,
          el.getBoundingClientRect().top - top,
        ]),
      );
    },
    [container],
  );
  useLayoutEffect(() => {
    const rects = before.current;
    const root = container.current;
    before.current = null;
    if (!rects || !root) return;
    const top = root.getBoundingClientRect().top;
    for (const el of root.querySelectorAll<HTMLElement>(
      ":scope > [data-flip-key]",
    )) {
      const key = el.dataset.flipKey!;
      const from = rects.get(key);
      if (from === undefined) continue;
      const dy = from - (el.getBoundingClientRect().top - top);
      if (Math.abs(dy) < 1) continue;
      if (key === movedKey.current) {
        el.animate(
          [
            { opacity: 0, transform: `translateY(${Math.sign(dy) * 6}px)` },
            {
              opacity: 0,
              transform: `translateY(${Math.sign(dy) * 6}px)`,
              offset: 0.35,
            },
            { opacity: 1, transform: "none" },
          ],
          { duration: FLIP_MS + 80, easing: EASE_OUT },
        );
        continue;
      }
      el.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
        { duration: FLIP_MS, easing: EASE_OUT },
      );
    }
    // Runs only when the arrangement token changes; other renders keep any
    // capture for the change it was taken for.
  }, [container, token]);
  return capture;
}
