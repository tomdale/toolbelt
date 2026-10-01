import { describe, expect, it } from "vitest";
import { planDrop } from "../../src/app/sidebar/drop.ts";
import { EMPTY_ORDER } from "../../src/domain/order.ts";
import { projectWorkstreams } from "../../src/domain/project.ts";
import { thread } from "../domain/fixtures.ts";

const now = 1_000_000;
const sections = [
  { id: "sec_a", name: "Alpha" },
  { id: "sec_b", name: "Beta" },
  { id: "sec_c", name: "Gamma" },
];
const projection = projectWorkstreams(
  [
    thread("a1", { sectionId: "sec_a", latestAttentionAt: now - 1 }),
    thread("a2", { sectionId: "sec_a", latestAttentionAt: now - 2 }),
    thread("kid", { parentThreadId: "a2", latestAttentionAt: now }),
    thread("a3", { sectionId: "sec_a", latestAttentionAt: now - 3 }),
    thread("b1", { sectionId: "sec_b", latestAttentionAt: now }),
    thread("c1", { sectionId: "sec_c", latestAttentionAt: now }),
    thread("u1", { latestAttentionAt: now }),
  ],
  sections,
  { now },
);
const threadDrop = (over: Partial<Parameters<typeof planDrop>[0]> = {}) =>
  ({
    kind: "thread",
    threadId: "b1",
    fromGroupId: "sec_b",
    toGroupId: "sec_a",
    overThreadId: "a2",
    below: false,
    ...over,
  }) as Parameters<typeof planDrop>[0];

describe("planDrop", () => {
  it("reorders workstreams by moving one into the target's slot", () => {
    expect(
      planDrop(
        { kind: "group", groupId: "sec_c", overGroupId: "sec_a" },
        projection,
        sections,
        EMPTY_ORDER,
      ),
    ).toEqual({
      move: null,
      reorder: { kind: "workstreams", ids: ["sec_c", "sec_a", "sec_b"] },
    });
  });

  it("reorders roots within a group, ignoring children", () => {
    expect(
      planDrop(
        threadDrop({
          threadId: "a3",
          fromGroupId: "sec_a",
          overThreadId: "a1",
        }),
        projection,
        sections,
        EMPTY_ORDER,
      ),
    ).toEqual({
      move: null,
      reorder: { kind: "threads", groupId: "sec_a", ids: ["a3", "a1", "a2"] },
    });
  });

  it("moves a root into another group above or below the target", () => {
    expect(planDrop(threadDrop(), projection, sections, EMPTY_ORDER)).toEqual({
      move: { threadId: "b1", sectionId: "sec_a" },
      reorder: {
        kind: "threads",
        groupId: "sec_a",
        ids: ["a1", "b1", "a2", "a3"],
      },
    });
    expect(
      planDrop(threadDrop({ below: true }), projection, sections, EMPTY_ORDER)
        .reorder,
    ).toEqual({
      kind: "threads",
      groupId: "sec_a",
      ids: ["a1", "a2", "b1", "a3"],
    });
  });

  it("files a root dropped on a group header at its top, and into Unfiled", () => {
    expect(
      planDrop(
        threadDrop({ toGroupId: "unsorted", overThreadId: null }),
        projection,
        sections,
        EMPTY_ORDER,
      ),
    ).toEqual({
      move: { threadId: "b1", sectionId: null },
      reorder: { kind: "threads", groupId: "unsorted", ids: ["b1", "u1"] },
    });
  });
});
