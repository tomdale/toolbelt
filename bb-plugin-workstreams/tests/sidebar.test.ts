import { expect, it } from "vitest";
import {
  buildSidebar,
  deriveSidebarHierarchy,
  isImmediateAsk,
  type SidebarThread,
} from "../sidebar-model";
import type { Analysis } from "../model";

const t = (id: string, extra: Partial<SidebarThread> = {}): SidebarThread => ({
  id,
  displayTitle: id,
  parentThreadId: null,
  sectionId: null,
  projectId: "p",
  status: "idle",
  hasPendingInteraction: false,
  isUnread: false,
  isPinned: false,
  updatedAt: 1,
  latestAttentionAt: 1,
  ...extra,
});
const item = (threadId: string, group: string, state: string) => ({
  threadId,
  group,
  recap: "r",
  state: state as never,
  needsYou: state === "needs_decision",
  updatedAt: 1,
  refreshed: true,
});

it("derives Dispatch, manager, and worker roles from parentage and checkout", () => {
  const threads = [
    t("dispatch", { environmentPath: "/Users/tomdale/Code/tomdaleOS" }),
    t("manager", { parentThreadId: "dispatch" }),
    t("worker", { parentThreadId: "manager" }),
    t("deep-worker", { parentThreadId: "worker" }),
    t("unrelated-root", { environmentPath: "/tmp/other" }),
  ];
  const hierarchy = deriveSidebarHierarchy(threads);
  expect(hierarchy.dispatch.map((thread) => thread.id)).toEqual(["dispatch"]);
  expect(hierarchy.roles.get("manager")).toBe("manager");
  expect(hierarchy.roles.get("worker")).toBe("worker");
  expect(hierarchy.managerFor.get("deep-worker")?.id).toBe("manager");
  expect(hierarchy.roles.get("unrelated-root")).toBe("worker");
});

it("routes an answered worker question to its reporting manager only", () => {
  const analysis = {
    at: 10,
    needsYouCount: 1,
    warnings: [],
    summaries: {},
    items: [
      item("manager", "manager", "in_progress"),
      item("worker", "Team", "needs_decision"),
    ],
  } as Analysis;
  const model = buildSidebar(
    [
      t("dispatch", { environmentPath: "/Users/tomdale/Code/tomdaleOS" }),
      t("manager", { parentThreadId: "dispatch" }),
      t("worker", { parentThreadId: "manager" }),
      t("live-approval", {
        parentThreadId: "manager",
        hasPendingInteraction: true,
      }),
    ],
    analysis,
    new Map(),
    new Map([["p", "Project"]]),
    new Map([["manager", ["worker"]]]),
    {
      dispatchIds: ["dispatch"],
      roles: {
        dispatch: "dispatch",
        manager: "manager",
        worker: "worker",
        "live-approval": "worker",
      },
      managers: { worker: "manager", "live-approval": "manager" },
    },
  );
  expect(model.needsYou.map((row) => row.thread.id)).toContain("live-approval");
  expect(model.needsYou.map((row) => row.thread.id)).not.toContain("worker");
  expect(
    model.needsYou.find((row) => row.thread.id === "manager")?.immediateAsk,
  ).toBe(true);
  expect(model.groups).toHaveLength(1);
  expect(model.groups[0].manager).toBeNull();
  expect(model.groups[0].rows.map((row) => row.thread.id)).toEqual([
    "worker",
    "live-approval",
  ]);
  expect(model.dispatch.map((row) => row.thread.id)).toEqual([
    "dispatch",
    "manager",
  ]);
});

