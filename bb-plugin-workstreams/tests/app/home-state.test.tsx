// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  HOME_STATE_KEY,
  useHomeState,
} from "../../src/app/home/useHomeState.ts";
import { SETTLE_MS, useSettled } from "../../src/app/home/useSettled.ts";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useHomeState", () => {
  it("uses the caller's default for anything the user never touched, and writes nothing until they do", () => {
    const { result } = renderHook(() => useHomeState());
    expect(result.current.isOpen("group:a", true)).toBe(true);
    expect(result.current.isOpen("group:a", false)).toBe(false);
    expect(window.localStorage.getItem(HOME_STATE_KEY)).toBeNull();
  });

  it("flips from the default on toggle and remembers it", () => {
    const { result } = renderHook(() => useHomeState());
    act(() => result.current.toggle("group:a", false));
    expect(result.current.isOpen("group:a", false)).toBe(true);
    act(() => result.current.toggle("group:a", false));
    expect(result.current.isOpen("group:a", false)).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(HOME_STATE_KEY)!)).toEqual({
      "group:a": false,
    });
  });

  it("sets many at once", () => {
    const { result } = renderHook(() => useHomeState());
    act(() => result.current.setAll(["group:a", "group:b"], true));
    expect(result.current.isOpen("group:a", false)).toBe(true);
    expect(result.current.isOpen("group:b", false)).toBe(true);
    act(() => result.current.setAll(["group:a"], false));
    expect(result.current.isOpen("group:a", true)).toBe(false);
    expect(result.current.isOpen("group:b", false)).toBe(true);
  });

  it("starts from what a previous visit stored", () => {
    window.localStorage.setItem(
      HOME_STATE_KEY,
      JSON.stringify({ "group:a": true }),
    );
    const { result } = renderHook(() => useHomeState());
    expect(result.current.isOpen("group:a", false)).toBe(true);
  });

  it.each([
    ["not JSON", "{oops"],
    ["not an object", "42"],
    ["null", "null"],
  ])("ignores stored state that is %s", (_name, stored) => {
    window.localStorage.setItem(HOME_STATE_KEY, stored);
    const { result } = renderHook(() => useHomeState());
    expect(result.current.isOpen("group:a", true)).toBe(true);
  });

  it("drops stored values that are not booleans", () => {
    window.localStorage.setItem(
      HOME_STATE_KEY,
      JSON.stringify({ "group:a": "yes", "group:b": false }),
    );
    const { result } = renderHook(() => useHomeState());
    expect(result.current.isOpen("group:a", true)).toBe(true);
    expect(result.current.isOpen("group:b", true)).toBe(false);
  });

  it("still toggles when the browser won't store anything", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { result } = renderHook(() => useHomeState());
    act(() => result.current.toggle("group:a", false));
    expect(result.current.isOpen("group:a", false)).toBe(true);
  });
});

describe("useSettled", () => {
  it("is true as soon as what it waits for is ready", () => {
    const { result, rerender } = renderHook(({ ready }) => useSettled(ready), {
      initialProps: { ready: false },
    });
    expect(result.current).toBe(false);
    rerender({ ready: true });
    expect(result.current).toBe(true);
  });

  it("gives up waiting after the settle time, so a silent server never holds a surface back", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSettled(false));
    act(() => vi.advanceTimersByTime(SETTLE_MS - 1));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("never starts the clock once ready", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSettled(true));
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current).toBe(true);
  });
});
