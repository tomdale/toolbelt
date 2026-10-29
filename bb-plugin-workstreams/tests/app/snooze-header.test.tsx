// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, sidebarThread } from "./fixtures.ts";
import { DEFAULT_SNOOZE_PREFS } from "../../src/domain/snooze.ts";

afterEach(cleanup);

async function mount({
  snoozes = {},
  threads = [sidebarThread("t1", { title: "Task" })],
}: {
  snoozes?: Record<
    string,
    { until: number | null; attentionAt: number; at: number }
  >;
  threads?: ReturnType<typeof sidebarThread>[];
} = {}) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const currentSnoozes = { ...snoozes };
  const registration = app.threadHeaderActions.find((a) => a.id === "snooze")!;
  return renderSlot(
    registration,
    { threadId: "t1", projectId: "proj_1", isCompactViewport: false },
    {
      sidebarThreads: { threads },
      rpc: {
        state: () => ({
          ...emptyState(),
          snoozes: { ...currentSnoozes },
          snoozePrefs: { ...DEFAULT_SNOOZE_PREFS, default: "next-week" },
        }),
        snooze: (raw: unknown) => {
          const until = (raw as { until: number | null }).until;
          currentSnoozes.t1 = { until, attentionAt: 0, at: 0 };
          return { snoozes: { t1: currentSnoozes.t1 } };
        },
        unsnooze: () => {
          delete currentSnoozes.t1;
          return { woke: ["t1"] };
        },
      },
    },
  );
}

it("snoozes with the default choice in one click", async () => {
  const slot = await mount();
  fireEvent.click(
    await slot.findByRole("button", { name: /^Snooze until .*9 AM$/ }),
  );
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.some((c) => c.method === "snooze")).toBe(
      true,
    ),
  );
  const { until } = slot.inspection.rpcCalls.find((c) => c.method === "snooze")!
    .input as { until: number };
  const wake = new Date(until);
  expect(wake.getDay()).toBe(1);
  expect(wake.getHours()).toBe(9);
  // The face turns into the snoozed chip at once.
  expect(
    await slot.findByRole("button", { name: /^Snoozed until/ }),
  ).toBeTruthy();
  slot.lifecycle.unmount();
});

it("offers every preset and Custom… from the arrow", async () => {
  const slot = await mount();
  const arrow = await slot.findByRole("button", { name: "Snooze options" });
  fireEvent.pointerDown(arrow, { button: 0, ctrlKey: false });
  // The menu is portalled out of the slot.
  const menu = await screen.findByRole("menu", { name: "Snooze options" });
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual([
    expect.stringMatching(/^1 hour/),
    expect.stringMatching(/^Tomorrow morning/),
    expect.stringMatching(/^Next week\(default\)/),
    "Until it updates",
    "Custom…",
  ]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Custom…" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("radio", { name: "Date" })).toHaveProperty(
    "checked",
    true,
  );
  fireEvent.click(within(dialog).getByRole("radio", { name: "Duration" }));
  fireEvent.change(within(dialog).getByLabelText("Amount"), {
    target: { value: "20" },
  });
  fireEvent.change(within(dialog).getByLabelText("Unit"), {
    target: { value: "minutes" },
  });
  const before = Date.now();
  fireEvent.click(within(dialog).getByRole("button", { name: "Snooze" }));
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.some((c) => c.method === "snooze")).toBe(
      true,
    ),
  );
  const { until } = slot.inspection.rpcCalls.find((c) => c.method === "snooze")!
    .input as { until: number };
  expect(until - before).toBeGreaterThanOrEqual(20 * 60_000);
  expect(until - before).toBeLessThan(20 * 60_000 + 5_000);
  slot.lifecycle.unmount();
});

it("shows a snoozed thread's wake time and hides for threads not in the sidebar", async () => {
  const slot = await mount({
    snoozes: { t1: { until: null, attentionAt: Date.now() + 1, at: 0 } },
  });
  expect(
    await slot.findByRole("button", { name: /^Snoozed until it updates/ }),
  ).toBeTruthy();
  slot.lifecycle.unmount();
  const hidden = await mount({ threads: [] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(hidden.queryByRole("button")).toBeNull();
  hidden.lifecycle.unmount();
});
