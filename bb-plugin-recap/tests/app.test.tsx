// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const pending = vi.hoisted(() => ({ threadId: null as string | null }));
vi.mock("@get-bb/plugin-sdk/app", async (importActual) => {
  const actual = await importActual<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    experimental_useSidebarThreads: () => ({
      threads: [{ id: pending.threadId, hasPendingInteraction: true }],
    }),
  };
});

afterEach(() => {
  pending.threadId = null;
  cleanup();
  vi.restoreAllMocks();
});

const SUMMARY = "Goal: Building the card\nNeeds input: Pick A or B\nOpen: Write docs";
const recap = { id: "recap-1", summary: SUMMARY, automatic: false };

async function mount(options: {
  automatic?: boolean;
  recap?: typeof recap | null;
  generate?: () => Promise<unknown>;
} = {}) {
  const app = await loadPluginApp(() => import("../src/app.tsx"));
  const banner = app.composerCustomizations.find((entry) => entry.id === "recap-banner")!
    .banners![0]!;
  const slot = renderSlot(banner, {}, {
    composer: { scope: { kind: "thread", threadId: "t1" } },
    rpc: {
      recap_settings_get: () => ({ auto: options.automatic ?? true, layout: "detailed" }),
      recap_get: () => ({ recap: options.recap === undefined ? recap : options.recap, generating: false }),
      recap_generate: options.generate ?? (() => Promise.resolve({ recap, reason: null })),
    },
  });
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.some((call) => call.method === "recap_get")).toBe(true),
  );
  return slot;
}

it("renders a textual unanswered question without a live interaction", async () => {
  const slot = await mount();
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("Needs input");
  expect(region.textContent).toContain("Pick A or B");
});

it("suppresses the recap during a pending interaction even while idle", async () => {
  pending.threadId = "t1";
  const slot = await mount();
  expect(slot.queryByRole("region", { name: "Latest recap" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Generate Recap" })).toBeNull();
});

it("does not suppress the recap for another thread's interaction", async () => {
  pending.threadId = "other";
  const slot = await mount();
  expect(await slot.findByRole("region", { name: "Latest recap" })).toBeTruthy();
});

it("restores the same recap after input clears without dismissing it", async () => {
  const slot = await mount();
  await slot.findByRole("region", { name: "Latest recap" });
  pending.threadId = "t1";
  await slot.setComposerText("Draft retained during input");
  expect(slot.queryByRole("region", { name: "Latest recap" })).toBeNull();
  pending.threadId = null;
  await slot.setComposerText("Draft retained after input");
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("Pick A or B");
});

it("suppresses the on-demand action until pending input clears", async () => {
  pending.threadId = "t1";
  const slot = await mount({ automatic: false, recap: null });
  expect(slot.queryByRole("button", { name: "Generate Recap" })).toBeNull();
  pending.threadId = null;
  await slot.setComposerText("Draft");
  expect(await slot.findByRole("button", { name: "Generate Recap" })).toBeTruthy();
});

it("suppresses an in-flight placeholder and restores its result", async () => {
  let finish!: (value: unknown) => void;
  const options = {
    automatic: false,
    recap: null as typeof recap | null,
    generate: () => new Promise<unknown>((resolve) => { finish = resolve; }),
  };
  const slot = await mount(options);
  fireEvent.click(await slot.findByRole("button", { name: "Generate Recap" }));
  await slot.findByRole("status", { name: "Generating recap" });
  pending.threadId = "t1";
  await slot.setComposerText("Draft");
  expect(slot.queryByRole("status", { name: "Generating recap" })).toBeNull();
  options.recap = recap;
  finish({ recap, reason: null });
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "recap_get").length).toBeGreaterThan(1),
  );
  expect(slot.queryByRole("region", { name: "Latest recap" })).toBeNull();
  pending.threadId = null;
  await slot.setComposerText("Draft after input");
  expect(await slot.findByRole("region", { name: "Latest recap" })).toBeTruthy();
});
