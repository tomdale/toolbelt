import { afterEach, describe, expect, it, vi } from "vitest";
import { GOAL_MAX } from "../../src/domain/analysis.ts";
import {
  ADOPTED_KEY,
  ADOPTION_RATIONALE,
  adoptStoredGoals,
} from "../../src/server/adopt.ts";
import { getMeta } from "../../src/server/db.ts";
import type { InventoryThread } from "../../src/server/inventory.ts";
import { writeTitleRecord } from "../../src/server/titles.ts";
import { fakeWorld } from "./fake-bb.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await world?.harness.lifecycle.dispose();
  world = null;
});

const thread = (id: string, over: Partial<InventoryThread> = {}) =>
  ({
    id,
    title: `Opening words of ${id}`,
    ownTitle: null,
    projectId: "proj_1",
    status: "idle",
    sourceThreadId: null,
    parentThreadId: null,
    sectionId: null,
    isHidden: false,
    isArchived: false,
    isPinned: false,
    pinSortKey: null,
    hasPendingInteraction: false,
    latestAttentionAt: 10,
    createdAt: 1,
    ...over,
  }) as InventoryThread;

/** The adoption with its collaborators recorded. */
async function run(
  w: World,
  threads: InventoryThread[],
  stored: Record<string, { goal: string | null; revision: number }>,
  options: { enabled?: boolean; fail?: string[] } = {},
) {
  const titled: { id: string; goal: string; revision: number }[] = [];
  const logs: string[] = [];
  const adopted = await adoptStoredGoals({
    db: w.bb.storage.database(),
    threads: () => threads,
    analysis: (id) => stored[id],
    enabled: () => options.enabled ?? true,
    retitle: async (id, goal, revision, rationale) => {
      if (options.fail?.includes(id)) throw new Error("BB is down");
      expect(rationale).toBe(ADOPTION_RATIONALE);
      titled.push({ id, goal, revision });
      return { entry: {} };
    },
    log: (message) => logs.push(message),
  });
  return { adopted, titled, logs };
}

const done = (w: World) => getMeta(w.bb.storage.database(), ADOPTED_KEY);

describe("adopting stored goals as titles", () => {
  it("titles the idle threads BB never titled, from the goal already stored", async () => {
    world = await fakeWorld();
    const { adopted, titled } = await run(world, [thread("a"), thread("b")], {
      a: { goal: "Ship the mobile home screen", revision: 10 },
      b: { goal: "Fix stale build cache", revision: 7 },
    });
    expect(adopted).toBe(2);
    expect(titled).toEqual([
      { id: "a", goal: "Ship the mobile home screen", revision: 10 },
      { id: "b", goal: "Fix stale build cache", revision: 7 },
    ]);
    expect(done(world)).toBe("1");
  });

  it("leaves titled, running, hidden and archived threads alone", async () => {
    world = await fakeWorld();
    writeTitleRecord(world.bb.storage.database(), "locked", {
      observed: "Mine",
      written: null,
      retitledAt: null,
      provisional: false,
    });
    const goal = { goal: "Some goal", revision: 10 };
    const { titled } = await run(
      world,
      [
        thread("titled", { ownTitle: "Already named" }),
        thread("running", { status: "active" }),
        thread("hidden", { isHidden: true }),
        thread("archived", { isArchived: true }),
        thread("locked"),
        thread("fresh"),
      ],
      Object.fromEntries(
        ["titled", "running", "hidden", "archived", "locked", "fresh"].map(
          (id) => [id, goal],
        ),
      ),
    );
    expect(titled.map((t) => t.id)).toEqual(["locked", "fresh"]);
  });

  it("skips a thread with no usable stored goal", async () => {
    world = await fakeWorld();
    const { titled } = await run(
      world,
      [thread("none"), thread("empty"), thread("long"), thread("ok")],
      {
        empty: { goal: null, revision: 10 },
        long: { goal: "x".repeat(GOAL_MAX + 1), revision: 10 },
        ok: { goal: "x".repeat(GOAL_MAX), revision: 10 },
      },
    );
    expect(titled.map((t) => t.id)).toEqual(["ok"]);
  });

  it("does not spend the pass on an empty inventory", async () => {
    world = await fakeWorld();
    const none = await run(world, [], {});
    expect(none.adopted).toBe(0);
    expect(done(world)).toBeNull();
  });

  it("makes the pass once", async () => {
    world = await fakeWorld();
    const stored = { a: { goal: "Ship it", revision: 10 } };
    expect((await run(world, [thread("a")], stored)).adopted).toBe(1);
    // A thread whose title is cleared later is not adopted again.
    const again = await run(world, [thread("a")], stored);
    expect(again.adopted).toBe(0);
    expect(again.titled).toEqual([]);
  });

  it("waits for Keep titles current rather than spending the pass", async () => {
    world = await fakeWorld();
    const stored = { a: { goal: "Ship it", revision: 10 } };
    const off = await run(world, [thread("a")], stored, { enabled: false });
    expect(off.titled).toEqual([]);
    expect(done(world)).toBeNull();
    expect((await run(world, [thread("a")], stored)).adopted).toBe(1);
  });

  it("repeats a pass that hit a BB failure, and skips the thread that failed", async () => {
    world = await fakeWorld();
    const stored = {
      a: { goal: "Ship it", revision: 10 },
      b: { goal: "Fix it", revision: 10 },
    };
    const first = await run(world, [thread("a"), thread("b")], stored, {
      fail: ["a"],
    });
    expect(first.titled.map((t) => t.id)).toEqual(["b"]);
    expect(first.logs[0]).toContain("a failed");
    expect(done(world)).toBeNull();
    const second = await run(world, [thread("a"), thread("b")], stored);
    expect(second.titled.map((t) => t.id)).toEqual(["a", "b"]);
    expect(done(world)).toBe("1");
  });
});

