import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  UNSORTED_ID,
  projectWorkstreams,
  focusNeeds,
  rankGroups,
  type Group,
} from "../../src/domain/project.ts";
import { thread, type TestThread } from "./fixtures.ts";

const now = 100 * DAY_MS;
const sections = [
  { id: "sec_a", name: "Alpha" },
  { id: "sec_b", name: "Beta" },
  { id: "sec_empty", name: "Empty" },
];
const rowIds = (g: Group<TestThread>) => g.rows.map((r) => r.thread.id);

describe("projectWorkstreams", () => {
  it("files whole trees by the root's section, ignoring children's sections", () => {
    const p = projectWorkstreams(
      [
        thread("root", { sectionId: "sec_a", latestAttentionAt: now }),
        thread("child", {
          parentThreadId: "root",
          sectionId: "sec_b",
          latestAttentionAt: now,
        }),
        thread("beta", { sectionId: "sec_b", latestAttentionAt: now }),
      ],
      sections,
      { now },
    );
    expect(p.groups.map((g) => [g.id, rowIds(g)])).toEqual([
      ["sec_a", ["root", "child"]],
      ["sec_b", ["beta"]],
      ["sec_empty", []],
    ]);
    expect(p.rowOf.get("child")?.workstreamId).toBe("sec_a");
    expect(p.rowOf.get("child")?.depth).toBe(1);
  });

  it("keeps populated sections first even when empty sections have manual priority", () => {
    const p = projectWorkstreams(
      [
        thread("b1", { sectionId: "sec_b", latestAttentionAt: now }),
        thread("a1", { sectionId: "sec_a", latestAttentionAt: now - 1 }),
      ],
      sections,
      {
        now,
        order: {
          workstreams: ["sec_empty", "sec_b", "sec_a"],
          threads: {},
          prioritized: [],
        },
      },
    );
    expect(p.groups.map((g) => g.id)).toEqual(["sec_b", "sec_a", "sec_empty"]);
    expect(p.dormant).toEqual([]);
  });

  it("marks workstreams dormant after 30 quiet days unless something needs you", () => {
    const old = now - 31 * DAY_MS;
    const p = projectWorkstreams(
      [
        thread("a1", { sectionId: "sec_a", latestAttentionAt: old }),
        thread("b1", {
          sectionId: "sec_b",
          latestAttentionAt: old,
          hasPendingInteraction: true,
        }),
      ],
      sections,
      { now },
    );
    expect(p.groups.map((g) => g.id)).toEqual(["sec_b", "sec_empty"]);
    expect(p.dormant.map((g) => g.id)).toEqual(["sec_a"]);
  });

  it("puts unsectioned and unknown-section roots in Unsorted", () => {
    const p = projectWorkstreams(
      [
        thread("loose", { latestAttentionAt: now }),
        thread("ghost", { sectionId: "sec_deleted", latestAttentionAt: now }),
      ],
      sections,
      { now },
    );
    expect(p.unsorted.id).toBe(UNSORTED_ID);
    expect(rowIds(p.unsorted).sort()).toEqual(["ghost", "loose"]);
    expect(p.rowOf.get("ghost")?.workstreamId).toBeNull();
  });

  it("drops hidden and archived threads and promotes their children", () => {
    const p = projectWorkstreams(
      [
        thread("hidden", { isHidden: true, sectionId: "sec_a" }),
        thread("kid", {
          parentThreadId: "hidden",
          sectionId: "sec_b",
          latestAttentionAt: now,
        }),
        thread("gone", { isArchived: true, sectionId: "sec_a" }),
      ],
      sections,
      { now },
    );
    expect([...p.rowOf.keys()]).toEqual(["kid"]);
    expect(p.rowOf.get("kid")?.workstreamId).toBe("sec_b");
  });

  it("orders pinned roots first, then by recent attention; children by creation", () => {
    const p = projectWorkstreams(
      [
        thread("old", { sectionId: "sec_a", latestAttentionAt: now - 5 }),
        thread("new", { sectionId: "sec_a", latestAttentionAt: now }),
        thread("pin", {
          sectionId: "sec_a",
          latestAttentionAt: now - 9,
          isPinned: true,
          pinSortKey: "a",
        }),
        thread("c2", { parentThreadId: "new", createdAt: 20 }),
        thread("c1", { parentThreadId: "new", createdAt: 10 }),
      ],
      sections,
      { now },
    );
    expect(rowIds(p.groups[0]!)).toEqual(["pin", "new", "c1", "c2", "old"]);
  });

  it("overlays Needs you and Recent without removing rows from groups", () => {
    const p = projectWorkstreams(
      [
        thread("ask", {
          sectionId: "sec_a",
          hasPendingInteraction: true,
          latestAttentionAt: now,
        }),
        ...Array.from({ length: 7 }, (_, i) =>
          thread(`r${i}`, { sectionId: "sec_b", latestAttentionAt: now - i }),
        ),
      ],
      sections,
      { now },
    );
    expect(p.needsYou.map((r) => r.thread.id)).toEqual(["ask"]);
    expect(p.recent.map((r) => r.thread.id)).toEqual([
      "r0",
      "r1",
      "r2",
      "r3",
      "r4",
    ]);
    expect(p.groups[0]?.needsYou).toBe(1);
    expect(rowIds(p.groups[0]!)).toContain("ask");
  });

  it("limits Recent to top-level threads before applying its limit", () => {
    const p = projectWorkstreams(
      [
        thread("root", { sectionId: "sec_a", latestAttentionAt: now - 10 }),
        thread("child", {
          parentThreadId: "root",
          latestAttentionAt: now,
        }),
        ...Array.from({ length: 5 }, (_, i) =>
          thread(`other${i}`, { latestAttentionAt: now - 20 - i }),
        ),
      ],
      sections,
      { now, recentLimit: 3 },
    );
    expect(p.recent.map((row) => row.thread.id)).toEqual([
      "root",
      "other0",
      "other1",
    ]);
  });

  it("accepts a custom needs-you predicate", () => {
    const p = projectWorkstreams(
      [thread("x", { sectionId: "sec_a", latestAttentionAt: now })],
      sections,
      { now, needsYou: (t) => t.id === "x" },
    );
    expect(p.needsYou.map((r) => r.thread.id)).toEqual(["x"]);
  });

  it("ranks page groups by needs-you, then recency", () => {
    const p = projectWorkstreams(
      [
        thread("a1", { sectionId: "sec_a", latestAttentionAt: now }),
        thread("b1", {
          sectionId: "sec_b",
          latestAttentionAt: now - 100,
          hasPendingInteraction: true,
        }),
      ],
      sections,
      { now },
    );
    expect(rankGroups(p.groups).map((g) => g.id)).toEqual([
      "sec_b",
      "sec_a",
      "sec_empty",
    ]);
  });
});

