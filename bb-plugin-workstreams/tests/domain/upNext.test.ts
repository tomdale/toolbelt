import { describe, expect, it } from "vitest";
import { DAY_MS, projectWorkstreams } from "../../src/domain/project.ts";
import { UP_NEXT_LIMIT, selectUpNext } from "../../src/domain/upNext.ts";
import { thread } from "./fixtures.ts";

const now = 100 * DAY_MS;
const sections = [
  { id: "sec_a", name: "Alpha" },
  { id: "sec_b", name: "Beta" },
];
const ids = (rows: readonly { thread: { id: string } }[]) =>
  rows.map((row) => row.thread.id);

describe("selectUpNext", () => {
  it("lists waiting threads first, then recap threads, newest first", () => {
    const projection = projectWorkstreams(
      [
        thread("ask", {
          sectionId: "sec_a",
          hasPendingInteraction: true,
          latestAttentionAt: now - 5,
        }),
        thread("recap-new", { sectionId: "sec_b", latestAttentionAt: now - 1 }),
        thread("recap-old", { sectionId: "sec_a", latestAttentionAt: now - 9 }),
        thread("quiet", { sectionId: "sec_a", latestAttentionAt: now }),
      ],
      sections,
      { now },
    );
    const upNext = selectUpNext(projection, {
      recaps: { "recap-new": {}, "recap-old": {}, ask: {} },
      prioritized: new Set(),
    });
    // A waiting thread with a recap appears once, in the waiting position.
    expect(ids(upNext.rows)).toEqual(["ask", "recap-new", "recap-old"]);
    expect(upNext.focus.active).toBe(false);
  });

  it("keeps snoozed threads out, taking their recaps with them", () => {
    const projection = projectWorkstreams(
      [
        thread("snoozed-ask", {
          sectionId: "sec_a",
          hasPendingInteraction: true,
        }),
        thread("snoozed-recap", { sectionId: "sec_a" }),
        thread("awake", { sectionId: "sec_a", hasPendingInteraction: true }),
      ],
      sections,
      {
        now,
        snoozedUntil: (t) =>
          t.id.startsWith("snoozed") ? now + DAY_MS : undefined,
      },
    );
    const upNext = selectUpNext(projection, {
      recaps: { "snoozed-recap": {} },
      prioritized: new Set(),
    });
    expect(ids(upNext.rows)).toEqual(["awake"]);
  });

  it("focuses on prioritized workstreams while one of them is waiting", () => {
    const projection = projectWorkstreams(
      [
        thread("pinned-ask", {
          sectionId: "sec_a",
          hasPendingInteraction: true,
          latestAttentionAt: now - 3,
        }),
        thread("other-ask", {
          sectionId: "sec_b",
          hasPendingInteraction: true,
          latestAttentionAt: now - 2,
        }),
        thread("other-recap", {
          sectionId: "sec_b",
          latestAttentionAt: now - 1,
        }),
        thread("pinned-recap", {
          sectionId: "sec_a",
          latestAttentionAt: now - 4,
        }),
      ],
      sections,
      { now },
    );
    const upNext = selectUpNext(projection, {
      recaps: { "other-recap": {}, "pinned-recap": {} },
      prioritized: new Set(["sec_a"]),
    });
    expect(upNext.focus.active).toBe(true);
    expect(ids(upNext.rows)).toEqual(["pinned-ask", "pinned-recap"]);
    expect(ids(upNext.focus.elsewhere)).toEqual(["other-ask"]);
  });

  it("shows every waiting thread when no prioritized workstream is waiting", () => {
    const projection = projectWorkstreams(
      [
        thread("other-ask", {
          sectionId: "sec_b",
          hasPendingInteraction: true,
        }),
        thread("pinned-quiet", { sectionId: "sec_a" }),
      ],
      sections,
      { now },
    );
    const upNext = selectUpNext(projection, {
      recaps: {},
      prioritized: new Set(["sec_a"]),
    });
    expect(upNext.focus.active).toBe(false);
    expect(ids(upNext.rows)).toEqual(["other-ask"]);
  });

  it("keeps a row focus would take away when the caller asks", () => {
    const projection = projectWorkstreams(
      [
        thread("pinned-ask", {
          sectionId: "sec_a",
          hasPendingInteraction: true,
        }),
        thread("open", { sectionId: "sec_b", hasPendingInteraction: true }),
      ],
      sections,
      { now },
    );
    const upNext = selectUpNext(projection, {
      recaps: {},
      prioritized: new Set(["sec_a"]),
      keep: (row) => row.thread.id === "open",
    });
    expect(ids(upNext.rows).sort()).toEqual(["open", "pinned-ask"]);
  });

  it("lists Unfiled and dormant recap threads too", () => {
    const old = now - 60 * DAY_MS;
    const projection = projectWorkstreams(
      [
        thread("loose", { latestAttentionAt: now - 1 }),
        thread("dormant", { sectionId: "sec_b", latestAttentionAt: old }),
      ],
      sections,
      { now },
    );
    expect(projection.dormant.map((group) => group.id)).toEqual(["sec_b"]);
    const upNext = selectUpNext(projection, {
      recaps: { loose: {}, dormant: {} },
      prioritized: new Set(),
    });
    expect(ids(upNext.rows)).toEqual(["loose", "dormant"]);
  });

  it("limits Up Next to five rows by default", () => {
    expect(UP_NEXT_LIMIT).toBe(5);
  });
});
