import { describe, expect, it } from "vitest";
import { DAY_MS, projectWorkstreams } from "../../src/domain/project.ts";
import type { UpNextKind } from "../../src/domain/status.ts";
import {
  UP_NEXT_LIMIT,
  UP_NEXT_MAX,
  holdInPlace,
  selectRecent,
  selectUpNext,
} from "../../src/domain/upNext.ts";
import { thread, type TestThread } from "./fixtures.ts";

const now = 100 * DAY_MS;
const sections = [
  { id: "sec_a", name: "Alpha" },
  { id: "sec_b", name: "Beta" },
];
const ids = (rows: readonly { thread: { id: string } }[]) =>
  rows.map((row) => row.thread.id);

/**
 * A thread named for its tier: `q`uestion, `r`eview, or `o`ther, then `u`nread
 * or `r`ead, then a suffix, e.g. `qu1`. `at` is its latest attention.
 */
function t(id: string, at: number, overrides: Partial<TestThread> = {}) {
  return thread(id, {
    sectionId: "sec_a",
    isUnread: id[1] === "u",
    latestAttentionAt: at,
    ...overrides,
  });
}
const kindOf = (thread: { id: string }): UpNextKind =>
  thread.id[0] === "q" ? "question" : thread.id[0] === "r" ? "review" : "other";

function upNext(
  threads: readonly TestThread[],
  options: {
    snoozedUntil?: (thread: TestThread) => number | null | undefined;
    exclude?: (thread: TestThread) => boolean;
  } = {},
) {
  const projection = projectWorkstreams(threads, sections, {
    now,
    snoozedUntil: options.snoozedUntil,
  });
  return ids(
    selectUpNext(projection, { kindOf, exclude: options.exclude }).rows,
  );
}

describe("selectUpNext", () => {
  it("ranks by tier, then newest first within a tier", () => {
    // A read question outranks no unread one, however recent.
    expect(
      upNext([
        t("rr1", 700),
        t("qr1", 900),
        t("ru1", 500),
        t("qu1", 100),
        t("qu2", 200),
      ]),
    ).toEqual(["qu2", "qu1", "ru1", "qr1", "rr1"]);
  });

  it("ranks threads not blocked on you last, unread before read", () => {
    expect(upNext([t("or1", 900), t("ou1", 800), t("rr1", 1)])).toEqual([
      "rr1",
      "ou1",
      "or1",
    ]);
  });

  it("lists every thread while there are few", () => {
    expect(upNext([t("or1", 1), t("or2", 2), t("ou1", 3)])).toEqual([
      "ou1",
      "or2",
      "or1",
    ]);
  });

  it("drops read threads not blocked on you first, least urgent first", () => {
    expect(
      upNext([
        t("qu1", 10),
        t("ou1", 9),
        t("ou2", 8),
        t("or1", 7),
        t("or2", 6),
        t("or3", 5),
      ]),
    ).toEqual(["qu1", "ou1", "ou2", "or1", "or2"]);
  });

  it("drops unread threads not blocked on you once the read ones are gone", () => {
    expect(
      upNext([
        t("qr1", 10),
        t("rr1", 9),
        t("qu1", 8),
        t("or1", 99),
        t("ou1", 7),
        t("ou2", 6),
        t("ou3", 5),
      ]),
    ).toEqual(["qu1", "qr1", "rr1", "ou1", "ou2"]);
  });

  it("grows past five for threads blocked on you, read ones included", () => {
    expect(
      upNext([
        t("qu1", 10),
        t("ru1", 9),
        t("qr1", 8),
        t("qr2", 7),
        t("rr1", 6),
        t("rr2", 5),
        t("ou1", 99),
        t("or1", 98),
      ]),
    ).toEqual(["qu1", "ru1", "qr1", "qr2", "rr1", "rr2"]);
  });

  it("drops read blocked threads, least urgent first, down to ten", () => {
    const unread = Array.from({ length: 6 }, (_, i) => t(`qu${i}`, 100 - i));
    const read = [
      t("qr1", 50),
      t("qr2", 49),
      t("rr1", 200),
      t("rr2", 48),
      t("rr3", 47),
    ];
    const shown = upNext([...unread, ...read, t("ou1", 300)]);
    expect(shown).toHaveLength(UP_NEXT_MAX);
    expect(shown).toEqual([
      ...unread.map((thread) => thread.id),
      "qr1",
      "qr2",
      "rr1",
      "rr2",
    ]);
  });

  it("keeps only the ten most recently active once unread blocked threads alone exceed ten", () => {
    // Older unread questions leave even though they outrank newer reviews.
    const questions = Array.from({ length: 8 }, (_, i) => t(`qu${i}`, 100 + i));
    const reviews = Array.from({ length: 4 }, (_, i) => t(`ru${i}`, 200 + i));
    const shown = upNext([...questions, ...reviews, t("qr1", 999)]);
    expect(shown).toEqual([
      "qu7",
      "qu6",
      "qu5",
      "qu4",
      "qu3",
      "qu2",
      "ru3",
      "ru2",
      "ru1",
      "ru0",
    ]);
  });

  it("leaves out snoozed, archived, hidden, and excluded threads", () => {
    expect(
      upNext(
        [
          t("qu1", 1),
          t("qu2", 2, { isArchived: true }),
          t("qu3", 3, { isHidden: true }),
          t("qu4", 4),
          t("qu5", 5),
        ],
        {
          snoozedUntil: (thread) =>
            thread.id === "qu4" ? now + DAY_MS : undefined,
          exclude: (thread) => thread.id === "qu5",
        },
      ),
    ).toEqual(["qu1"]);
  });

  it("lists only top-level threads, even when a parent is missing", () => {
    expect(
      upNext([
        t("or1", 1),
        t("qu1", 5, { parentThreadId: "or1" }),
        t("qu2", 6, { parentThreadId: "missing" }),
        t("qu3", 7, { parentThreadId: "archived" }),
        t("or2", 2, { id: "archived", isArchived: true }),
      ]),
    ).toEqual(["or1"]);
  });

  it("lists Unfiled and dormant threads too", () => {
    const old = now - 60 * DAY_MS;
    const projection = projectWorkstreams(
      [
        t("qu1", now - 1, { sectionId: null }),
        t("ru1", old, { sectionId: "sec_b" }),
      ],
      sections,
      { now },
    );
    expect(projection.dormant.map((group) => group.id)).toEqual(["sec_b"]);
    expect(ids(selectUpNext(projection, { kindOf }).rows)).toEqual([
      "qu1",
      "ru1",
    ]);
  });

  it("focuses on prioritized workstreams while one has a thread blocked on you", () => {
    const projection = projectWorkstreams(
      [
        t("rr1", 1, { sectionId: "sec_b" }),
        t("or1", 2, { sectionId: "sec_b" }),
        t("qu1", 9, { sectionId: "sec_a" }),
        t("ru1", 8, { sectionId: "sec_a" }),
        t("ou1", 7, { sectionId: null }),
      ],
      sections,
      { now },
    );
    const focused = selectUpNext(projection, {
      kindOf,
      prioritized: new Set(["sec_b"]),
    });
    expect(focused.focused).toBe(true);
    // The rules then apply to prioritized threads alone.
    expect(ids(focused.rows)).toEqual(["rr1", "or1"]);
    expect(ids(focused.elsewhere)).toEqual(["qu1", "ru1"]);
  });

  it("doesn't focus while prioritized workstreams have nothing blocked on you", () => {
    const projection = projectWorkstreams(
      [
        t("ou1", 9, { sectionId: "sec_b" }),
        t("qr1", 1, { sectionId: "sec_a" }),
      ],
      sections,
      { now },
    );
    const selection = selectUpNext(projection, {
      kindOf,
      prioritized: new Set(["sec_b"]),
    });
    expect(selection.focused).toBe(false);
    expect(ids(selection.rows)).toEqual(["qr1", "ou1"]);
    expect(selection.elsewhere).toEqual([]);
  });

  it("trims to five and caps at ten", () => {
    expect([UP_NEXT_LIMIT, UP_NEXT_MAX]).toEqual([5, 10]);
  });
});