/**
 * Exact-once check against a private export of real BB state. Set
 * WORKSTREAMS_SNAPSHOT to a JSON file of { threads, sections } as returned by
 * `bb thread list --json` and `bb thread section list --json`. Real exports
 * contain private titles and never belong in this repository.
 */
const snapshotPath = process.env.WORKSTREAMS_SNAPSHOT;
describe.skipIf(!snapshotPath)("real snapshot", () => {
  it("renders every visible, non-archived thread exactly once", () => {
    const raw = JSON.parse(readFileSync(snapshotPath!, "utf8")) as {
      threads: Array<Record<string, unknown>>;
      sections: Array<{ id: string; name: string }>;
    };
    const threads = raw.threads.map((t) => ({
      id: String(t.id),
      title: String(t.title ?? ""),
      parentThreadId: (t.parentThreadId as string | null) ?? null,
      sectionId: (t.sectionId as string | null) ?? null,
      isHidden: t.visibility === "hidden",
      isArchived: t.archivedAt != null,
      isPinned: t.pinnedAt != null,
      pinSortKey: null,
      hasPendingInteraction: false,
      latestAttentionAt: Number(t.latestAttentionAt ?? t.updatedAt ?? 0),
      createdAt: Number(t.createdAt ?? 0),
    }));
    const p = projectWorkstreams(threads, raw.sections, { now: Date.now() });
    const rendered = [...p.groups, p.unsorted, ...p.dormant].flatMap((g) =>
      g.rows.map((r) => r.thread.id),
    );
    const expected = threads
      .filter((t) => !t.isHidden && !t.isArchived)
      .map((t) => t.id)
      .sort();
    expect(rendered.length).toBe(expected.length);
    expect([...rendered].sort()).toEqual(expected);
  });
});

