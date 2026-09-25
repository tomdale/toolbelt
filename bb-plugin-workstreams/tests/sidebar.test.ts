import { expect, it } from "vitest";
import { buildSidebar, type SidebarThread } from "../sidebar-model";
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
  ...extra,
});
const item = (threadId: string, group: string, state: string) => ({
  threadId,
  group,
  recap: "r",
  state: state as never,
  needsYou: state === "needs_decision" || state === "ready_for_review",
  updatedAt: 1,
  refreshed: true,
});

it("groups by analysis, nests children, folds singletons, and bands decisions", () => {
  const analysis = {
    at: 1,
    warnings: [],
    summaries: { BB: { about: "a", status: "s", motif: "m" } },
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
  expect(model.other.map((r) => [r.thread.id, r.group])).toEqual([
    ["d", "Dockside"],
  ]);
  // Ready-for-review stays in its group; decisions and pending input band.
  expect(model.needsYou.map((r) => r.thread.id).sort()).toEqual(["b", "e"]);
  expect(model.needsYou.every((r) => r.depth === 0)).toBe(true);
});
