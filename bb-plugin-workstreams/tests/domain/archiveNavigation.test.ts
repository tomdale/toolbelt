import { expect, it } from "vitest";
import {
  nextThreadAfterArchive,
  nextUpNextThread,
  nextUpNextThreadAfterArchive,
} from "../../src/domain/archiveNavigation.ts";
import { projectWorkstreams, DAY_MS } from "../../src/domain/project.ts";
import { thread } from "./fixtures.ts";

const sections = [{ id: "ws", name: "Workstream" }];
const threads = [
  thread("first", { sectionId: "ws", latestAttentionAt: 300 }),
  thread("child", { parentThreadId: "first", sectionId: "elsewhere" }),
  thread("last", { sectionId: "ws", latestAttentionAt: 100 }),
  thread("elsewhere", { latestAttentionAt: 200 }),
];

it.each([0, 100 * DAY_MS])(
  "follows tree order in active and dormant groups (%s)",
  (now) => {
    const projection = projectWorkstreams(threads, sections, { now });
    expect(nextThreadAfterArchive(projection, "first")).toBe("last");
    expect(nextThreadAfterArchive(projection, "child")).toBe("last");
    expect(nextThreadAfterArchive(projection, "last")).toBe("first");
    expect(nextThreadAfterArchive(projection, "elsewhere")).toBeNull();
    expect(nextThreadAfterArchive(projection, "missing")).toBeNull();
  },
);

it("respects manual ordering", () => {
  const projection = projectWorkstreams(threads, sections, {
    now: 0,
    order: {
      workstreams: [],
      threads: { ws: ["last", "first"] },
      prioritized: [],
    },
  });
  expect(nextThreadAfterArchive(projection, "last")).toBe("first");
  expect(nextThreadAfterArchive(projection, "first")).toBe("last");
});

it("does not select hidden, archived, snoozed threads or the archived subtree", () => {
  const projection = projectWorkstreams(
    [
      ...threads.filter((t) => t.id !== "last"),
      thread("hidden", { sectionId: "ws", isHidden: true }),
      thread("archived", { sectionId: "ws", isArchived: true }),
      thread("snoozed", { sectionId: "ws" }),
    ],
    sections,
    { now: 0, snoozedUntil: (t) => (t.id === "snoozed" ? null : undefined) },
  );
  expect(nextThreadAfterArchive(projection, "first")).toBeNull();
});

const kindOf = (thread: { hasPendingInteraction: boolean }) =>
  thread.hasPendingInteraction ? ("question" as const) : ("other" as const);
/** Up Next options; open questions never age, so the clock doesn't matter. */
const upNext = (prioritized: string[] = []) => ({
  kindOf,
  now: 0,
  prioritized: new Set(prioritized),
});

it("prefers Up Next and cycles through visible Up Next rows", () => {
  const projection = projectWorkstreams(
    [
      thread("archived", { sectionId: "ws", hasPendingInteraction: true }),
      thread("waiting-first", {
        sectionId: "ws",
        hasPendingInteraction: true,
        latestAttentionAt: 200,
      }),
      thread("waiting-second", {
        sectionId: "ws",
        hasPendingInteraction: true,
        latestAttentionAt: 100,
      }),
      thread("quiet", { sectionId: "ws", latestAttentionAt: 900 }),
    ],
    sections,
    { now: 0 },
  );
  expect(nextUpNextThreadAfterArchive(projection, "archived", upNext())).toBe(
    "waiting-first",
  );
  expect(nextUpNextThread(projection, null, upNext())?.thread.id).toBe(
    "archived",
  );
  expect(
    nextUpNextThread(projection, "waiting-first", upNext())?.thread.id,
  ).toBe("waiting-second");
  // Threads not blocked on you follow, then the list wraps.
  expect(
    nextUpNextThread(projection, "waiting-second", upNext())?.thread.id,
  ).toBe("quiet");
  expect(nextUpNextThread(projection, "quiet", upNext())?.thread.id).toBe(
    "archived",
  );
});