describe("needs-you folding", () => {
  const ask = new Set(["parent", "child", "late"]);
  const project = (parentAt: number) =>
    projectWorkstreams(
      [
        thread("parent", { sectionId: "sec_a", latestAttentionAt: parentAt }),
        thread("child", {
          parentThreadId: "parent",
          latestAttentionAt: now - 10,
        }),
        thread("late", {
          parentThreadId: "parent",
          latestAttentionAt: now + 10,
        }),
      ],
      sections,
      { now, needsYou: (t) => ask.has(t.id) },
    );

  it("folds an older child question into its parent's newer one", () => {
    const p = project(now);
    expect(p.needsYou.map((r) => r.thread.id)).toEqual(["late", "parent"]);
    expect(p.needsYouVia.get("parent")?.map((t) => t.id)).toEqual(["child"]);
    expect(p.groups[0]?.needsYou).toBe(2);
    // Folded rows still appear exactly once in their group.
    expect(rowIds(p.groups[0]!)).toEqual(["parent", "child", "late"]);
  });

  it("never folds a pending interaction or a same-time question", () => {
    const p = projectWorkstreams(
      [
        thread("parent", { sectionId: "sec_a", latestAttentionAt: now }),
        thread("approval", {
          parentThreadId: "parent",
          latestAttentionAt: now - 10,
          hasPendingInteraction: true,
        }),
        thread("tie", { parentThreadId: "parent", latestAttentionAt: now }),
      ],
      sections,
      { now, needsYou: () => true },
    );
    expect(p.needsYouVia.size).toBe(0);
    expect(p.needsYou).toHaveLength(3);
  });

  it("keeps a child's question that is newer than the parent's", () => {
    const p = project(now - 20);
    expect(p.needsYou.map((r) => r.thread.id)).toEqual([
      "late",
      "child",
      "parent",
    ]);
    expect(p.needsYouVia.size).toBe(0);
  });
});

