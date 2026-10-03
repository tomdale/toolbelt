import { describe, expect, it } from "vitest";
import { arrangeGroups, sortGroups } from "../../src/domain/groups.ts";
import { DAY_MS, projectWorkstreams } from "../../src/domain/project.ts";
import { thread } from "./fixtures.ts";

const now = 100 * DAY_MS;
const sections = [
  { id: "sec_c", name: "Charlie" },
  { id: "sec_a", name: "Alpha" },
  { id: "sec_b", name: "Beta" },
  { id: "sec_empty", name: "Empty" },
  { id: "sec_old", name: "Old" },
];
const names = (groups: readonly { name: string }[]) =>
  groups.map((group) => group.name);

function project(prioritized: string[] = []) {
  return projectWorkstreams(
    [
      thread("c1", { sectionId: "sec_c", latestAttentionAt: now - 3 }),
      thread("a1", { sectionId: "sec_a", latestAttentionAt: now - 1 }),
      thread("b1", { sectionId: "sec_b", latestAttentionAt: now - 2 }),
      thread("old1", {
        sectionId: "sec_old",
        latestAttentionAt: now - 90 * DAY_MS,
      }),
      thread("loose", { latestAttentionAt: now - 4 }),
    ],
    sections,
    { now, order: { workstreams: [], threads: {}, prioritized } },
  );
}

describe("arrangeGroups", () => {
  it("orders populated groups by name, then activity, then BB's order", () => {
    const projection = project();
    expect(names(arrangeGroups(projection, "alphabetical").populated)).toEqual([
      "Alpha",
      "Beta",
      "Charlie",
    ]);
    expect(names(arrangeGroups(projection, "activity").populated)).toEqual([
      "Alpha",
      "Beta",
      "Charlie",
    ]);
    expect(names(arrangeGroups(projection, "manual").populated)).toEqual([
      "Charlie",
      "Alpha",
      "Beta",
    ]);
  });

  it("puts empty workstreams after populated ones and Dormant apart", () => {
    const arranged = arrangeGroups(project(), "alphabetical");
    expect(names(arranged.empty)).toEqual(["Empty"]);
    expect(names(arranged.dormant)).toEqual(["Old"]);
    expect(arranged.unfiled.total).toBe(1);
    expect(arranged.tiered).toBe(false);
    expect(arranged.hasLower).toBe(true);
  });

  it("tiers the groups once any workstream is prioritized", () => {
    const arranged = arrangeGroups(project(["sec_b"]), "alphabetical");
    expect(names(arranged.pinned)).toEqual(["Beta"]);
    expect(names(arranged.populated)).toEqual(["Alpha", "Charlie"]);
    expect(arranged.tiered).toBe(true);
  });

  it("reports nothing to reveal when every group is prioritized", () => {
    const projection = projectWorkstreams(
      [thread("a1", { sectionId: "sec_a" })],
      [{ id: "sec_a", name: "Alpha" }],
      { now, order: { workstreams: [], threads: {}, prioritized: ["sec_a"] } },
    );
    const arranged = arrangeGroups(projection, "alphabetical");
    expect(arranged.tiered).toBe(true);
    expect(arranged.hasLower).toBe(false);
  });
});

describe("sortGroups", () => {
  it("breaks activity ties by name", () => {
    const projection = projectWorkstreams(
      [
        thread("z1", { sectionId: "sec_b", latestAttentionAt: now }),
        thread("y1", { sectionId: "sec_a", latestAttentionAt: now }),
      ],
      sections,
      { now },
    );
    const groups = projection.groups.filter((group) => group.total > 0);
    expect(names(sortGroups(groups, "activity"))).toEqual(["Alpha", "Beta"]);
  });
});
