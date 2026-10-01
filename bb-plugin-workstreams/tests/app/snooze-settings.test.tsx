// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState } from "./fixtures.ts";

afterEach(cleanup);

async function mount(snoozePrefs: Record<string, unknown> = {}) {
  let prefs = {
    default: "tomorrow",
    quick: ["1h", "tomorrow", "next-week", "activity"],
    morningHour: 9,
    ...snoozePrefs,
  };
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const section = app.settingsSections.find((s) => s.id === "snooze")!;
  return renderSlot(
    section,
    {},
    {
      rpc: {
        state: () => ({ ...emptyState(), snoozes: {}, snoozePrefs: prefs }),
        setSnoozePrefs: (input: unknown) => {
          prefs = { ...prefs, ...(input as { patch: object }).patch };
          return { prefs };
        },
      },
    },
  );
}

const lastPatch = (slot: Awaited<ReturnType<typeof mount>>) =>
  slot.inspection.rpcCalls.filter((c) => c.method === "setSnoozePrefs").at(-1)
    ?.input;

it("saves the click-to-snooze choice and the morning hour", async () => {
  const slot = await mount();
  const select = await slot.findByRole("button", { name: "Click to snooze" });
  fireEvent.click(select);
  fireEvent.click(await slot.findByRole("option", { name: "3 hours" }));
  await waitFor(() =>
    expect(lastPatch(slot)).toEqual({ patch: { default: "3h" } }),
  );
  fireEvent.click(slot.getByRole("button", { name: "Mornings start at" }));
  fireEvent.click(await slot.findByRole("option", { name: "7 AM" }));
  await waitFor(() =>
    expect(lastPatch(slot)).toEqual({ patch: { morningHour: 7 } }),
  );
});

it("picks up to four hover-menu choices, in menu order", async () => {
  const slot = await mount({ quick: ["1h", "tomorrow", "activity"] });
  const box = async (name: RegExp) =>
    slot.getByRole("checkbox", { name }) as HTMLButtonElement;
  await waitFor(async () =>
    expect((await box(/^1 hour/)).getAttribute("aria-checked")).toBe("true"),
  );
  expect((await box(/^1 hour/)).className).not.toContain("bg-accent/30");
  expect((await box(/^30 minutes/)).className).toContain("hover:bg-accent/50");
  fireEvent.click(await box(/^30 minutes/));
  await waitFor(() =>
    expect(lastPatch(slot)).toEqual({
      patch: { quick: ["1h", "tomorrow", "activity", "30m"] },
    }),
  );
  // Four chosen: the rest can't be added until one is removed.
  await waitFor(async () =>
    expect((await box(/^3 hours/)).getAttribute("aria-disabled")).toBe("true"),
  );
  fireEvent.click(await box(/^1 hour/));
  await waitFor(() =>
    expect(lastPatch(slot)).toEqual({
      // Stored in menu order, so 30 minutes now leads.
      patch: { quick: ["30m", "tomorrow", "activity"] },
    }),
  );
  await waitFor(async () =>
    expect((await box(/^3 hours/)).getAttribute("aria-disabled")).toBe("false"),
  );
});
