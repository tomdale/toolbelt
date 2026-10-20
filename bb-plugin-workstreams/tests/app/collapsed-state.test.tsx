// @vitest-environment jsdom
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  groupCollapseKey,
  useCollapsed,
} from "../../src/app/sidebar/useCollapsed.ts";
afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage"));
  });
  cleanup();
});
it("shares toggle state between mounted surfaces and retains topic identity across native sections", () => {
  const first = renderHook(() => useCollapsed());
  const second = renderHook(() => useCollapsed());
  const oldKey = groupCollapseKey("section-old", "topic");
  act(() => first.result.current.toggle(oldKey));
  expect(
    second.result.current.isCollapsed(groupCollapseKey("section-new", "topic")),
  ).toBe(true);
  act(() =>
    second.result.current.toggle(groupCollapseKey("section-new", "topic")),
  );
  expect(first.result.current.isCollapsed(oldKey)).toBe(false);
});
it("keeps toggles observable when writes fail but reads still work", () => {
  const hook = renderHook(() => useCollapsed());
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });
  act(() => hook.result.current.toggle("topic"));
  expect(hook.result.current.isCollapsed("topic")).toBe(true);
  act(() => hook.result.current.toggle("topic"));
  expect(hook.result.current.isCollapsed("topic")).toBe(false);
});
it("ignores malformed persisted values and receives cross-window changes", () => {
  window.localStorage.setItem(
    "workstreams:v2:collapsed",
    JSON.stringify({ topic: "false", valid: true }),
  );
  const hook = renderHook(() => useCollapsed());
  expect(hook.result.current.isCollapsed("topic")).toBe(false);
  expect(hook.result.current.isCollapsed("valid")).toBe(true);
  act(() => {
    window.localStorage.setItem(
      "workstreams:v2:collapsed",
      JSON.stringify({ topic: true }),
    );
    window.dispatchEvent(new StorageEvent("storage"));
  });
  expect(hook.result.current.isCollapsed("topic")).toBe(true);
});
