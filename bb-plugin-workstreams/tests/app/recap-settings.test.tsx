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
  fireEvent.click(await slot.findByRole("radio", { name: /Minimal/ }));
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "setRecapPrefs")?.input,
    ).toEqual({ patch: { layout: "minimal" } }),
  );
});

it("disables reminders when agents don't end turns with a recap", async () => {
  const slot = await mount();
  fireEvent.click(
    await slot.findByRole("checkbox", { name: "End turns with a recap" }),
  );
  expect(await slot.findByText(/don't get the recap tool/)).toBeTruthy();
  expect(
    slot.getByRole("textbox", { name: "Reminders per turn" }),
  ).toHaveProperty("disabled", true);
});
