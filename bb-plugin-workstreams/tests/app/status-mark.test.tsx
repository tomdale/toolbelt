// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synchronizeSpinnerAnimations } from "../../src/app/sidebar/StatusMark.tsx";

type FakeAnimation = { startTime: number | null };

const animations = new WeakMap<HTMLElement, FakeAnimation[]>();

const originalGetAnimations = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "getAnimations",
);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: vi.fn(function (this: HTMLElement) {
      return animations.get(this) ?? [];
    }),
  });
});

afterEach(() => {
  if (originalGetAnimations)
    Object.defineProperty(
      HTMLElement.prototype,
      "getAnimations",
      originalGetAnimations,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
});

describe("synchronizeSpinnerAnimations", () => {
  it("puts late-mounted marks on the same document timeline phase", () => {
    const first = document.createElement("span");
    const second = document.createElement("span");
    const firstAnimation = { startTime: null };
    const secondAnimation = { startTime: null };
    animations.set(first, [firstAnimation]);
    animations.set(second, [secondAnimation]);

    synchronizeSpinnerAnimations(first);
    synchronizeSpinnerAnimations(second);

    expect(first.getAnimations).toHaveBeenCalledWith({ subtree: true });

    expect(firstAnimation.startTime).toBe(0);
    expect(secondAnimation.startTime).toBe(0);
  });

  it("also resets a remounted mark without retaining DOM state", () => {
    const oldMark = document.createElement("span");
    const replacement = document.createElement("span");
    const oldAnimation = { startTime: 812 };
    const replacementAnimation = { startTime: null };
    animations.set(oldMark, [oldAnimation]);
    animations.set(replacement, [replacementAnimation]);

    synchronizeSpinnerAnimations(oldMark);
    synchronizeSpinnerAnimations(replacement);

    expect(oldAnimation.startTime).toBe(0);
    expect(replacementAnimation.startTime).toBe(0);
  });

  it("synchronizes every dot without changing its stagger", () => {
    const mark = document.createElement("span");
    const dots = [0, 150, 300].map((delay) => ({ startTime: null, delay }));
    animations.set(mark, dots);

    synchronizeSpinnerAnimations(mark);

    expect(dots.map((dot) => dot.startTime)).toEqual([0, 0, 0]);
    expect(dots.map((dot) => dot.delay)).toEqual([0, 150, 300]);
  });

  it("leaves reduced-motion marks without animations alone", () => {
    expect(() =>
      synchronizeSpinnerAnimations(document.createElement("span")),
    ).not.toThrow();
  });

  it("supports environments without the Web Animations API", () => {
    Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    expect(() =>
      synchronizeSpinnerAnimations(document.createElement("span")),
    ).not.toThrow();
  });
});
