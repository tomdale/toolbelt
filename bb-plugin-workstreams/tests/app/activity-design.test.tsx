// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState } from "./fixtures.ts";
beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function page(summary: string | null, overrides = {}) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  return renderSlot(
    app.navPanels[0]!,
    { subPath: "debug" },
    {
      settings: {},
      rpc: {
        prefs: () => ({
          prefs: {
            sidebar: { showForYou: true, showRecent: true, recentLimit: 5 },
            threads: { autoTitle: true, showParentLink: false },
            newWork: { homeProjectId: "", suggestions: true },
            analysis: {
              quickModel: { kind: "gateway", model: "m" },
              fullModel: { kind: "gateway", model: "m" },
            },
            organize: {},
            advanced: { hostId: "", debug: true },
          },
        }),
        state: () => emptyState(),
        journal: () => ({ entries: [] }),
        traces: () => ({
          traces: [
            {
              id: "t",
              at: 1000,
              kind: "full-analysis",
              status: "ok",
              label: "Fix parser",
              model: "test/model",
              durationMs: 1200,
              replayOf: null,
              usage: null,
              error: null,
              summary,
              threads: [],
              ...overrides,
            },
          ],
        }),
      } as never,
    },
  );
}

it("labels status and topic, explains review on focus, and hides metrics by default", async () => {
  const slot = await page("review · goal “Fix parser tabs” · BB");
  const row = (await slot.findByText("Fix parser", { exact: true })).closest(
    "li",
  )!;
  expect(within(row).getByText("Work status:")).toBeTruthy();
  expect(within(row).getByText("Topic:").parentElement!.textContent).toBe(
    "Topic: BB",
  );
  expect(within(row).getByText("Title:").parentElement!.textContent).toBe(
    "Title: “Fix parser tabs”",
  );
  expect(
    within(row).getByText("Technical details").closest("details")!.open,
  ).toBe(false);
  fireEvent.focus(
    within(row).getByRole("button", { name: "About Ready for your review" }),
  );
  const tooltip = await within(document.body).findByRole("tooltip");
  expect(tooltip.textContent).toBe(
    "A deliverable is ready for you to review, test, merge, or ship.",
  );
  fireEvent.blur(
    within(row).getByRole("button", { name: "About Ready for your review" }),
  );
  fireEvent.click(within(row).getByText("Technical details"));
  expect(within(row).getAllByText("Not reported")).toHaveLength(3);
  expect(within(row).getByText("Duration")).toBeTruthy();
});

it("labels a turn the agent reported itself", async () => {
  const slot = await page("reported · goal “Parser complete”");
  await slot.findByText("Reported by the agent");
  expect(slot.queryByText("Topic:")).toBeNull();
});

it("shows what Quick analysis named a new thread", async () => {
  const slot = await page("goal “Fix stale build cache” · Lumen", {
    kind: "quick-analysis",
    label: "Fix the stale build cache in the monorepo",
  });
  const row = (
    await slot.findByText("Fix the stale build cache in the monorepo")
  ).closest("li")!;
  expect(within(row).getByText("Quick analysis")).toBeTruthy();
  expect(within(row).getByText("Model result:")).toBeTruthy();
  expect(within(row).getByText(/Title: “Fix stale build cache”/)).toBeTruthy();
});

it("preserves unknown summary formats as labeled model results", async () => {
  const slot = await page("A future summary format");
  expect(await slot.findByText("A future summary format")).toBeTruthy();
  expect(slot.getByText("Model result:")).toBeTruthy();
  expect(slot.queryByText("Work status:")).toBeNull();
});

it("keeps failed calls and their errors visible outside technical details", async () => {
  const slot = await page(null, {
    status: "failed",
    error: "Model unavailable",
  });
  const error = await slot.findByText("Model unavailable");
  expect(error.closest("details")).toBeNull();
  expect(slot.getByText("Model call failed")).toBeTruthy();
});