describe("adopting through the plugin", () => {
  const stored = (goal: string, revision: number) =>
    JSON.stringify({
      recap: "prior",
      state: "in_progress",
      needsYou: null,
      subject: null,
      title: "Legacy inferred title",
      goal,
      drift: null,
      driftSectionId: null,
      revision,
      at: 1,
      model: "test",
    });
  const seed = (w: World, id: string, goal: string, revision: number) =>
    w.bb.storage
      .database()
      .prepare(
        "INSERT INTO ws_analysis (thread_id, revision, at, result) VALUES (?, ?, 1, ?)",
      )
      .run(id, revision, stored(goal, revision));

  it("titles each eligible thread with an Undo entry, then stays quiet", async () => {
    const w = (world = await fakeWorld());
    w.addThread("untitled", {
      title: null,
      titleFallback: "Opening words of the first request",
      status: "idle",
      latestAttentionAt: 10,
      updatedAt: 10,
    });
    w.addThread("named", {
      title: "Chosen by the user",
      status: "idle",
      latestAttentionAt: 10,
      updatedAt: 10,
    });
    w.addThread("running", {
      title: null,
      status: "active",
      latestAttentionAt: 10,
      updatedAt: 10,
    });
    seed(w, "untitled", "Ship the mobile home screen", 10);
    seed(w, "named", "Some other goal", 10);
    seed(w, "running", "Still going", 10);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await w.harness.behavior.emitThreadEvent("thread.created", {
      thread: w.threads.get("untitled")!,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    for (let i = 0; i < 80; i++) await Promise.resolve();

    expect(w.threads.get("untitled")!.title).toBe(
      "Ship the mobile home screen",
    );
    expect(w.threads.get("named")!.title).toBe("Chosen by the user");
    expect(w.threads.get("running")!.title).toBeNull();
    const { entries } = (await w.harness.behavior.callRpc("journal", {})) as {
      entries: {
        action: string;
        rationale: string;
        undo: { kind: string; from: string | null; to: string } | null;
      }[];
    };
    const retitles = entries.filter((e) => e.action === "retitle");
    expect(retitles).toHaveLength(1);
    expect(retitles[0]!.rationale).toBe(ADOPTION_RATIONALE);
    expect(retitles[0]!.undo).toMatchObject({
      kind: "retitle",
      from: null,
      to: "Ship the mobile home screen",
    });
    expect(done(w)).toBe("1");
  });
});
