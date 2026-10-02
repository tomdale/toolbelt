// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(cleanup);

const PREFS = { required: true, corrections: 3, layout: "full" };

async function mount() {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const section = app.settingsSections.find((s) => s.id === "recap")!;
  return renderSlot(
    section,
    {},
    {
      rpc: {
        recapPrefs: () => ({ prefs: PREFS }),
        setRecapPrefs: (input: unknown) => ({
          prefs: { ...PREFS, ...(input as { patch: object }).patch },
        }),
      },
    },
  );
}

it("saves a layout pick immediately", async () => {
  const slot = await mount();
  fireEvent.click(await slot.findByRole("radio", { name: /Compact/ }));
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "setRecapPrefs")?.input,
    ).toEqual({ patch: { layout: "minimal" } }),
  );
});

it("disables reminders when agents don't end turns with a recap", async () => {
  const slot = await mount();
  fireEvent.click(
    await slot.findByRole("switch", { name: "End turns with a recap" }),
  );
  expect(await slot.findByText(/don't get the recap tool/)).toBeTruthy();
  expect(
    slot.getByRole("button", { name: "Increase Reminders per turn" }),
  ).toHaveProperty("disabled", true);
  expect(
    slot.getByRole("button", { name: "Decrease Reminders per turn" }),
  ).toHaveProperty("disabled", true);
});

it("previews the recap card in each state and the chosen layout", async () => {
  const slot = await mount();
  const carousel = await slot.findByRole("region", { name: "Recap preview" });
  const visible = () =>
    Array.from(carousel.querySelectorAll('[aria-roledescription="slide"]'))
      .filter((s) => !s.hasAttribute("aria-hidden"))
      .map((s) => s.textContent);
  expect(visible()).toHaveLength(1);
  expect(visible()[0]).toMatch(/Complete.*Added dark mode/);
  fireEvent.click(slot.getByRole("button", { name: "Next example" }));
  expect(visible()[0]).toMatch(/Ready for Review.*Added dark mode/);
  expect(visible()[0]).toContain("Open Settings → Appearance and choose Dark");
  expect(carousel.querySelectorAll('ul[aria-label="Links"]')).toHaveLength(0);
  fireEvent.click(slot.getByRole("button", { name: "Next example" }));
  expect(visible()[0]).toMatch(/Waiting/);
  expect(visible()[0]).not.toContain("Nothing needed");
  fireEvent.click(slot.getByRole("button", { name: "Next example" }));
  expect(visible()[0]).toMatch(/Complete/);

  fireEvent.click(slot.getByRole("radio", { name: /Compact/ }));
  // Compact lists pending tasks and drops any other task details.
  fireEvent.click(slot.getByRole("button", { name: "Previous example" }));
  await waitFor(() =>
    expect(visible()[0]).not.toMatch(/Theme behavior agreed/),
  );
  expect(visible()[0]).toMatch(
    /Waiting.*theme toggle.*keyboard controls.*2:00/,
  );
  expect(visible()[0]).not.toContain("Adding dark mode");
});