it("keeps every active hook-visible thread once across Dispatch, manager groups, and cross-group parentage", () => {
  const threads = [
    t("dispatch", { environmentPath: "/Users/tomdale/Code/tomdaleOS" }),
    t("manager", {
      parentThreadId: "dispatch",
      displayTitle: "Alpha — manager",
    }),
    t("worker", { parentThreadId: "manager" }),
    t("deep", { parentThreadId: "worker" }),
    // Its own analyzed group differs, but the worker still belongs to its manager.
    t("cross-group", { parentThreadId: "manager" }),
    // These rows model hidden active SDK entries; archived entries are not passed.
    t("hidden-child", { parentThreadId: "manager", isHidden: true }),
    t("orphan-child", { parentThreadId: "missing-parent" }),
  ];
  const model = buildSidebar(
    threads,
    {
      at: 1,
      needsYouCount: 0,
      warnings: [],
      summaries: {},
      items: [item("cross-group", "Different group", "in_progress")],
    } as Analysis,
    new Map(),
    new Map([["p", "Project"]]),
    new Map(),
    {
      dispatchIds: ["dispatch"],
      roles: Object.fromEntries(
        threads.map((thread) => [
          thread.id,
          thread.id === "dispatch"
            ? "dispatch"
            : thread.id === "manager"
              ? "manager"
              : "worker",
        ]),
      ) as Record<string, "dispatch" | "manager" | "worker">,
      managers: {
        worker: "manager",
        deep: "manager",
        "cross-group": "manager",
        "hidden-child": "manager",
      },
    },
  );
  const visibleIds = [
    ...model.dispatch.map((row) => row.thread.id),
    ...model.groups.flatMap((group) => [
      ...(group.manager ? [group.manager.thread.id] : []),
      ...group.rows.map((row) => row.thread.id),
    ]),
  ];
  expect(visibleIds.sort()).toEqual(threads.map((thread) => thread.id).sort());
  expect(new Set(visibleIds).size).toBe(threads.length);
  expect(model.dispatch.map((row) => [row.thread.id, row.depth])).toEqual([
    ["dispatch", 0],
    ["manager", 1],
  ]);
  expect(
    model.groups.flatMap((group) => group.rows.map((row) => row.thread.id)),
  ).toContain("hidden-child");
  expect(model.groups.some((group) => group.name === "Different group")).toBe(
    false,
  );
  expect(model.warnings).toHaveLength(1);
  expect(
    model.groups.flatMap((group) => group.rows).map((row) => row.thread.id),
  ).toContain("orphan-child");
});

it("renders Dispatch children once while manager groups contain only their workers", () => {
  const model = buildSidebar(
    [
      t("dispatch", { environmentPath: "/Users/tomdale/Code/tomdaleOS" }),
      t("manager-a", {
        parentThreadId: "dispatch",
        displayTitle: "Alpha — manager",
      }),
      t("manager-b", {
        parentThreadId: "dispatch",
        displayTitle: "Beta — manager",
      }),
      t("worker-a", { parentThreadId: "manager-a" }),
      t("worker-b", { parentThreadId: "manager-b" }),
    ],
    null,
    new Map(),
    new Map([["p", "Project"]]),
  );
  expect(model.dispatch.map((row) => [row.thread.id, row.depth])).toEqual([
    ["dispatch", 0],
    ["manager-a", 1],
    ["manager-b", 1],
  ]);
  expect(
    model.groups.flatMap((group) => group.rows.map((row) => row.thread.id)),
  ).toEqual(["worker-a", "worker-b"]);
  const allIds = [
    ...model.dispatch.map((row) => row.thread.id),
    ...model.groups.flatMap((group) => [
      ...(group.manager ? [group.manager.thread.id] : []),
      ...group.rows.map((row) => row.thread.id),
    ]),
  ];
  expect(allIds.sort()).toEqual([
    "dispatch",
    "manager-a",
    "manager-b",
    "worker-a",
    "worker-b",
  ]);
  expect(new Set(allIds).size).toBe(allIds.length);
});

it("breaks cyclic parentage deterministically and retains every row", () => {
  const model = buildSidebar(
    [
      t("cycle-a", { parentThreadId: "cycle-b" }),
      t("cycle-b", { parentThreadId: "cycle-a" }),
      t("cycle-child", { parentThreadId: "cycle-a" }),
    ],
    null,
    new Map(),
    new Map([["p", "Project"]]),
  );
  const rows = model.groups.flatMap((group) => group.rows);
  expect(rows.map((row) => row.thread.id).sort()).toEqual([
    "cycle-a",
    "cycle-b",
    "cycle-child",
  ]);
  expect(new Set(rows.map((row) => row.thread.id)).size).toBe(3);
  expect(model.warnings).toHaveLength(1);
});

