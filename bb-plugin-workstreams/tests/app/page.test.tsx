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
  rationale: "Moved from Unfiled to Beta",
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
        state: () => ({
          ...emptyState(),
          analysis: {
            a1: {
              recap: "Tests pass; waiting on review.",
              state: "review",
              needsYou: null,
              subject: "Alpha",
              drift: null,
              driftSectionId: null,
              revision: now,
              at: now,
              model: "m",
            },
          },
        }),
        corpus: () => ({
          entities: [
            {
              id: "known",
              name: "Quiet product",
              description: "Retained without current tasks",
              parentId: null,
              aliases: [],
            },
          ],
        }),
        journal: () => ({ entries: [entry] }),
        undo: () => ({ entry: { ...entry, id: "e2", action: "undo" } }),
      },
    },
  );
}

it("opens the Catalog tab and includes products without current workstreams", async () => {
  const slot = await mount();
  fireEvent.click(slot.getByRole("tab", { name: "Catalog" }));
  expect(await slot.findByText("Quiet product")).toBeTruthy();
  expect(
    slot.getByRole("tab", { name: "Catalog" }).getAttribute("aria-selected"),
  ).toBe("true");
});

it("ranks workstreams by needs-you first and lists roots with child thread counts", async () => {
  const slot = await mount();
  const headings = slot
    .getAllByRole("heading", { level: 2 })
    .map((h) => h.textContent);
  expect(headings).toEqual(["Beta", "Alpha"]);
  const alpha = slot.getByRole("region", { name: "Alpha" });
  expect(within(alpha).getByText("Alpha work")).toBeTruthy();
  expect(within(alpha).getByText("+1 child thread")).toBeTruthy();
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
  expect(await slot.findByText("Moved from Unfiled to Beta")).toBeTruthy();
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

it("shows where each thread stopped", async () => {
  const slot = await mount();
  const alpha = slot.getByRole("region", { name: "Alpha" });
  expect(
    await within(alpha).findByText("Tests pass; waiting on review."),
  ).toBeTruthy();
  expect(
    within(alpha).getByRole("img", { name: "Ready for your review" }),
  ).toBeTruthy();
  slot.lifecycle.unmount();
});

it("previews organization in a table without line-item vetoes", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const move = (
    threadId: string,
    fromName: string,
    toName: string,
    extra: Record<string, unknown> = {},
  ) => ({
    threadId,
    title: `Title ${threadId}`,
    from: fromName === "Unfiled" ? null : `sec_${fromName}`,
    fromName,
    to: `sec_${toName}`,
    toName,
    reason: "high confidence",
    accepted: true,
    confidence: "high",
    ...extra,
  });
  const state = {
    status: "preview",
    startedAt: 0,
    updatedAt: 0,
    error: null,
    roots: [
      { id: "t1", title: "Title t1", sectionId: "sec_Alpha" },
      { id: "t2", title: "Title t2", sectionId: "sec_Alpha" },
      { id: "t3", title: "Title t3", sectionId: null },
      { id: "t4", title: "Title t4", sectionId: "sec_Beta" },
      { id: "t5", title: "Title t5", sectionId: null },
    ],
    descriptions: {},
    changes: [],
    preview: {
      workstreams: [
        {
          key: "b",
          sectionId: "sec_Beta",
          name: "Beta",
          description: "The Beta effort",
          aliases: [],
        },
        {
          key: "g",
          sectionId: null,
          name: "Gamma",
          description: "The Gamma effort",
          aliases: [],
        },
      ],
      assignments: [1, 2, 3, 4, 5].map((n) => ({
        threadId: `t${n}`,
        workstream: n <= 2 ? "b" : n <= 4 ? "g" : null,
        reason: "Shared effort",
      })),
      creates: [{ name: "Gamma", description: "The Gamma effort" }],
      renames: [],
      moves: [
        move("t1", "Alpha", "Beta"),
        move("t2", "Alpha", "Beta", { confidence: "medium" }),
        move("t3", "Unfiled", "Gamma", { to: "new:Gamma" }),
        // An evolution move: no assignment confidence.
        (({ confidence: _, ...rest }) => rest)(
          move("t4", "Beta", "Gamma", {
            to: "new:Gamma",
            accepted: false,
            reason: "spin-out (you filed this thread)",
          }),
        ),
      ],
      unsure: [{ threadId: "t5", title: "Title t5" }],
    },
    entryId: null,
    traceIds: [],
  };
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "map" },
    {
      sidebarThreads: {
        status: "ready",
        threads: [],
        sections: [],
        projects: [],
      },
      rpc: {
        state: () => emptyState(),
        bootstrap: () => ({ state, bootstrapped: false }),
      },
    },
  );
  expect(await slot.findByText("The Beta effort")).toBeTruthy();
  expect(slot.getByText("The Gamma effort")).toBeTruthy();
  expect(slot.getByText("Title t5")).toBeTruthy();
  expect(slot.queryByRole("checkbox")).toBeNull();
  expect(slot.getByRole("table")).toBeTruthy();
  expect(
    slot.inspection.rpcCalls.some(
      (c) =>
        c.method === "bootstrap" &&
        (c.input as { action: string }).action === "apply",
    ),
  ).toBe(false);
  fireEvent.click(slot.getByRole("button", { name: "Apply organization" }));
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.find(
        (c) =>
          c.method === "bootstrap" &&
          (c.input as { action: string }).action === "apply",
      )?.input,
    ).toEqual({
      action: "apply",
      runId: 0,
      overrides: [],
    }),
  );
  slot.lifecycle.unmount();
});
