import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  UNSORTED_ID,
  projectWorkstreams,
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
    ]);
    expect(p.rowOf.get("child")?.workstreamId).toBe("sec_a");
    expect(p.rowOf.get("child")?.depth).toBe(1);
  });

  it("keeps BB's section order and moves empty sections to dormant", () => {
    const p = projectWorkstreams(
      [
        thread("b1", { sectionId: "sec_b", latestAttentionAt: now }),
        thread("a1", { sectionId: "sec_a", latestAttentionAt: now - 1 }),
      ],
      sections,
      { now },
    );
    expect(p.groups.map((g) => g.id)).toEqual(["sec_a", "sec_b"]);
    expect(p.dormant.map((g) => g.id)).toEqual(["sec_empty"]);
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
    expect(p.groups.map((g) => g.id)).toEqual(["sec_b"]);
    expect(p.dormant.map((g) => g.id)).toEqual(["sec_a", "sec_empty"]);
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
    expect(rankGroups(p.groups).map((g) => g.id)).toEqual(["sec_b", "sec_a"]);
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
