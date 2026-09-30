// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(cleanup);

const PREFS = {
  automatic: true,
  layout: "detailed",
  quietSeconds: 30,
  minTurns: 3,
};

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
    ).toEqual({ patch: { layout: "compact" } }),
  );
});

it("describes Generate Recap when automatic recaps are turned off", async () => {
  const slot = await mount();
  fireEvent.click(
    await slot.findByRole("checkbox", { name: "Automatic recaps" }),
  );
  expect(await slot.findByText(/Generate Recap button appears/)).toBeTruthy();
  expect(
    slot.getByRole("textbox", { name: "Quiet period in seconds" }),
  ).toHaveProperty("disabled", true);
});
