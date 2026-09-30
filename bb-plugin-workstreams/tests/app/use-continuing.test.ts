// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  RETURN_DELAY_MS,
  RUN_START_GRACE_MS,
  useContinuing,
} from "../../src/app/composer/useContinuing.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type State = Parameters<typeof useContinuing>[0];
const idle: State = { drafting: false, isSubmitting: false, isRunning: false };

function render(initial: State) {
  return renderHook((state: State) => useContinuing(state), {
    initialProps: initial,
  });
}

it("turns on at once and off after a quiet beat", () => {
  const hook = render(idle);
  expect(hook.result.current).toBe(false);
  hook.rerender({ ...idle, drafting: true });
  expect(hook.result.current).toBe(true);
  hook.rerender(idle);
  expect(hook.result.current).toBe(true);
  act(() => vi.advanceTimersByTime(RETURN_DELAY_MS));
  expect(hook.result.current).toBe(false);
});

it("bridges the gap between a cleared draft and its pending send", () => {
  const hook = render({ ...idle, drafting: true });
  hook.rerender(idle);
  act(() => vi.advanceTimersByTime(RETURN_DELAY_MS / 2));
  hook.rerender({ ...idle, isSubmitting: true });
  act(() => vi.advanceTimersByTime(RETURN_DELAY_MS));
  expect(hook.result.current).toBe(true);
});

it("stays on after a submit until its run starts", () => {
  const hook = render({ ...idle, isSubmitting: true });
  hook.rerender(idle);
  act(() => vi.advanceTimersByTime(RUN_START_GRACE_MS - 1));
  expect(hook.result.current).toBe(true);
  hook.rerender({ ...idle, isRunning: true });
  hook.rerender(idle);
  // The run ended, so only the short beat remains.
  act(() => vi.advanceTimersByTime(RETURN_DELAY_MS));
  expect(hook.result.current).toBe(false);
});

it("gives up on a run that never starts", () => {
  const hook = render({ ...idle, isSubmitting: true });
  hook.rerender(idle);
  act(() => vi.advanceTimersByTime(RUN_START_GRACE_MS));
  expect(hook.result.current).toBe(false);
});

it("settles when the host reports submitting and running together", () => {
  const hook = render({ ...idle, drafting: true });
  hook.rerender({ ...idle, isSubmitting: true, isRunning: true });
  expect(hook.result.current).toBe(true);
  hook.rerender(idle);
  act(() => vi.advanceTimersByTime(RETURN_DELAY_MS));
  expect(hook.result.current).toBe(false);
});