describe("snoozed threads", () => {
  const threads = () => [
    thread("root", { sectionId: "sec_a", latestAttentionAt: now }),
    thread("kid", { parentThreadId: "root", latestAttentionAt: now }),
    thread("grandkid", { parentThreadId: "kid", latestAttentionAt: now }),
    thread("asks", {
      sectionId: "sec_a",
      latestAttentionAt: now - 5,
      hasPendingInteraction: true,
    }),
    thread("beta", { sectionId: "sec_b", latestAttentionAt: now - 1 }),
    thread("loose", { latestAttentionAt: now - 2 }),
  ];
  const project = (wake: Record<string, number | null>) =>
    projectWorkstreams(threads(), sections, {
      now,
      snoozedUntil: (t) => wake[t.id],
    });
  const ids = (rows: readonly { thread: { id: string } }[]) =>
    rows.map((r) => r.thread.id);

  it("moves a snoozed thread out of its group, Up Next, and Recent", () => {
    const p = project({ asks: now + 1000, beta: null });
    expect(rowIds(p.groups[0]!)).toEqual(["root", "kid", "grandkid"]);
    expect(p.groups[0]!.needsYou).toBe(0);
    expect(p.needsYou).toEqual([]);
    expect(ids(p.recent)).not.toContain("beta");
    expect(p.groups.find((g) => g.id === "sec_b")?.total).toBe(0);
    expect(p.dormant).toEqual([]);
    expect(ids(p.snoozed)).toEqual(["asks", "beta"]);
    expect(p.snoozed[0]!.workstreamId).toBe("sec_a");
  });

  it("takes a snoozed child's subtree along, with depths from the child", () => {
    const p = project({ kid: now + 1000 });
    expect(rowIds(p.groups[0]!)).toEqual(["root", "asks"]);
    expect(p.snoozed.map((r) => [r.thread.id, r.depth])).toEqual([
      ["kid", 0],
      ["grandkid", 1],
    ]);
    expect(p.rowOf.get("grandkid")?.workstreamId).toBe("sec_a");
  });

  it("lists the soonest to wake first and activity snoozes last", () => {
    const p = project({ loose: null, beta: now + 50, asks: now + 10 });
    expect(ids(p.snoozed)).toEqual(["asks", "beta", "loose"]);
    expect(p.unsorted.total).toBe(0);
  });

  it("still places every thread exactly once", () => {
    const p = project({ kid: now + 1, beta: null });
    const placed = [
      ...p.groups.flatMap((g) => rowIds(g)),
      ...p.dormant.flatMap((g) => rowIds(g)),
      ...rowIds(p.unsorted),
      ...ids(p.snoozed),
    ].sort();
    expect(placed).toEqual(
      threads()
        .map((t) => t.id)
        .sort(),
    );
  });
});

describe("prioritized workstreams", () => {
  const order = (prioritized: string[]) => ({
    workstreams: ["sec_a", "sec_b", "sec_empty"],
    threads: {},
    prioritized,
  });
  const threads = [
    thread("a1", { sectionId: "sec_a", latestAttentionAt: now - 1 }),
    thread("b1", { sectionId: "sec_b", latestAttentionAt: now - 2 }),
    thread("old", { sectionId: "sec_old", latestAttentionAt: 0 }),
  ];
  const all = [...sections, { id: "sec_old", name: "Old" }];

  it("pins prioritized workstreams first, in manual order, and never dormant", () => {
    const p = projectWorkstreams(threads, all, {
      now,
      order: order(["sec_old", "sec_b", "sec_empty", "unsorted"]),
    });
    expect(p.groups.map((g) => [g.id, g.prioritized])).toEqual([
      ["sec_b", true],
      ["sec_empty", true],
      ["sec_old", true],
      ["sec_a", false],
    ]);
    expect(p.dormant).toEqual([]);
    expect(p.unsorted.prioritized).toBe(false);
  });

  it("focuses Up Next on prioritized rows only while one is waiting", () => {
    const p = projectWorkstreams(threads, all, {
      now,
      needsYou: () => true,
      order: order(["sec_b"]),
    });
    const isPrioritized = (id: string | null) => id === "sec_b";
    const ids = (rows: readonly { thread: { id: string } }[]) =>
      rows.map((r) => r.thread.id);
    const focus = focusNeeds(p.needsYou, isPrioritized);
    expect(focus.active).toBe(true);
    expect(ids(focus.shown)).toEqual(["b1"]);
    expect(ids(focus.elsewhere)).toEqual(["a1", "old"]);

    // The open thread stays where it is.
    const kept = focusNeeds(
      p.needsYou,
      isPrioritized,
      (r) => r.thread.id === "a1",
    );
    expect(ids(kept.shown)).toEqual(["a1", "b1"]);
    expect(ids(kept.elsewhere)).toEqual(["old"]);

    const unfocused = focusNeeds(
      p.needsYou.filter((r) => r.workstreamId !== "sec_b"),
      isPrioritized,
    );
    expect(unfocused.active).toBe(false);
    expect(ids(unfocused.shown)).toEqual(["a1", "old"]);
  });
});
