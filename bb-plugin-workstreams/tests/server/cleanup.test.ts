import { afterEach, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import {
  ARCHIVE_GRACE_MS,
  cleanupCandidate,
} from "../../src/server/cleanup.ts";
import type { BootstrapState } from "../../src/server/bootstrap.ts";
let world: Awaited<ReturnType<typeof fakeWorld>> | undefined;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = undefined;
});
const section = { id: "s", name: "Old work" };
it("uses the newest archive timestamp, strictly older than 24 hours", () => {
  const now = 100 * ARCHIVE_GRACE_MS;
  const member = (id: string, archivedAt: number | null) => ({
    id,
    archivedAt,
    sectionId: "s",
  });
  expect(cleanupCandidate(section, [], now)).not.toBeNull();
  expect(cleanupCandidate(section, [member("t", null)], now)).toBeNull();
  expect(
    cleanupCandidate(section, [member("t", now - ARCHIVE_GRACE_MS)], now),
  ).toBeNull();
  expect(
    cleanupCandidate(section, [member("t", now - ARCHIVE_GRACE_MS - 1)], now),
  ).not.toBeNull();
  expect(
    cleanupCandidate(
      section,
      [member("old", 1), member("recent", now - 1000)],
      now,
    ),
  ).toBeNull();
});
async function setup() {
  world = await fakeWorld({
    complete: ({ prompt }) => {
      if (prompt.includes("Snapshot:\n")) {
        const input = JSON.parse(prompt.split("Snapshot:\n")[1]!);
        return JSON.stringify({
          workstreams: [],
          assignments: input.threads.map((t: { id: string }) => ({
            threadId: t.id,
            workstream: null,
            reason: "No current home",
          })),
        });
      }
      return JSON.stringify({ recap: "Done", state: "done", subject: null });
    },
  });
  const w = world;
  const empty = w.addSection("Empty");
  const old = w.addSection("Archived product");
  const recent = w.addSection("Recent archives");
  const hidden = w.addSection("Hidden active work");
  for (let i = 0; i < 105; i++)
    w.addThread(`old${i}`, {
      sectionId: old.id,
      archivedAt: Date.now() - 2 * ARCHIVE_GRACE_MS,
      visibility: i % 2 ? "hidden" : "visible",
    });
  w.addThread("recent", {
    sectionId: recent.id,
    archivedAt: Date.now() - 1000,
  });
  w.addThread("hidden", { sectionId: hidden.id, visibility: "hidden" });
  await w.harness.behavior.callRpc("refresh", null);
  return { w, empty, old, recent, hidden };
}
async function run(w: NonNullable<typeof world>, action: string, extra = {}) {
  return (
    (await w.harness.behavior.callRpc("bootstrap", { action, ...extra })) as {
      state: BootstrapState;
    }
  ).state;
}
it("previews empty and old archived-only removals, pages hidden archives, applies and undoes without deleting threads", async () => {
  const { w, empty, old, recent, hidden } = await setup();
  const preview = await run(w, "start");
  expect(preview.preview!.removals.map((r) => r.sectionId).sort()).toEqual(
    [empty.id, old.id].sort(),
  );
  expect(
    preview.preview!.removals.find((r) => r.sectionId === old.id)!
      .archivedThreads,
  ).toHaveLength(105);
  expect(w.sections).toHaveLength(4);
  const applied = await run(w, "apply", {
    runId: preview.startedAt,
    overrides: [],
  });
  expect(applied.status).toBe("applied");
  expect(w.sections.map((s) => s.id)).toEqual([recent.id, hidden.id]);
  expect(w.threads.size).toBe(107);
  expect(w.threads.get("old0")?.sectionId).toBeNull();
  await w.harness.behavior.callRpc("undo", { entryId: applied.entryId });
  const restored = w.sections.find((s) => s.name === old.name)!;
  expect(restored.id).not.toBe(old.id);
  expect(
    [...w.threads.values()].filter((t) => t.sectionId === restored.id),
  ).toHaveLength(105);
});
it("journals completed deletions when a later cleanup fails, so they remain undoable", async () => {
  const { w, empty, old } = await setup();
  const preview = await run(w, "start");
  w.harness.inspection.sdk.stub(
    "threadSections.delete",
    async ({ id }: { id: string }) => {
      if (id === empty.id) throw new Error("Deletion failed");
      const i = w.sections.findIndex((s) => s.id === id);
      w.sections.splice(i, 1);
      for (const [key, t] of w.threads)
        if (t.sectionId === id) w.threads.set(key, { ...t, sectionId: null });
      return { id, name: old.name, updatedThreadCount: 105 };
    },
  );
  const result = await run(w, "apply", {
    runId: preview.startedAt,
    overrides: [],
  });
  expect(result.status).toBe("failed");
  const { entries } = (await w.harness.behavior.callRpc("journal", {})) as {
    entries: { id: string; status: string; action: string }[];
  };
  const failed = entries.find(
    (e) => e.action === "batch" && e.status === "failed",
  )!;
  expect(failed).toBeTruthy();
  await w.harness.behavior.callRpc("undo", { entryId: failed.id });
  expect(w.sections.some((s) => s.name === empty.name)).toBe(true);
  expect(w.sections.some((s) => s.name === old.name)).toBe(true);
});
it("keeps a previewed removal when a hidden active thread appears before Apply", async () => {
  const { w, empty } = await setup();
  const preview = await run(w, "start");
  w.addThread("new-hidden", { sectionId: empty.id, visibility: "hidden" });
  const applied = await run(w, "apply", {
    runId: preview.startedAt,
    overrides: [],
  });
  expect(applied.error).toContain("no longer qualified");
  expect(w.sections.some((s) => s.id === empty.id)).toBe(true);
  expect(w.threads.get("new-hidden")?.sectionId).toBe(empty.id);
});
it("keeps a home when an archived member was recently rearchived", async () => {
  const { w, old } = await setup();
  const preview = await run(w, "start");
  w.threads.set("old0", { ...w.threads.get("old0")!, archivedAt: Date.now() });
  const applied = await run(w, "apply", {
    runId: preview.startedAt,
    overrides: [],
  });
  expect(applied.error).toContain("no longer qualified");
  expect(w.sections.some((s) => s.id === old.id)).toBe(true);
});
it("does not merge restored membership into a conflicting namesake", async () => {
  const { w, old } = await setup();
  const preview = await run(w, "start");
  const applied = await run(w, "apply", {
    runId: preview.startedAt,
    overrides: [],
  });
  const namesake = w.addSection(old.name);
  await w.harness.behavior.callRpc("undo", { entryId: applied.entryId });
  expect([...w.threads.values()].some((t) => t.sectionId === namesake.id)).toBe(
    false,
  );
});
it("does not overwrite reassigned or unarchived members during Undo", async () => {
  const { w, old, recent } = await setup();
  const preview = await run(w, "start");
  const applied = await run(w, "apply", {
    runId: preview.startedAt,
    overrides: [],
  });
  w.threads.set("old0", { ...w.threads.get("old0")!, sectionId: recent.id });
  w.threads.set("old1", { ...w.threads.get("old1")!, archivedAt: null });
  await w.harness.behavior.callRpc("undo", { entryId: applied.entryId });
  expect(w.threads.get("old0")?.sectionId).toBe(recent.id);
  expect(w.threads.get("old1")?.sectionId).toBeNull();
  expect(w.sections.some((s) => s.name === old.name)).toBe(true);
});
