/**
 * Motion and layout for the recap card in the composer stack: resizing as
 * its contents change, and leaving without moving the thread.
 *
 * BB renders the composer as a sticky footer inside the thread's
 * bottom-anchored scroll content, so the card's height is part of the
 * thread's scroll range. Removing it outright shrinks that range, and a
 * thread pinned to the bottom jumps down by the card's height. Instead the
 * card's slot keeps its height while the card dissolves, and then gives the
 * height back only as fast as new timeline content grows into it. Once
 * the slot is used up, the host's usual pinned scrolling takes over.
 */

const EXIT_MS = 420;
const ENTER_MS = 360;
const RESIZE_MS = 380;
const CROSSFADE_MS = 300;
const REDUCED_MS = 150;
/** Fast start so the card answers the first keystroke, long gentle tail. */
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const EASE_IN_OUT = "cubic-bezier(0.32, 0.72, 0, 1)";

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Runs a Web Animation, resolving at once where the API is unavailable. */
function run(
  element: HTMLElement,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): { finished: Promise<void>; cancel(): void } {
  if (typeof element.animate !== "function")
    return { finished: Promise.resolve(), cancel() {} };
  const animation = element.animate(keyframes, options);
  return {
    // A cancelled animation rejects `finished`; callers only need settlement.
    finished: animation.finished.then(
      () => undefined,
      () => undefined,
    ),
    cancel: () => animation.cancel(),
  };
}

/** The card sinks slightly toward the composer as it blurs and fades out. */
export function animateCardOut(element: HTMLElement) {
  element.style.transformOrigin = "50% 100%";
  if (reducedMotion())
    return run(element, [{ opacity: 1 }, { opacity: 0 }], {
      duration: REDUCED_MS,
      easing: "linear",
      fill: "forwards",
    });
  return run(
    element,
    [
      { opacity: 1, transform: "translateY(0) scale(1)", filter: "blur(0px)" },
      {
        opacity: 0,
        transform: "translateY(8px) scale(0.985)",
        filter: "blur(8px)",
      },
    ],
    { duration: EXIT_MS, easing: EASE_OUT, fill: "forwards" },
  );
}

/**
 * Opens a newly shown slot from `from` (nothing, or what a hold had left) to
 * its natural height, so a pinned thread eases up to make room rather than
 * jumping. Pair it with animateCardIn on the card inside.
 */
export function growSlot(slot: HTMLElement, from = 0) {
  const height = slot.getBoundingClientRect().height;
  if (reducedMotion() || Math.abs(height - from) < 1)
    return { finished: Promise.resolve(), cancel() {} };
  return run(
    slot,
    [
      { height: `${from}px`, overflow: "hidden" },
      { height: `${height}px`, overflow: "hidden" },
    ],
    { duration: RESIZE_MS, easing: EASE_IN_OUT },
  );
}

/** The reverse of animateCardOut, for a card returning to its held slot. */
export function animateCardIn(element: HTMLElement) {
  element.style.transformOrigin = "50% 100%";
  if (reducedMotion())
    return run(element, [{ opacity: 0 }, { opacity: 1 }], {
      duration: REDUCED_MS,
      easing: "linear",
    });
  return run(
    element,
    [
      {
        opacity: 0,
        transform: "translateY(6px) scale(0.99)",
        filter: "blur(6px)",
      },
      { opacity: 1, transform: "translateY(0) scale(1)", filter: "blur(0px)" },
    ],
    { duration: ENTER_MS, easing: EASE_OUT },
  );
}

/**
 * Eases `frame` between heights whenever `body`, its only in-flow child,
 * changes height at a constant width: a recap replacing its skeleton, a
 * newer recap, a layout change. Width changes (the window or a panel being
 * resized) snap instead, since a lagging card would feel sluggish while
 * dragging. The frame clips its contents while it catches up. Returns a
 * disposer.
 */
export function followResizes(frame: HTMLElement, body: HTMLElement) {
  if (typeof ResizeObserver === "undefined") return () => {};
  let lastBody = body.getBoundingClientRect();
  let lastFrame = frame.getBoundingClientRect().height;
  let animation: Animation | null = null;
  const observer = new ResizeObserver(() => {
    const next = body.getBoundingClientRect();
    const widthChanged = next.width !== lastBody.width;
    const heightChanged = next.height !== lastBody.height;
    lastBody = next;
    if (!heightChanged && !widthChanged) return;
    // Mid-animation the frame's rendered height is where the next one
    // starts; otherwise it already shows the new size, so start from the last.
    const from = animation ? frame.getBoundingClientRect().height : lastFrame;
    animation?.cancel();
    animation = null;
    const to = frame.getBoundingClientRect().height;
    lastFrame = to;
    if (
      widthChanged ||
      Math.abs(to - from) < 1 ||
      reducedMotion() ||
      typeof frame.animate !== "function"
    )
      return;
    const current = frame.animate(
      [
        { height: `${from}px`, overflow: "hidden" },
        { height: `${to}px`, overflow: "hidden" },
      ],
      { duration: RESIZE_MS, easing: EASE_IN_OUT },
    );
    animation = current;
    current.onfinish = () => {
      if (animation === current) animation = null;
    };
  });
  observer.observe(body);
  return () => {
    observer.disconnect();
    animation?.cancel();
  };
}

