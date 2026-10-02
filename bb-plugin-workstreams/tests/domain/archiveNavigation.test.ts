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
    ],
    sections,
    { now: 0 },
  );
  expect(nextUpNextThreadAfterArchive(projection, "archived")).toBe(
    "waiting-first",
  );
  expect(nextUpNextThread(projection, "waiting-first")?.thread.id).toBe(
    "waiting-second",
  );
  expect(nextUpNextThread(projection, "waiting-second")?.thread.id).toBe(
    "archived",
  );
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