it("leaves the archive destination to the workstream when nothing at the top of Up Next wants you", () => {
  const projection = projectWorkstreams(
    [
      thread("archived", { sectionId: "ws", latestAttentionAt: 300 }),
      thread("read", { latestAttentionAt: 200 }),
      thread("unread", { isUnread: true, latestAttentionAt: 100 }),
    ],
    sections,
    { now: 0 },
  );
  expect(nextUpNextThreadAfterArchive(projection, "archived", upNext())).toBe(
    "unread",
  );
  expect(
    nextUpNextThreadAfterArchive(
      projectWorkstreams(
        [thread("archived", { sectionId: "ws" }), thread("read")],
        sections,
        { now: 0 },
      ),
      "archived",
      upNext(),
    ),
  ).toBeNull();
});

it("starts at the top for a thread Up Next doesn't list", () => {
  const projection = projectWorkstreams(
    [
      thread("ask", { hasPendingInteraction: true, latestAttentionAt: 1 }),
      ...Array.from({ length: 6 }, (_, i) =>
        thread(`quiet${i}`, { latestAttentionAt: 100 - i }),
      ),
    ],
    sections,
    { now: 0 },
  );
  expect(nextUpNextThread(projection, "quiet5", upNext())?.thread.id).toBe(
    "ask",
  );
  expect(
    nextUpNextThread(
      projectWorkstreams([thread("only")], sections, { now: 0 }),
      "only",
      upNext(),
    ),
  ).toBeNull();
});

it("skips nested threads in Up Next navigation and after archiving", () => {
  const projection = projectWorkstreams(
    [
      thread("child", {
        parentThreadId: "first",
        hasPendingInteraction: true,
        latestAttentionAt: 400,
      }),
      thread("orphan", {
        parentThreadId: "missing",
        hasPendingInteraction: true,
        latestAttentionAt: 300,
      }),
      thread("first", {
        hasPendingInteraction: true,
        latestAttentionAt: 200,
      }),
      thread("second", {
        hasPendingInteraction: true,
        latestAttentionAt: 100,
      }),
    ],
    sections,
    { now: 0 },
  );
  expect(nextUpNextThread(projection, null, upNext())?.thread.id).toBe("first");
  expect(nextUpNextThread(projection, "first", upNext())?.thread.id).toBe(
    "second",
  );
  expect(nextUpNextThreadAfterArchive(projection, "first", upNext())).toBe(
    "second",
  );
  expect(
    nextUpNextThreadAfterArchive(
      projectWorkstreams(
        [thread("first"), thread("child", { parentThreadId: "first" })],
        sections,
        { now: 0 },
      ),
      "first",
      upNext(),
    ),
  ).toBeNull();
});

it("follows focus on prioritized workstreams", () => {
  const projection = projectWorkstreams(
    [
      thread("elsewhere", {
        hasPendingInteraction: true,
        latestAttentionAt: 9,
      }),
      thread("focused", {
        sectionId: "ws",
        hasPendingInteraction: true,
        latestAttentionAt: 1,
      }),
    ],
    sections,
    { now: 0 },
  );
  expect(nextUpNextThread(projection, null, upNext(["ws"]))?.thread.id).toBe(
    "focused",
  );
  expect(nextUpNextThread(projection, "focused", upNext(["ws"]))).toBeNull();
  expect(
    nextUpNextThreadAfterArchive(projection, "focused", upNext(["ws"])),
  ).toBe("elsewhere");
});

it("advances within Unfiled", () => {
  const projection = projectWorkstreams(
    [
      thread("a", { latestAttentionAt: 200 }),
      thread("b", { latestAttentionAt: 100 }),
    ],
    [],
    { now: 0 },
  );
  expect(nextThreadAfterArchive(projection, "a")).toBe("b");
  expect(nextThreadAfterArchive(projection, "b")).toBe("a");
});
