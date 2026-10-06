// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(cleanup);

async function mount(debug: boolean) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  return renderSlot(
    app.threadHeaderActions.find((action) => action.id === "observed-names")!,
    { threadId: "t1", projectId: "proj_1", isCompactViewport: false },
    {
      rpc: {
        prefs: () => ({ prefs: { advanced: { debug } } }),
        observedNames: () => ({
          products: [{ name: "Lumen", firstSeenAt: 1, lastSeenAt: 2, runs: 3 }],
          features: [
            {
              name: "Cache",
              product: "Lumen",
              firstSeenAt: 1,
              lastSeenAt: 2,
              runs: 2,
            },
            {
              name: "Export",
              product: null,
              firstSeenAt: 2,
              lastSeenAt: 2,
              runs: 1,
            },
          ],
        }),
      } as never,
    },
  );
}

it("shows a thread's accumulated products and associated or unknown features in Debug mode", async () => {
  const slot = await mount(true);
  fireEvent.click(
    await slot.findByRole("button", {
      name: "Observed product and feature names",
    }),
  );
  expect(await slot.findByText("Products and features observed")).toBeTruthy();
  expect(await slot.findByText("Cache")).toBeTruthy();
  expect(slot.getByText(/Unknown product/)).toBeTruthy();
  expect(slot.getByText(/3 runs/)).toBeTruthy();
  expect(
    slot.inspection.rpcCalls.find((call) => call.method === "observedNames")
      ?.input,
  ).toEqual({ threadId: "t1" });
});

it("does not expose the action or fetch observations outside Debug mode", async () => {
  const slot = await mount(false);
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "prefs"),
    ).toBe(true),
  );
  expect(
    slot.queryByRole("button", { name: "Observed product and feature names" }),
  ).toBeNull();
  expect(
    slot.inspection.rpcCalls.some((call) => call.method === "observedNames"),
  ).toBe(false);
});
