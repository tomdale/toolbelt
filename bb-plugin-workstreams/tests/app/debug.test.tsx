// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, section, sidebarThread } from "./fixtures.ts";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const body = () => within(document.body);

const summary = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  at: Date.now() - 60_000,
  kind: "full-analysis",
  status: "ok",
  label: "Alpha parser",
  model: "google/gemini-3.1-flash-lite",
  durationMs: 3200,
  replayOf: null,
  usage: { input: 900, output: 120, cost: 0.0012 },
  error: null,
  summary: "review · Alpha",
  threads: ["t1"],
  ...overrides,
});
const full = (id: string, overrides: Record<string, unknown> = {}) => ({
  ...summary(id),
  provider: "vercel-ai-gateway",
  thinking: "off",
  system: "Classify supplied data. Return only the requested JSON.",
  prompt: "Return only JSON.\n\nYou describe one agent thread…",
  input: { title: "Alpha parser" },
  response: '{"recap":"Parser fixed.","drift":{"workstream":"Beta"}}',
  reasoning: "**Spotting the drift**\n\nThe latest request is Beta work.",
  stopReason: "stop",
  parsed: { recap: "Parser fixed.", drift: { workstream: "Beta" } },
  outcome: { driftTarget: "Beta" },
  links: [{ kind: "thread", ref: "t1" }],
  replays: [],
  ...overrides,
});

it("opens Activity for debug links and shows debug controls only in Debug mode", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const page = (debug: boolean) =>
    renderSlot(
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
              advanced: { hostId: "", debug },
            },
          }),
          state: () => emptyState(),
          journal: () => ({ entries: [] }),
          traces: () => ({
            traces: [summary("tr1", { status: "invalid", error: "bad JSON" })],
          }),
        } as never,
      },
    );
  const off = page(false);
  expect(off.queryByRole("tab", { name: "Debug" })).toBeNull();
  expect(
    off.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(off.queryByRole("checkbox", { name: "Failures only" })).toBeNull();
  expect(off.queryByRole("button", { name: "Clear traces…" })).toBeNull();
  await off.findByText("No activity yet.");
  expect(off.inspection.rpcCalls.some((call) => call.method === "traces")).toBe(
    false,
  );
  off.unmount();
  const on = page(true);
  expect(on.queryByRole("tab", { name: "Debug" })).toBeNull();
  expect(
    on.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(await on.findByText("Response not usable")).toBeTruthy();
  expect(on.getByRole("checkbox", { name: "Failures only" })).toBeTruthy();
  expect(on.queryByText("No activity yet.")).toBeNull();
});

it("lists model calls in the Activity log in Debug mode", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const now = Date.now();
  const entry = {
    id: "e1",
    at: now - 120_000,
    action: "move",
    source: "user",
    status: "applied",
    rationale: "Moved from Unfiled to Beta",
    threads: [{ id: "t1", name: "Alpha parser" }],
    workstreams: [{ id: "sec_b", name: "Beta" }],
    undo: null,
    undoes: null,
    undoneBy: null,
    detail: null,
    traceIds: [],
  };
  const page = (debug: boolean) =>
    renderSlot(
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
              advanced: { hostId: "", debug },
            },
          }),
          state: () => emptyState(),
          journal: () => ({ entries: [entry] }),
          traces: () => ({
            traces: [
              summary("tr1", {
                at: now - 60_000,
                summary: "review · goal “Alpha parser tabs” · Alpha",
              }),
              summary("tr2", {
                at: now - 180_000,
                kind: "quick-analysis",
                label: "Fix the parser",
                status: "invalid",
                error: "Unexpected token",
              }),
            ],
          }),
        } as never,
      },
    );
  const off = page(false);
  expect(await off.findByText("Moved from Unfiled to Beta")).toBeTruthy();
  expect(off.queryByText("Ready for your review")).toBeNull();
  off.unmount();

  const on = page(true);
  const summaryLine = await on.findByText("Ready for your review");
  // Newest first: the analysis, the move, then the failed routing call.
  const rows = on.getAllByRole("listitem").map((li) => li.textContent ?? "");
  const order = [
    "Alpha parser tabs",
    "Moved from Unfiled",
    "Fix the parser",
  ].map((text) => rows.findIndex((row) => row.includes(text)));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(on.getByText("Unexpected token")).toBeTruthy();
  fireEvent.click(
    within(summaryLine.closest("li")!).getByText("Technical details"),
  );
  expect(
    within(summaryLine.closest("li")!).getByRole("button", {
      name: "Inspect this model call",
    }),
  ).toBeTruthy();

  // "Model calls" in the action filter shows only calls.
  fireEvent.change(on.getByRole("combobox", { name: "Filter by action" }), {
    target: { value: "model-call" },
  });
  await waitFor(() =>
    expect(on.queryByText("Moved from Unfiled to Beta")).toBeNull(),
  );
  expect(on.getByText("Fix the parser")).toBeTruthy();
});
