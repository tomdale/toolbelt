// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, section, sidebarThread } from "./fixtures.ts";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const body = () => within(document.body);

const summary = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  at: Date.now() - 60_000,
  kind: "analysis",
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

async function header(
  settings: Record<string, boolean>,
  rpc: Record<string, (input: never) => unknown> = {},
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const slot = app.threadHeaderActions.find((a) => a.id === "debug")!;
  return renderSlot(
    slot,
    { threadId: "t1", projectId: "proj_1", isCompactViewport: false },
    {
      settings,
      rpc: {
        state: () => emptyState(),
        traces: () => ({
          traces: [
            summary("tr1"),
            summary("tr2", { kind: "route", label: "Fix the parser" }),
          ],
        }),
        trace: ({ id }: { id: string }) => ({ trace: full(id) }),
        ...rpc,
      } as never,
    },
  );
}

it("shows no inspect button while Debug mode is off", async () => {
  const slot = await header({ debug: false });
  expect(
    slot.queryByRole("button", { name: /Inspect Workstreams model calls/ }),
  ).toBeNull();
});

it("opens the thread's model calls with reasoning, result, and prompt", async () => {
  const traces = vi.fn((input: unknown) => {
    expect(input).toEqual({ link: { kind: "thread", ref: "t1" }, limit: 200 });
    return {
      traces: [
        summary("tr1"),
        summary("tr2", { kind: "route", label: "Fix the parser" }),
      ],
    };
  });
  const slot = await header({ debug: true }, { traces });
  fireEvent.click(
    await slot.findByRole("button", {
      name: "Inspect Workstreams model calls for this thread",
    }),
  );
  const pane = await body().findByRole("dialog", {
    name: "Model calls for this thread",
  });
  expect(
    within(pane).getByText("2 model calls recorded in Debug mode"),
  ).toBeTruthy();
  const list = within(pane).getByRole("navigation", { name: "Model calls" });
  expect(within(list).getAllByRole("button")).toHaveLength(2);
  expect(
    await within(pane).findByText("The latest request is Beta work."),
  ).toBeTruthy();
  expect(within(pane).getByText("Spotting the drift").tagName).toBe("STRONG");
  expect(within(pane).getByText("Result")).toBeTruthy();
  expect(within(pane).getByText("What Workstreams did")).toBeTruthy();
  expect(within(pane).getByLabelText("Prompt").textContent).toContain(
    "You describe one agent thread",
  );

  // Selecting the second call shows it.
  fireEvent.click(within(list).getByText("Fix the parser"));
  await waitFor(() =>
    expect(
      within(pane).getByRole("article", { name: "Thread analysis" }),
    ).toBeTruthy(),
  );
});

it("runs a call again and lists the replay under it", async () => {
  let replays: unknown[] = [];
  const traceReplay = vi.fn(() => {
    replays = [summary("rp1", { replayOf: "tr1" })];
    return { trace: full("rp1", { replayOf: "tr1" }) };
  });
  const slot = await header(
    { debug: true },
    {
      traces: () => ({ traces: [summary("tr1")] }),
      trace: ({ id }: { id: string }) => ({
        trace:
          id === "rp1"
            ? full("rp1", {
                replayOf: "tr1",
                parsed: { recap: "Parser fixed.", drift: null },
              })
            : full(id, { replays }),
      }),
      traceReplay,
    },
  );
  fireEvent.click(
    await slot.findByRole("button", {
      name: "Inspect Workstreams model calls for this thread",
    }),
  );
  const pane = await body().findByRole("dialog");
  fireEvent.click(
    await within(pane).findByRole("button", { name: /Run again/ }),
  );
  await waitFor(() => expect(traceReplay).toHaveBeenCalledWith({ id: "tr1" }));
  expect(await within(pane).findByText("Differs in drift")).toBeTruthy();
});

it("adds an inspect button to the drift banner", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const slot = app.threadHeaderActions.find(
    (a) => a.id === "workstream-proposal",
  )!;
  const now = Date.now();
  renderSlot(
    slot,
    { threadId: "t1", projectId: "proj_1", isCompactViewport: false },
    {
      settings: { debug: true },
      sidebarThreads: {
        status: "ready",
        threads: [
          sidebarThread("t1", { sectionId: "sec_a", latestAttentionAt: now }),
        ],
        sections: [section("sec_a", "Alpha"), section("sec_b", "Beta")],
        projects: [],
      },
      rpc: {
        state: () => ({
          ...emptyState(),
          driftDismissed: {},
          analysis: {
            t1: {
              recap: "r",
              state: "done",
              needsYou: null,
              subject: "Beta",
              title: null,
              drift: { workstream: "Beta", newName: null, confidence: "high" },
              driftSectionId: "sec_b",
              revision: now,
              at: now,
              model: "m",
              traceId: "tr1",
            },
          },
        }),
        traces: ({ ids }: { ids: string[] }) => ({
          traces: ids.map((id) => summary(id)),
        }),
        trace: ({ id }: { id: string }) => ({ trace: full(id) }),
      } as never,
    },
  );
  const banner = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      "[data-workstreams-banner]",
    );
    if (!found) throw new Error("no banner");
    return found;
  });
  fireEvent.click(
    within(banner).getByRole("button", {
      name: "Inspect the model call behind this",
    }),
  );
  expect(
    await body().findByRole("dialog", {
      name: "Why this looks like Beta work",
    }),
  ).toBeTruthy();
});

it("opens Activity for debug links and shows debug controls only in Debug mode", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const page = (debug: boolean) =>
    renderSlot(
      app.navPanels[0]!,
      { subPath: "debug" },
      {
        settings: { debug },
        rpc: {
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
    rationale: "Moved from Unsorted to Beta",
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
      { subPath: "activity" },
      {
        settings: { debug },
        rpc: {
          state: () => emptyState(),
          journal: () => ({ entries: [entry] }),
          traces: () => ({
            traces: [
              summary("tr1", {
                at: now - 60_000,
                summary: "review · Alpha · drift → Beta (high)",
              }),
              summary("tr2", {
                at: now - 180_000,
                kind: "route",
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
  expect(await off.findByText("Moved from Unsorted to Beta")).toBeTruthy();
  expect(off.queryByText("review · Alpha · drift → Beta (high)")).toBeNull();
  off.unmount();

  const on = page(true);
  const summaryLine = await on.findByText("Ready for your review");
  // Newest first: the analysis, the move, then the failed routing call.
  const rows = on.getAllByRole("listitem").map((li) => li.textContent ?? "");
  const order = [
    "Different workstream: Beta",
    "Moved from Unsorted",
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
    expect(on.queryByText("Moved from Unsorted to Beta")).toBeNull(),
  );
  expect(on.getByText("Fix the parser")).toBeTruthy();
});
