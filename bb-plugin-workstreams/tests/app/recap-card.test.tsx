// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState } from "./fixtures.ts";

afterEach(cleanup);

const SUMMARY =
  "Goal: Building the card.\nLatest: Card renders\nOpen: Add layouts\nDone: Ported styles";

async function mount(options: {
  settings?: Record<string, string | boolean>;
  recap?: string | null;
  needsInput?: string | null;
  generate?: () => unknown;
}) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const banner = app.composerCustomizations.find((c) => c.id === "recap")!.banners![0]!;
  const recap =
    options.recap === null
      ? null
      : { threadId: "t1", summary: options.recap ?? SUMMARY, generatedAt: 1, turns: 3, model: "m" };
  return renderSlot(banner, {}, {
    composer: { scope: { kind: "thread", threadId: "t1" } },
    settings: options.settings ?? {},
    rpc: {
      state: () => emptyState(),
      archiveStatus: () => ({ revision: null }),
      recap_get: () => ({ recap, generating: false, needsInput: options.needsInput ?? null }),
      recap_generate: options.generate ?? (() => ({ recap, generated: true, reason: null })),
    },
  });
}

it("renders the detailed layout by default", async () => {
  const slot = await mount({});
  const region = await slot.findByRole("region", { name: "Latest recap" });
  for (const text of ["Building the card.", "Card renders", "Add layouts", "Ported styles"])
    expect(region.textContent).toContain(text);
});

it("drops Open and Done in the compact layout, and the goal in minimal", async () => {
  const compact = await mount({ settings: { recapLayout: "compact" } });
  const region = await compact.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("Building the card.");
  expect(region.textContent).not.toContain("Add layouts");
  compact.lifecycle.unmount();
  const minimal = await mount({ settings: { recapLayout: "minimal" } });
  const small = await minimal.findByRole("region", { name: "Latest recap" });
  expect(small.textContent).not.toContain("Building the card.");
  expect(small.textContent).toContain("Card renders");
});

it("shows what the thread needs from the user", async () => {
  const slot = await mount({ needsInput: "Pick A or B" });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("For you");
  expect(region.textContent).toContain("Pick A or B");
});

it("offers Generate Recap when automatic recaps are off", async () => {
  const slot = await mount({ settings: { recapAutomatic: false }, recap: null });
  fireEvent.click(await slot.findByRole("button", { name: "Generate Recap" }));
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.some((c) => c.method === "recap_generate")).toBe(true),
  );
});

it("drops an Open item that repeats the For you ask", async () => {
  const slot = await mount({
    recap: "Goal: Building.\nLatest: Done a thing\nOpen: Pick A or B?\nOpen: Write docs",
    needsInput: "Pick A or B?",
  });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent?.match(/Pick A or B\?/g)).toHaveLength(1);
  expect(region.textContent).toContain("Write docs");
});
