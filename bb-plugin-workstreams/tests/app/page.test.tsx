// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, section, sidebarThread } from "./fixtures.ts";

afterEach(cleanup);

const entry = {
  id: "e1",
  at: Date.now(),
  action: "move",
  source: "user",
  status: "applied",
  rationale: "Moved from Unsorted to Beta",
  threads: [{ id: "loose", name: "Loose task" }],
  workstreams: [{ id: "sec_b", name: "Beta" }],
  undo: {
    kind: "move",
    moves: [{ threadId: "loose", from: null, to: "sec_b" }],
  },
  undoes: null,
  undoneBy: null,
  detail: null,
};

async function mount() {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const now = Date.now();
  return renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      sidebarThreads: {
        status: "ready",
        threads: [
          sidebarThread("a1", {
            sectionId: "sec_a",
            title: "Alpha work",
            latestAttentionAt: now,
          }),
          sidebarThread("a2", { parentThreadId: "a1", title: "Alpha child" }),
          sidebarThread("b1", {
            sectionId: "sec_b",
            title: "Beta question",
            hasPendingInteraction: true,
            latestAttentionAt: now - 3_600_000,
          }),
        ],
        sections: [section("sec_a", "Alpha"), section("sec_b", "Beta")],
        projects: [],
      },
      rpc: {
        state: () => emptyState(),
        journal: () => ({ entries: [entry] }),
        undo: () => ({ entry: { ...entry, id: "e2", action: "undo" } }),
      },
    },
  );
}

it("ranks workstreams by needs-you first and lists roots with delegated counts", async () => {
  const slot = await mount();
  const headings = slot
    .getAllByRole("heading", { level: 2 })
    .map((h) => h.textContent);
  expect(headings).toEqual(["Beta", "Alpha"]);
  const alpha = slot.getByRole("region", { name: "Alpha" });
  expect(within(alpha).getByText("Alpha work")).toBeTruthy();
  expect(within(alpha).getByText("+1 delegated")).toBeTruthy();
  expect(within(alpha).queryByText("Alpha child")).toBeNull();
  fireEvent.click(within(alpha).getByText("Alpha work"));
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "toThread", threadId: "a1" },
  ]);
  slot.lifecycle.unmount();
});

it("filters with search", async () => {
  const slot = await mount();
  fireEvent.change(
    slot.getByRole("textbox", { name: "Search threads and workstreams" }),
    {
      target: { value: "question" },
    },
  );
  expect(
    slot.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
  ).toEqual(["Beta"]);
  slot.lifecycle.unmount();
});

it("shows the activity log with undo", async () => {
  const slot = await mount();
  fireEvent.click(slot.getByRole("tab", { name: "Activity" }));
  expect(await slot.findByText("Moved from Unsorted to Beta")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "undo")?.input,
    ).toEqual({
      entryId: "e1",
    }),
  );
  slot.lifecycle.unmount();
});