it("keeps identically named managers in distinct groups", () => {
  const model = buildSidebar(
    [
      t("manager-a", {
        parentThreadId: "dispatch",
        displayTitle: "Same — manager",
      }),
      t("manager-b", {
        parentThreadId: "dispatch",
        displayTitle: "Same — manager",
      }),
      t("dispatch", { environmentPath: "/Users/tomdale/Code/tomdaleOS" }),
      t("worker-a", { parentThreadId: "manager-a" }),
      t("worker-b", { parentThreadId: "manager-b" }),
    ],
    null,
    new Map(),
    new Map([["p", "Project"]]),
  );
  expect(
    model.groups.flatMap((group) => group.rows.map((row) => row.thread.id)),
  ).toEqual(["worker-a", "worker-b"]);
  expect(model.groups.map((group) => group.id)).toEqual([
    "manager:manager-a",
    "manager:manager-b",
  ]);
  expect(model.dispatch.map((row) => row.thread.id)).toEqual([
    "dispatch",
    "manager-a",
    "manager-b",
  ]);
});

it("keeps standalone manager rows as group headers", () => {
  const model = buildSidebar(
    [
      t("manager", { displayTitle: "Alpha — manager" }),
      t("worker", { parentThreadId: "manager" }),
    ],
    null,
    new Map(),
    new Map([["p", "Project"]]),
    new Map(),
    {
      dispatchIds: [],
      roles: { manager: "manager", worker: "worker" },
      managers: { worker: "manager" },
    },
  );
  expect(model.groups).toHaveLength(1);
  expect(model.groups[0].manager?.thread.id).toBe("manager");
  expect(model.groups[0].rows.map((row) => row.thread.id)).toEqual(["worker"]);
});

it("groups by analysis, nests children, and bands decisions", () => {
  const analysis = {
    at: 1,
    needsYouCount: 2,
    warnings: [],
    summaries: { BB: { about: "a", status: "s", motif: "m", needsYou: 1 } },
    items: [
      item("a", "BB", "done"),
      item("b", "BB", "needs_decision"),
      item("c", "BB", "ready_for_review"),
      item("d", "Dockside", "in_progress"),
    ],
  } as Analysis;
  const model = buildSidebar(
    [
      t("a"),
      t("b"),
      t("c", { parentThreadId: "b" }),
      t("d"),
      t("e", { sectionId: "s1", hasPendingInteraction: true }),
      t("f", { sectionId: "s1" }),
    ],
    analysis,
    new Map([["s1", "Workforest"]]),
    new Map([["p", "Project"]]),
  );
  const bb = model.groups.find((g) => g.name === "BB")!;
  // Decisions first, done last; the child follows its parent, indented.
  expect(bb.rows.map((r) => [r.thread.id, r.depth])).toEqual([
    ["b", 0],
    ["c", 1],
    ["a", 0],
  ]);
  expect(bb.needsYou).toBe(1);
  expect(bb.summary?.about).toBe("a");
  // Unanalyzed threads fall back to their section's name.
  expect(model.groups.find((g) => g.name === "Workforest")?.rows).toHaveLength(
    2,
  );
  expect(model.other).toHaveLength(0);
  expect(
    model.groups.find((group) => group.name === "Dockside")?.rows[0].thread.id,
  ).toBe("d");
  expect(model.recent.slice(0, 2).map((r) => r.thread.id)).toEqual(["b", "c"]);
  // Ready-for-review stays in its group; decisions and pending input band.
  expect(model.needsYou.map((r) => r.thread.id).sort()).toEqual(["b", "e"]);
  expect(model.totalNeedsYou).toBe(2);
  expect(model.recent).toHaveLength(5);
  expect(model.needsYou.every((r) => r.depth === 0)).toBe(true);
  const reviewReady = model.groups
    .flatMap((group) => group.rows)
    .find((row) => row.thread.id === "c")!;
  expect(isImmediateAsk(reviewReady)).toBe(false);
  const decision = model.groups
    .flatMap((group) => group.rows)
    .find((row) => row.thread.id === "b")!;
  expect(isImmediateAsk(decision)).toBe(true);
});
