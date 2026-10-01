// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState } from "./fixtures.ts";

afterEach(cleanup);

const trace = (id: string, overrides = {}) => ({
  id,
  at: 1000,
  kind: "analysis",
  status: "ok",
  label: id,
  model: "test/model",
  durationMs: 1200,
  replayOf: null,
  usage: { input: 100, output: 20, cost: 0.01 },
  error: null,
  summary: "No change needed",
  threads: [],
  ...overrides,
});
const entry = {
  id: "e1",
  at: 900,
  action: "move",
  source: "user",
  status: "applied",
  rationale: "Moved a thread",
  threads: [{ id: "missing-thread", name: "Parser thread" }],
  workstreams: [],
  undo: null,
  undoes: null,
  undoneBy: null,
  detail: null,
  traceIds: [],
};
async function page(rpc: Record<string, unknown>) {
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
        journal: () => ({ entries: [entry] }),
        ...rpc,
      } as never,
    },
  );
}

it("filters internal calls, exposes metadata and event internals, and opens the full inspector", async () => {
  const traces = [
    trace("ok"),
    trace("bad", { kind: "route", status: "failed", error: "Offline" }),
    trace("replay", { replayOf: "ok" }),
  ];
  const slot = await page({
    traces: ({ ids, kind }: { ids?: string[]; kind?: string }) => ({
      traces: traces.filter(
        (t) => (!ids || ids.includes(t.id)) && (!kind || t.kind === kind),
      ),
    }),
    trace: ({ id }: { id: string }) => ({
      trace: {
        ...traces.find((t) => t.id === id),
        id,
        provider: "test",
        thinking: "off",
        system: "Classify",
        prompt: "Exact prompt",
        input: {},
        response: "{}",
        reasoning: null,
        stopReason: "stop",
        parsed: {},
        outcome: {},
        links: [],
        replays: [],
      },
    }),
  });
  expect(await slot.findByText("3 model calls shown · $0.0300")).toBeTruthy();
  expect(
    slot.getByRole("link", { name: "Parser thread" }).getAttribute("href"),
  ).toBe("/threads/missing-thread");
  expect(slot.queryByText(/Internal ·/)).toBeNull();
  expect(slot.getByText("Replay")).toBeTruthy();
  expect(
    slot
      .getAllByText("Technical details")
      .every((node) => !node.closest("details")!.open),
  ).toBe(true);
  const entryRow = slot.getByText("Moved a thread").closest("li")!;
  fireEvent.click(within(entryRow).getByText("Technical details"));
  expect(within(entryRow).getByText("Event ID")).toBeTruthy();
  expect(within(entryRow).getByText("e1")).toBeTruthy();
  const callRow = slot.getByText("ok").closest("li")!;
  fireEvent.click(within(callRow).getByText("Technical details"));
  expect(within(callRow).getByText("Model", { selector: "dt" })).toBeTruthy();
  expect(within(callRow).getByText("Duration")).toBeTruthy();
  expect(within(callRow).getByText("Input tokens")).toBeTruthy();
  expect(within(callRow).getByText("Output tokens")).toBeTruthy();
  fireEvent.click(
    within(callRow).getByRole("button", { name: "Inspect this model call" }),
  );
  const pane = await within(document.body).findByRole("dialog");
  expect(await within(pane).findByLabelText("Prompt")).toHaveProperty(
    "textContent",
    "Exact prompt",
  );
  fireEvent.click(within(pane).getByRole("button", { name: "Close" }));
  fireEvent.click(slot.getByRole("checkbox", { name: "Failures only" }));
  expect(slot.queryByText("Moved a thread")).toBeNull();
  expect(slot.queryByText("ok")).toBeNull();
  expect(slot.getByText("bad")).toBeTruthy();
  expect(slot.getByText("1 model calls shown · $0.0100")).toBeTruthy();
  fireEvent.change(
    slot.getByRole("combobox", { name: "Filter by model call kind" }),
    { target: { value: "route" } },
  );
  expect(await slot.findByText("bad")).toBeTruthy();
  fireEvent.change(slot.getByRole("combobox", { name: "Filter by action" }), {
    target: { value: "move" },
  });
  expect(await slot.findByText("Moved a thread")).toBeTruthy();
  expect(slot.queryByText("bad")).toBeNull();
  fireEvent.change(slot.getByRole("combobox", { name: "Filter by action" }), {
    target: { value: "model-call" },
  });
  fireEvent.click(slot.getByRole("checkbox", { name: "Needs review" }));
  expect(
    slot.getByRole("combobox", { name: "Filter by action" }),
  ).toHaveProperty("value", "");
  expect(slot.queryByText("bad")).toBeNull();
  fireEvent.change(slot.getByRole("combobox", { name: "Filter by action" }), {
    target: { value: "model-call" },
  });
  expect(slot.getByText("bad")).toBeTruthy();
});