describe("selectRecent", () => {
  it("carries on past Up Next with the newest top-level threads it leaves out", () => {
    const threads = [
      ...Array.from({ length: 8 }, (_, i) => t(`or${i}`, 100 - i)),
      t("qu1", 1),
      t("child", 999, { parentThreadId: "or0" }),
      t("snoozed", 998),
    ];
    const projection = projectWorkstreams(threads, sections, {
      now,
      snoozedUntil: (thread) => (thread.id === "snoozed" ? null : undefined),
    });
    const shown = selectUpNext(projection, { kindOf }).rows;
    expect(ids(shown)).toEqual(["qu1", "or0", "or1", "or2", "or3"]);
    expect(ids(selectRecent(projection, shown, 3))).toEqual([
      "or4",
      "or5",
      "or6",
    ]);
  });

  it("leaves out whatever Up Next draws, including a held row", () => {
    const projection = projectWorkstreams(
      [t("or1", 3), t("or2", 2), t("or3", 1)],
      sections,
      { now },
    );
    const held = projection.rowOf.get("or2")!;
    expect(ids(selectRecent(projection, [held], 5))).toEqual(["or1", "or3"]);
  });
});

describe("holdInPlace", () => {
  const projection = projectWorkstreams(
    [t("or1", 3), t("or2", 2), t("or3", 1)],
    sections,
    { now },
  );
  const row = (id: string) => projection.rowOf.get(id)!;
  const rows = [row("or1"), row("or2")];

  it("moves a listed row back to where it was", () => {
    expect(ids(holdInPlace(rows, row("or2"), 0))).toEqual(["or2", "or1"]);
  });

  it("keeps a row the list dropped, at its old place or last", () => {
    expect(ids(holdInPlace(rows, row("or3"), 1))).toEqual([
      "or1",
      "or3",
      "or2",
    ]);
    expect(ids(holdInPlace(rows, row("or3"), 7))).toEqual([
      "or1",
      "or2",
      "or3",
    ]);
  });

  it("holds nothing without a row or a place", () => {
    expect(ids(holdInPlace(rows, undefined, 0))).toEqual(["or1", "or2"]);
    expect(ids(holdInPlace(rows, row("or3"), -1))).toEqual(["or1", "or2"]);
  });
});
