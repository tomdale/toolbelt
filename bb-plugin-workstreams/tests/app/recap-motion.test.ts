// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { holdSpace } from "../../src/app/composer/recapMotion.ts";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/**
 * BB's bottom-anchored thread scroller with a fake geometry: the timeline,
 * then the sticky footer whose grid stack holds the recap slot and one
 * sibling banner. The scroll range follows from the timeline and slot sizes.
 */
function scroller(options: {
  timeline: number;
  slot: number;
  viewport: number;
  /** Defaults to pinned at the bottom. */
  scrollTop?: number;
}) {
  const geometry = { ...options, gap: 8, rest: 100 };
  document.body.innerHTML = `
    <div id="scroller">
      <div id="content">
        <div id="timeline"></div>
        <div id="sentinel" class="scroll-bottom-anchor"></div>
        <div data-scroll-footer="">
          <div id="grid" style="display: grid; row-gap: 8px">
            <div style="display: contents"><div id="slot"></div></div>
            <div id="sibling"></div>
          </div>
        </div>
      </div>
    </div>`;
  const byId = (id: string) => document.getElementById(id)!;
  const slot = byId("slot");
  const scrollerEl = byId("scroller");
  const slotHeight = () =>
    slot.style.display === "none"
      ? null
      : slot.style.height
        ? Number.parseFloat(slot.style.height)
        : geometry.slot;
  const scrollHeight = () => {
    const held = slotHeight();
    return (
      geometry.timeline +
      geometry.rest +
      (held === null ? 0 : held + geometry.gap)
    );
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const height =
        this.id === "timeline"
          ? geometry.timeline
          : this.id === "slot"
            ? (slotHeight() ?? 0)
            : 0;
      return { height } as DOMRect;
    },
  );
  Object.defineProperty(scrollerEl, "scrollHeight", { get: scrollHeight });
  Object.defineProperty(scrollerEl, "clientHeight", {
    get: () => geometry.viewport,
  });
  let top = options.scrollTop ?? scrollHeight() - geometry.viewport;
  Object.defineProperty(scrollerEl, "scrollTop", {
    get: () => top,
    set: (value: number) => (top = value),
  });
  return {
    slot,
    slotHeight,
    grow(by: number) {
      geometry.timeline += by;
    },
    scrollTo(value: number) {
      top = value;
      scrollerEl.dispatchEvent(new Event("scroll"));
    },
  };
}

it("trades held space for timeline growth until it is used up", () => {
  const dom = scroller({ timeline: 1000, slot: 120, viewport: 600 });
  const onRelease = vi.fn();
  const space = holdSpace(dom.slot, onRelease)!;
  expect(space).not.toBeNull();

  dom.grow(50);
  space.settle();
  expect(dom.slotHeight()).toBe(70);

  // The last 8px are the grid gap, which only goes with the slot.
  dom.grow(70);
  space.settle();
  expect(dom.slotHeight()).toBe(0);
  expect(onRelease).not.toHaveBeenCalled();

  dom.grow(10);
  space.settle();
  expect(dom.slotHeight()).toBeNull();
  expect(onRelease).toHaveBeenCalledOnce();
});

it("releases a short thread at once, since nothing there can move", () => {
  const dom = scroller({ timeline: 100, slot: 120, viewport: 600 });
  const onRelease = vi.fn();
  holdSpace(dom.slot, onRelease)!.settle();
  expect(onRelease).toHaveBeenCalledOnce();
});

it("waits for the ghost before releasing, but not before it is used up", () => {
  const dom = scroller({ timeline: 100, slot: 120, viewport: 600 });
  const onRelease = vi.fn();
  let dissolving = true;
  const space = holdSpace(dom.slot, onRelease, () => dissolving)!;
  space.settle();
  expect(onRelease).not.toHaveBeenCalled();
  dissolving = false;
  space.settle();
  expect(onRelease).toHaveBeenCalledOnce();
});

it("releases once the reader is scrolled far enough up not to notice", () => {
  const dom = scroller({ timeline: 2000, slot: 120, viewport: 600 });
  const onRelease = vi.fn();
  holdSpace(dom.slot, onRelease);
  dom.scrollTo(1550);
  expect(onRelease).not.toHaveBeenCalled();
  dom.scrollTo(1500);
  expect(onRelease).toHaveBeenCalledOnce();
});

it("does nothing outside BB's thread scroller", () => {
  const slot = document.createElement("div");
  document.body.append(slot);
  expect(holdSpace(slot, () => {})).toBeNull();
});

it("switches off the sentinel's scroll anchoring only while holding", () => {
  const dom = scroller({ timeline: 1000, slot: 120, viewport: 600 });
  const sentinel = document.getElementById("sentinel")!;
  const space = holdSpace(dom.slot, () => {})!;
  expect(sentinel.style.overflowAnchor).toBe("none");
  space.dispose();
  expect(sentinel.style.overflowAnchor).toBe("");
});