/** Brings new contents into a resizing frame, e.g. a recap over its skeleton. */
export function crossfadeIn(body: HTMLElement) {
  if (reducedMotion())
    return run(body, [{ opacity: 0 }, { opacity: 1 }], {
      duration: REDUCED_MS,
      easing: "linear",
    });
  return run(
    body,
    [
      { opacity: 0, filter: "blur(4px)" },
      { opacity: 1, filter: "blur(0px)" },
    ],
    { duration: CROSSFADE_MS, easing: EASE_OUT },
  );
}

/**
 * The gap the stack's grid places beside the slot. It outlasts the slot's
 * height (a zero-height grid item still has gaps), so it is part of the
 * space held.
 */
function gridGap(slot: HTMLElement): number {
  let grid = slot.parentElement;
  while (grid && getComputedStyle(grid).display === "contents")
    grid = grid.parentElement;
  if (!grid) return 0;
  const style = getComputedStyle(grid);
  if (!style.display.includes("grid")) return 0;
  const items = (parent: Element): number => {
    let count = 0;
    for (const child of Array.from(parent.children)) {
      const display = getComputedStyle(child).display;
      if (display === "contents") count += items(child);
      else if (display !== "none") count += 1;
    }
    return count;
  };
  return items(grid) > 1 ? Number.parseFloat(style.rowGap) || 0 : 0;
}

/**
 * Shortens a hold's `slot` by what `below` adds to the stack (its height,
 * its margins, and the grid gap between them), so the stack's total height doesn't change
 * when `below` appears in the same commit as the slot. For Generate Recap
 * taking a dismissed card's place.
 */
export function makeRoomBelow(slot: HTMLElement, below: HTMLElement) {
  const height = slot.getBoundingClientRect().height;
  // Margins count too: the stack's grid lays items out by their margin box.
  const style = getComputedStyle(below);
  const margins =
    (Number.parseFloat(style.marginTop) || 0) +
    (Number.parseFloat(style.marginBottom) || 0);
  const taken = below.getBoundingClientRect().height + margins + gridGap(slot);
  slot.style.height = `${Math.max(0, height - taken)}px`;
}

export type HeldSpace = {
  /** Re-evaluates the hold, e.g. once the dissolving card has gone. */
  settle(): void;
  dispose(): void;
};

/**
 * Keeps `slot` holding its current height plus its grid gap, and trades that
 * space for timeline growth one pixel for one pixel, so the scroll range (and
 * with it every visible pixel of the thread) stays put while new content
 * fills where the card was. Calls `onRelease` once the slot can go without
 * moving anything: it is used up, nothing overflows, or the reader is
 * scrolled far enough up that the shorter range doesn't reach them.
 * `isBlocked` defers every release except the used-up one, so the slot
 * outlives the card dissolving inside it.
 *
 * While holding, it switches off the browser's scroll anchoring on the
 * host's bottom sentinel. That anchoring moves the scroll position during
 * the layout that adds a new row, and that position can reach the screen a
 * frame before the slot's matching shrink, flicking the thread up and back.
 * With it off, the host's own pinning and the shrink land together.
 *
 * Returns null outside BB's bottom-anchored thread scroller, whose DOM this
 * reads: `[data-scroll-footer]` sits in the scroll content after the
 * timeline and the `.scroll-bottom-anchor` sentinel.
 */
export function holdSpace(
  slot: HTMLElement,
  onRelease: () => void,
  isBlocked: () => boolean = () => false,
): HeldSpace | null {
  const footer = slot.closest("[data-scroll-footer]");
  const content = footer?.parentElement;
  const scroller = content?.parentElement;
  const timeline = content?.firstElementChild;
  if (!scroller || !(timeline instanceof HTMLElement) || timeline === footer)
    return null;

  const sentinel = content.querySelector<HTMLElement>(
    ":scope > .scroll-bottom-anchor",
  );
  const anchoring = sentinel?.style.overflowAnchor ?? "";
  if (sentinel) sentinel.style.overflowAnchor = "none";

  const gap = gridGap(slot);
  let held = slot.getBoundingClientRect().height + gap;
  let lastTimeline = timeline.getBoundingClientRect().height;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    // Synchronously, so layout, the host's scroll pinning, and paint never
    // see a used-up slot before React unmounts it.
    slot.style.display = "none";
    dispose();
    onRelease();
  };

  const settle = () => {
    if (released) return;
    const height = timeline.getBoundingClientRect().height;
    const grew = height - lastTimeline;
    lastTimeline = height;
    if (grew > 0) {
      held -= grew;
      if (held <= 0) return release();
      // The gap can't shrink, so the last `gap` pixels are only given back
      // with the slot itself.
      slot.style.height = `${Math.max(0, held - gap)}px`;
    }
    if (isBlocked()) return;
    const range = scroller.scrollHeight - scroller.clientHeight;
    const belowViewport = range - scroller.scrollTop;
    // Short threads are top-aligned, so nothing moves when they lose space.
    if (range <= 1 || belowViewport >= held) release();
  };

  const observer =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(settle);
  observer?.observe(timeline);
  scroller.addEventListener("scroll", settle, { passive: true });

  function dispose() {
    observer?.disconnect();
    scroller?.removeEventListener("scroll", settle);
    if (sentinel) sentinel.style.overflowAnchor = anchoring;
  }

  return { settle, dispose };
}
