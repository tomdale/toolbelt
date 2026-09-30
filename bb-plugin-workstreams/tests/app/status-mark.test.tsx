// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synchronizeSpinnerAnimations } from "../../src/app/sidebar/StatusMark.tsx";

type FakeAnimation = { startTime: number | null };

const animations = new WeakMap<HTMLElement, FakeAnimation[]>();

beforeEach(() => {
  HTMLElement.prototype.getAnimations = vi.fn(function (this: HTMLElement) {
    return animations.get(this) ?? [];
  }) as unknown as typeof HTMLElement.prototype.getAnimations;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("synchronizeSpinnerAnimations", () => {
  it("puts late-mounted marks on the same document timeline phase", () => {
    const first = document.createElement("span");
    const second = document.createElement("span");
    const firstAnimation = { startTime: null };
    const secondAnimation = { startTime: null };
    animations.set(first, [firstAnimation]);
    animations.set(second, [secondAnimation]);

    synchronizeSpinnerAnimations(first, "arc");
    synchronizeSpinnerAnimations(second, "arc");

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

    synchronizeSpinnerAnimations(oldMark, "dots");
    synchronizeSpinnerAnimations(replacement, "dots");

    expect(oldAnimation.startTime).toBe(0);
    expect(replacementAnimation.startTime).toBe(0);
    expect(animations.has(oldMark)).toBe(true);
    // The helper owns no listeners, timers, or shared registry to clean up.
  });
});
