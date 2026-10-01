// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// jsdom lacks AnimationEvent, which makes React listen for the prefixed
// `webkitAnimationStart` instead of the `animationstart` browsers dispatch.
// React picks the name when it loads, so this runs before any import.
vi.hoisted(() => {
  if (!("AnimationEvent" in globalThis))
    Object.assign(globalThis, { AnimationEvent: class extends Event {} });
});

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
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
  cleanup();
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

describe("WorkingMark", () => {
  it("resynchronizes when a moved mark's animation restarts", async () => {
    const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
    const section = app.settingsSections.find((s) => s.id === "sidebar")!;
    const slot = await renderSlot(
      section,
      {},
      {
        rpc: {
          prefs: () => ({
            prefs: {
              sidebar: {},
              threads: {},
              newWork: {},
              organize: {},
              advanced: {},
            },
          }),
          setPrefs: (input: unknown) => ({
            prefs: (input as { patch: unknown }).patch,
          }),
          spinner: async () => ({
            spinner: { shape: "arc", primary: "subtle", secondary: "auto" },
          }),
          setSpinner: (raw: unknown) => raw as { spinner: unknown },
        },
      },
    );
    await waitFor(() =>
      expect(slot.container.querySelector(".ws-spin")).not.toBeNull(),
    );
    const mark = slot.container.querySelector<HTMLElement>(".ws-spin")!;
    // Moving a node replaces its CSS animation with one that starts at the
    // move, which the mount-time sync never sees.
    const restarted = { startTime: 4_812 };
    animations.set(mark, [restarted]);

    fireEvent.animationStart(mark);

    expect(restarted.startTime).toBe(0);
  });
});
