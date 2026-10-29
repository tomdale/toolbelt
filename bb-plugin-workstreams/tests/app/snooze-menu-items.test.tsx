// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import {
  SnoozeMenuItems,
  plainMenuKit,
} from "../../src/app/snooze/SnoozeMenuItems.tsx";
import type { SnoozePrefs } from "../../src/domain/snooze.ts";

const prefs: SnoozePrefs = {
  presets: [
    {
      id: "evening",
      label: "This evening",
      rule: { kind: "time", day: "today", hour: 18, minute: 0 },
    },
  ],
  default: "evening",
};

beforeEach(() => {
  installTestPluginRuntime();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-14T17:59:30"));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const menu = (onSnooze = vi.fn()) => {
  render(
    <div role="menu" aria-label="Snooze">
      <SnoozeMenuItems
        kit={plainMenuKit}
        // A minute-old clock, as the sidebar's can be.
        now={Date.now() - 60_000}
        prefs={prefs}
        onSnooze={onSnooze}
        onCustom={() => undefined}
      />
    </div>,
  );
  return onSnooze;
};

it("works out a preset's wake time when it is chosen", () => {
  const onSnooze = menu();
  // The menu was drawn before 6 PM; the choice comes after it.
  vi.setSystemTime(new Date("2026-01-14T18:00:30"));
  fireEvent.click(screen.getByRole("menuitem", { name: /^This evening/ }));
  expect(onSnooze).toHaveBeenCalledWith(
    new Date("2026-01-15T18:00:00").getTime(),
  );
});

it("hands focus back to Custom when the pointer leaves its open submenu", () => {
  menu();
  const custom = screen.getByRole("menuitem", { name: "Custom" });
  const wrapper = custom.parentElement!;
  custom.focus();
  // Opened by hover, then entered from the keyboard.
  fireEvent.pointerEnter(wrapper, { pointerType: "mouse" });
  act(() => void vi.advanceTimersByTime(150));
  fireEvent.keyDown(custom, { key: "ArrowRight" });
  const submenu = screen.getByRole("menu", { name: "Custom" });
  expect(submenu.contains(document.activeElement)).toBe(true);
  fireEvent.pointerLeave(wrapper, { pointerType: "mouse" });
  act(() => void vi.advanceTimersByTime(300));
  expect(screen.queryByRole("menu", { name: "Custom" })).toBeNull();
  expect(document.activeElement).toBe(custom);
  // Hovering again opens it without taking focus.
  fireEvent.pointerEnter(wrapper, { pointerType: "mouse" });
  act(() => void vi.advanceTimersByTime(150));
  expect(screen.getByRole("menu", { name: "Custom" })).toBeTruthy();
  expect(document.activeElement).toBe(custom);
});
