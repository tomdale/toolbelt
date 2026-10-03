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

it("previews organization as one decision without line-item vetoes", async () => {
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
    mapSnapshot: [
      {
        sectionId: "sec_Alpha",
        name: "Alpha",
        description: null,
        aliases: [],
        descriptionSource: "generated",
      },
      {
        sectionId: "sec_Beta",
        name: "Beta",
        description: "The Beta effort",
        aliases: [],
        descriptionSource: "generated",
      },
    ],
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
        move("t2", "Alpha", "Beta"),
        move("t3", "Unfiled", "Gamma", { to: "new:g" }),
        move("t4", "Beta", "Gamma", { to: "new:g", accepted: false }),
      ],
      removals: [
        {
          sectionId: "sec_Alpha",
          name: "Alpha",
          archivedThreads: [],
          latestArchivedAt: null,
        },
      ],
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
        threads: [
          sidebarThread("t1", { sectionId: "sec_Alpha" }),
          sidebarThread("t1c", { parentThreadId: "t1" }),
          sidebarThread("t1d", { parentThreadId: "t1c" }),
        ],
        sections: [],
        projects: [],
      },
      rpc: {
        state: () => emptyState(),
        bootstrap: () => ({ state, bootstrapped: false }),
      },
    },
  );
  const summary = await slot.findByLabelText("Proposed changes");
  expect(summary.textContent).toBe(
    "Moving3tasksStaying2tasksNew1workstreamRenamed0workstreamsRemoved1workstream",
  );
  // Task roots and the child threads that follow them are counted apart.
  expect(
    slot.getByText(
      "Counts are task threads. Child threads stay with their task, so 2 of 2 child threads move too. 1 suggested move won’t be applied; that task stays where it is.",
    ),
  ).toBeTruthy();
  // The editor would make the preview stale, so it waits for the decision.
  expect(
    slot.queryByRole("region", { name: "Current workstreams" }),
  ).toBeNull();

  const after = slot.getByRole("list", { name: "Workstreams after Apply" });
  const rows = within(after)
    .getAllByRole("button", { expanded: false })
    .map((row) => row.textContent);
  expect(rows).toEqual([
    "Beta1→3+2 in",
    "GammaNew–→1+1 in",
    "Unfiled2→1−1 out",
  ]);
  expect(
    within(
      slot.getByRole("list", { name: "Workstreams Apply removes" }),
    ).getByRole("button").textContent,
  ).toBe("Alpha2→–Removed · −2 out");

  fireEvent.click(within(after).getByRole("button", { name: /^Beta/ }));
  const beta = slot.getByRole("region", { name: "Beta details" });
  expect(within(beta).getByText("Moving in · 2")).toBeTruthy();
  expect(within(beta).getAllByText("from Alpha")).toHaveLength(2);
  expect(within(beta).getByText("+2 child threads")).toBeTruthy();
  expect(within(beta).getByText("Staying · 1")).toBeTruthy();
  expect(within(beta).getByText("Suggested move not applied")).toBeTruthy();

  fireEvent.click(slot.getByRole("button", { name: "Moves 3" }));
  const table = slot.getByRole("table", { name: "Tasks Apply moves" });
  expect(
    within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]!.textContent),
  ).toEqual([
    "Title t1+2 child threadsUnresolved",
    "Title t2Unresolved",
    "Title t3Unresolved",
  ]);
  expect(slot.queryByRole("checkbox")).toBeNull();

  const bootstrapCalls = () =>
    slot.inspection.rpcCalls
      .filter((c) => c.method === "bootstrap")
      .map((c) => (c.input as { action: string }).action);
  expect(bootstrapCalls()).not.toContain("apply");
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
  await waitFor(() =>
    expect(
      (slot.getByRole("button", { name: "Regenerate" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(slot.getByRole("button", { name: "Regenerate" }));
  await waitFor(() => expect(bootstrapCalls()).toContain("start"));
  await waitFor(() =>
    expect(
      (slot.getByRole("button", { name: "Discard" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(slot.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(bootstrapCalls()).toContain("cancel"));
  slot.lifecycle.unmount();
});

it("reports an applied pass with neutral notices and a way to Activity", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
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
        bootstrap: () => ({
          state: {
            status: "applied",
            startedAt: 1,
            updatedAt: 1,
            error: "1 thread(s) changed since the preview and were left alone.",
            roots: [],
            mapSnapshot: [],
            preview: null,
            entryId: "e1",
            traceIds: [],
          },
          bootstrapped: true,
        }),
      },
    },
  );
  expect(await slot.findByText("Organization applied")).toBeTruthy();
  expect(slot.queryByRole("alert")).toBeNull();
  expect(slot.getByRole("status").textContent).toContain("left alone");
  const current = slot.getByRole("region", { name: "Current workstreams" });
  expect(within(current).getAllByText("1 task · 1 child thread")).toHaveLength(
    2,
  );
  fireEvent.click(slot.getByRole("button", { name: "View in Activity" }));
  expect(
    slot.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected"),
  ).toBe("true");
  slot.lifecycle.unmount();
});
