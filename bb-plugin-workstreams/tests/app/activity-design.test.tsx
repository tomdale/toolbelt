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
            threads: {
              autoTitle: true,
              analysisModel: { kind: "gateway", model: "m" },
              showParentLink: false,
            },
            newWork: {
              homeProjectId: "",
              suggestions: true,
              suggestionsModel: { kind: "gateway", model: "m" },
            },
            organize: { model: { kind: "gateway", model: "m" } },
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
              kind: "analysis",
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

it("labels lifecycle and subject, explains review on focus, and hides metrics by default", async () => {
  const slot = await page(
    "review · BB · drift → Workstreams (high) · new title “Fix parser”",
  );
  const row = (await slot.findByText("Fix parser", { exact: true })).closest(
    "li",
  )!;
  expect(within(row).getByText("Work status:")).toBeTruthy();
  expect(within(row).getByText("Subject:")).toBeTruthy();
  expect(within(row).queryByText("Workstream:")).toBeNull();
  expect(
    within(row).getByText(/Different workstream: Workstreams/),
  ).toBeTruthy();
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

it("does not mistake a title an earlier analysis suggested for a subject", async () => {
  const slot = await page("done · new title “Parser complete”");
  await slot.findByText("Done");
  expect(slot.queryByText("Subject:")).toBeNull();
  expect(slot.getByText("Title: “Parser complete”")).toBeTruthy();
});

it("shows the goal an analysis inferred as the title it suggests", async () => {
  const slot = await page("done · Lumen · goal “Fix stale build cache”");
  await slot.findByText("Done");
  expect(slot.getByText("Subject:").parentElement!.textContent).toBe(
    "Subject: Lumen",
  );
  expect(slot.getByText("Title: “Fix stale build cache”")).toBeTruthy();
});

it("shows what the opening-request call named a thread", async () => {
  const slot = await page("goal “Fix stale build cache”", {
    kind: "opening-goal",
    label: "Fix the stale build cache in the monorepo",
  });
  const row = (
    await slot.findByText("Fix the stale build cache in the monorepo")
  ).closest("li")!;
  expect(within(row).getByText("Opening title")).toBeTruthy();
  expect(within(row).getByText("Model result:")).toBeTruthy();
  expect(within(row).getByText(/Title: “Fix stale build cache”/)).toBeTruthy();
  const none = await page("no goal: the request doesn’t say", {
    kind: "opening-goal",
    label: "hi",
  });
  expect(
    await none.findByText("no goal: the request doesn’t say"),
  ).toBeTruthy();
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