it("loads older calls with a stable cursor and refreshes loaded history without duplicates", async () => {
  const first = Array.from({ length: 100 }, (_, i) => trace(`call-${i}`));
  const traces = vi.fn(
    ({ before }: { before?: { at: number; id: string } }) => ({
      traces: before ? [trace("older")] : first,
    }),
  );
  const slot = await page({ traces });
  fireEvent.click(
    await slot.findByRole("button", { name: "Load older model calls" }),
  );
  expect(await slot.findByText("older")).toBeTruthy();
  expect(traces).toHaveBeenCalledWith({
    limit: 100,
    before: { at: 1000, id: "call-99" },
  });
  expect(
    slot.queryByRole("button", { name: "Load older model calls" }),
  ).toBeNull();
  await slot.behavior.emitRealtime("changed", {});
  await waitFor(() => expect(traces).toHaveBeenCalledTimes(5));
  expect(slot.getAllByRole("listitem")).toHaveLength(102);
  expect(slot.getByText("101 model calls shown · $1.0100")).toBeTruthy();
});

it("ignores a stale trace request after changing the kind filter", async () => {
  let resolveFirst!: (value: unknown) => void;
  const traces = vi.fn(({ kind }: { kind?: string }) =>
    kind
      ? { traces: [trace("route-current", { kind: "route" })] }
      : new Promise((resolve) => {
          resolveFirst = resolve;
        }),
  );
  const slot = await page({ traces });
  await waitFor(() => expect(traces).toHaveBeenCalledTimes(1));
  fireEvent.change(
    slot.getByRole("combobox", { name: "Filter by model call kind" }),
    { target: { value: "route" } },
  );
  await slot.findByText("route-current");
  await act(async () =>
    resolveFirst({ traces: [trace("route-stale", { kind: "route" })] }),
  );
  expect(slot.getByText("route-current")).toBeTruthy();
  expect(slot.queryByText("route-stale")).toBeNull();
});

it("keeps traces and reports a failed clear without losing journal entries", async () => {
  const slot = await page({
    traces: () => ({ traces: [trace("kept")] }),
    traceClear: () => {
      throw new Error("Clear failed");
    },
  });
  await slot.findByText("kept");
  fireEvent.click(slot.getByRole("button", { name: "Clear traces…" }));
  fireEvent.click(slot.getByRole("button", { name: "Delete traces" }));
  expect((await slot.findByRole("alert")).textContent).toBe("Clear failed");
  expect(slot.getByText("kept")).toBeTruthy();
  expect(slot.getByText("Moved a thread")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Delete traces" })).toHaveProperty(
    "disabled",
    false,
  );
});

it("confirms clearing all traces without deleting Activity changes", async () => {
  let stored = [trace("ok")];
  const traceClear = vi.fn(() => {
    stored = [];
    return { removed: 1 };
  });
  const slot = await page({ traces: () => ({ traces: stored }), traceClear });
  await slot.findByText("ok");
  fireEvent.click(slot.getByRole("button", { name: "Clear traces…" }));
  expect(traceClear).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  expect(slot.getByText("ok")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Clear traces…" }));
  fireEvent.click(slot.getByRole("button", { name: "Delete traces" }));
  await waitFor(() => expect(slot.queryByText("ok")).toBeNull());
  expect(traceClear).toHaveBeenCalledWith(null);
  expect(slot.getByText("Moved a thread")).toBeTruthy();
  expect(slot.getByText("0 model calls shown · $0.0000")).toBeTruthy();
});
