import { beforeEach, expect, it, vi } from "vitest";
import { snoozeThreads } from "../../src/app/snooze/actions.ts";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  toast.mockClear();
  toast.error.mockClear();
});

it("names a batch in its toast, and Undo gives each thread back its earlier snooze", async () => {
  const setSnoozes = vi.fn(async () => undefined);
  const threads = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const earlier = {
    b: { until: 5_000, attentionAt: 0, at: 0 },
    c: { until: null, attentionAt: 0, at: 0 },
  };
  snoozeThreads(setSnoozes, threads, null, {
    previous: (thread) => earlier[thread.id as keyof typeof earlier],
    subject: "3 threads in Alpha",
  });
  expect(setSnoozes).toHaveBeenCalledWith(threads, null);
  await vi.waitFor(() => expect(toast).toHaveBeenCalled());
  const [message, options] = toast.mock.calls[0] as unknown as [
    string,
    { action: { onClick: () => void } },
  ];
  expect(message).toBe("Snoozed 3 threads in Alpha until it updates");
  setSnoozes.mockClear();
  options.action.onClick();
  expect(setSnoozes.mock.calls).toEqual([
    [[{ id: "a" }], "wake"],
    [[{ id: "b" }], 5_000],
    [[{ id: "c" }], null],
  ]);
});

it("reports a failed snooze instead of confirming it", async () => {
  const setSnoozes = vi.fn(async () => {
    throw new Error("Only active threads can be snoozed.");
  });
  snoozeThreads(setSnoozes, [{ id: "a" }], 1_000);
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Only active threads can be snoozed.",
    ),
  );
  expect(toast).not.toHaveBeenCalled();
});
