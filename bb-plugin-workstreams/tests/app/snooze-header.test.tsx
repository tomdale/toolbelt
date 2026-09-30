// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, sidebarThread } from "./fixtures.ts";

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
  const registration = app.threadHeaderActions.find((a) => a.id === "snooze")!;
  return renderSlot(
    registration,
    { threadId: "t1", projectId: "proj_1", isCompactViewport: false },
    {
      settings: { snoozeDefault: "Next week" },
      sidebarThreads: { threads },
      rpc: {
        state: () => ({ ...emptyState(), snoozes }),
        snooze: (raw: unknown) => ({
          snooze: {
            until: (raw as { until: number | null }).until,
            attentionAt: 0,
            at: 0,
          },
        }),
        unsnooze: () => ({ woke: true }),
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

it("offers every choice from the arrow", async () => {
  const slot = await mount();
  const arrow = await slot.findByRole("button", { name: "Snooze options" });
  fireEvent.pointerDown(arrow, { button: 0, ctrlKey: false });
  // The menu is portalled out of the slot.
  const menu = await screen.findByRole("menu", { name: "Snooze options" });
  for (const label of [
    "1 hour",
    "3 hours",
    "Tomorrow morning",
    "Next week",
    "Until it updates",
    "Pick a date and time…",
  ])
    expect(menu.textContent).toContain(label);
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
