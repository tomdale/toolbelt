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
        catalog: () => ({
          entities: [
            {
              id: "known",
              name: "Quiet product",
              description: "Retained without current tasks",
              parentId: null,
              aliases: [],
            },
          ],
          groups: {},
          assignments: {},
          revision: 1,
        }),
        journal: () => ({ entries: [entry] }),
        undo: () => ({ entry: { ...entry, id: "e2", action: "undo" } }),
      },
    },
  );
}

it("opens the Topics tab and lists every topic", async () => {
  const slot = await mount();
  fireEvent.click(slot.getByRole("tab", { name: "Topics" }));
  expect(await slot.findByText("Quiet product")).toBeTruthy();
  expect(
    slot.getByRole("tab", { name: "Topics" }).getAttribute("aria-selected"),
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

it("renders live organization view with derived workstreams on the Organize tab", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const orgState = {
    status: "idle" as const,
    progress: null,
    error: null,
    lastUpdatedAt: 1,
    groups: [
      {
        key: "sec_Beta",
        sectionId: "sec_Beta",
        name: "Beta",
        description: "The Beta effort",
        activeCount: 2,
        completedCount: 0,
        totalCount: 2,
        roots: [
          {
            id: "t1",
            title: "Title t1",
            completed: false,
            identityId: "sec_Beta",
            identityLabel: "Beta",
            provenance: "automatic" as const,
            reason: "Classified as Beta.",
          },
          {
            id: "t2",
            title: "Title t2",
            completed: false,
            identityId: "sec_Beta",
            identityLabel: "Beta",
            provenance: "automatic" as const,
            reason: "Classified as Beta.",
          },
        ],
      },
    ],
    unresolved: [],
    counts: {
      activeRoots: 2,
      completedRoots: 0,
      totalRoots: 2,
      unresolvedRoots: 0,
      activeWorkstreams: 1,
    },
  };
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "map" },
    {
      sidebarThreads: {
        status: "ready",
        threads: [
          sidebarThread("t1", { sectionId: "sec_Beta" }),
          sidebarThread("t1c", { parentThreadId: "t1" }),
          sidebarThread("t1d", { parentThreadId: "t1c" }),
        ],
        sections: [section("sec_Beta", "Beta")],
        projects: [],
      },
      rpc: {
        state: () => emptyState(),
        organization: () => ({ state: orgState }),
      },
    },
  );
  expect((await slot.findAllByText("Beta")).length).toBeGreaterThanOrEqual(1);
  slot.lifecycle.unmount();
});

it("reports live organization status on the Organize tab", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const orgState = {
    status: "idle" as const,
    progress: null,
    error: null,
    lastUpdatedAt: 1,
    groups: [
      {
        key: "sec_a",
        sectionId: "sec_a",
        name: "Alpha",
        description: "Alpha work",
        activeCount: 1,
        completedCount: 0,
        totalCount: 1,
        roots: [
          {
            id: "a1",
            title: "Task a1",
            completed: false,
            identityId: "sec_a",
            identityLabel: "Alpha",
            provenance: "automatic" as const,
            reason: "Classified as Alpha.",
          },
        ],
      },
    ],
    unresolved: [],
    counts: {
      activeRoots: 1,
      completedRoots: 0,
      totalRoots: 1,
      unresolvedRoots: 0,
      activeWorkstreams: 1,
    },
  };
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "map" },
    {
      sidebarThreads: {
        status: "ready",
        threads: [
          sidebarThread("a1", { sectionId: "sec_a" }),
          sidebarThread("a2", { parentThreadId: "a1" }),
        ],
        sections: [section("sec_a", "Alpha")],
        projects: [],
      },
      rpc: {
        state: () => ({
          ...emptyState(),
          workstreams: {
            sec_a: {
              sectionId: "sec_a",
              name: "Alpha",
              description: "Alpha work",
              descriptionSource: "generated",
              aliases: [],
              subjects: [],
              projects: [],
              evidence: { threadCount: 1, lastActiveAt: 0 },
              createdBy: "workstreams",
              updatedAt: 0,
            },
          },
        }),
        journal: () => ({ entries: [] }),
        organization: () => ({ state: orgState }),
      },
    },
  );
  expect((await slot.findAllByText("Alpha")).length).toBeGreaterThanOrEqual(1);
  expect(slot.queryByRole("alert")).toBeNull();
  slot.lifecycle.unmount();
});
