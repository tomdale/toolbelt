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

it("derives manager groups independently of top-level thread location", () => {
  const threads = [
    t("manager", { displayTitle: "Project — manager" }),
    t("worker", { parentThreadId: "manager" }),
    t("deep-worker", { parentThreadId: "worker" }),
    t("unrelated-root", { environmentPath: "/Users/tomdale/Code/tomdaleOS" }),
  ];
  const hierarchy = deriveSidebarHierarchy(threads);
  expect(hierarchy.roles.get("manager")).toBe("manager");
  expect(hierarchy.managerFor.get("deep-worker")?.id).toBe("manager");
  expect(hierarchy.roles.get("unrelated-root")).toBe("worker");
});

it("routes worker questions to the manager without depending on a root-thread role", () => {
  const model = buildSidebar(
    [
      t("manager", { displayTitle: "Project — manager" }),
      t("worker", { parentThreadId: "manager" }),
      t("live-approval", {
        parentThreadId: "manager",
        hasPendingInteraction: true,
      }),
    ],
    {
      at: 10,
      needsYouCount: 1,
      warnings: [],
      summaries: {},
      items: [
        item("manager", "Project", "in_progress"),
        item("worker", "Project", "needs_decision"),
      ],
    } as Analysis,
    new Map(),
    new Map([["p", "Project"]]),
    new Map([["manager", ["worker"]]]),
  );
  expect(model.needsYou.map((row) => row.thread.id)).toContain("live-approval");
  expect(model.needsYou.map((row) => row.thread.id)).not.toContain("worker");
  const group = model.groups.find(
    (entry) => entry.manager?.thread.id === "manager",
  )!;
  expect(group.manager?.immediateAsk).toBe(true);
  expect(group.rows.map((row) => row.thread.id)).toEqual([
    "worker",
    "live-approval",
  ]);
});

it("keeps every active thread exactly once under its manager or project group", () => {
  const threads = [
    t("manager", { displayTitle: "Alpha — manager" }),
    t("worker", { parentThreadId: "manager" }),
    t("deep", { parentThreadId: "worker" }),
    t("cross-group", { parentThreadId: "manager" }),
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
      roles: {
        manager: "manager",
        worker: "worker",
        deep: "worker",
        "cross-group": "worker",
        "hidden-child": "worker",
        "orphan-child": "worker",
      },
      managers: {
        worker: "manager",
        deep: "manager",
        "cross-group": "manager",
        "hidden-child": "manager",
      },
    },
  );
  const visible = model.groups.flatMap((group) => [
    ...(group.manager ? [group.manager.thread.id] : []),
    ...group.rows.map((row) => row.thread.id),
  ]);
  expect(visible.sort()).toEqual(threads.map((thread) => thread.id).sort());
  expect(new Set(visible).size).toBe(threads.length);
  const group = model.groups.find(
    (entry) => entry.manager?.thread.id === "manager",
  )!;
  expect(group.rows.map((row) => row.thread.id)).toContain("hidden-child");
  expect(group.rows.map((row) => row.thread.id)).toContain("cross-group");
  expect(model.warnings).toHaveLength(1);
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
      t("manager-a", { displayTitle: "Same — manager" }),
      t("manager-b", { displayTitle: "Same — manager" }),
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
