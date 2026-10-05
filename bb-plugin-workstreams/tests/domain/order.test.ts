import { describe, expect, it } from "vitest";
import { applyOrder, placeBefore } from "../../src/domain/order.ts";
import { DAY_MS, projectWorkstreams } from "../../src/domain/project.ts";
import { thread } from "./fixtures.ts";

const id = (x: string) => x;

describe("applyOrder", () => {
  it("puts unlisted items first or last, keeping their incoming order", () => {
    expect(applyOrder(["a", "b", "c", "d"], ["c", "a"], id, "first")).toEqual([
      "b",
      "d",
      "c",
      "a",
    ]);
    expect(applyOrder(["a", "b", "c", "d"], ["c", "a"], id, "last")).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("ignores listed ids that are no longer present", () => {
    expect(applyOrder(["a", "b"], ["gone", "b", "a"], id, "first")).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("placeBefore", () => {
  it("moves or inserts an id before another, or at the end", () => {
    expect(placeBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(placeBefore(["a", "b"], "x", "b")).toEqual(["a", "x", "b"]);
    expect(placeBefore(["a", "b"], "a", null)).toEqual(["b", "a"]);
    expect(placeBefore(["a", "b"], "x", "missing")).toEqual(["a", "b", "x"]);
  });
});

describe("manual order in the projection", () => {
  const now = 100 * DAY_MS;
  const sections = [
    { id: "sec_a", name: "Alpha" },
    { id: "sec_b", name: "Beta" },
    { id: "sec_c", name: "Gamma" },
  ];
  const threads = [
    thread("a1", { sectionId: "sec_a", latestAttentionAt: now - 1 }),
    thread("a2", { sectionId: "sec_a", latestAttentionAt: now - 2 }),
    thread("kid", {
      parentThreadId: "a2",
      sectionId: "sec_a",
      latestAttentionAt: now,
    }),
    thread("a3", { sectionId: "sec_a", latestAttentionAt: now - 3 }),
    thread("b1", { sectionId: "sec_b", latestAttentionAt: now }),
    thread("c1", { sectionId: "sec_c", latestAttentionAt: now }),
  ];

  it("orders workstreams, new ones last, and roots, new ones first", () => {
    const p = projectWorkstreams(threads, sections, {
      now,
      order: {
        workstreams: ["sec_b", "sec_a"],
        threads: { sec_a: ["a3", "a2"] },
        prioritized: [],
      },
    });
    expect(p.groups.map((g) => g.id)).toEqual(["sec_b", "sec_a", "sec_c"]);
    expect(p.groups[1]!.rows.map((r) => r.thread.id)).toEqual([
      "a1",
      "a3",
      "a2",
      "kid",
    ]);
  });

  it("keeps pinned threads above manually ordered threads in each workstream", () => {
    const p = projectWorkstreams(
      [
        thread("pinned", {
          sectionId: "sec_a",
          isPinned: true,
          pinSortKey: "b",
          latestAttentionAt: now - 10,
        }),
        thread("pinned-first", {
          sectionId: "sec_a",
          isPinned: true,
          pinSortKey: "a",
          latestAttentionAt: now - 20,
        }),
        ...threads,
      ],
      sections,
      {
        now,
        order: {
          workstreams: [],
          threads: { sec_a: ["a3", "a1", "a2"] },
          prioritized: [],
        },
      },
    );

    expect(p.groups[0]!.rows.map((row) => row.thread.id)).toEqual([
      "pinned-first",
      "pinned",
      "a3",
      "a1",
      "a2",
      "kid",
    ]);
  });
});
