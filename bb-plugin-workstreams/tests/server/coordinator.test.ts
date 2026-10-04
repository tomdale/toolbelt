import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { CorpusStore } from "../../src/server/corpus.ts";
import { openDatabase } from "../../src/server/db.ts";
import type { LiveOrganization } from "../../src/server/contract.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;

afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

const getOrg = async (w: World): Promise<LiveOrganization> => {
  const result = (await w.harness.behavior.callRpc("organization", null)) as {
    state: LiveOrganization;
  };
  return result.state;
};

const rebuildOrg = async (w: World): Promise<LiveOrganization> => {
  const result = (await w.harness.behavior.callRpc("organization", {
    action: "rebuild",
  })) as { state: LiveOrganization };
  return result.state;
};

describe("automatic update coordinator lifecycle", () => {
  it("initial populate: classifies missing roots, derives groups, and syncs native sections", async () => {
    let lanternId = "";
    world = await fakeWorld({
      complete: ({ prompt }) => {
        if (prompt.includes("Classify the most specific")) {
          return JSON.stringify({ subjectId: lanternId, proposed: null });
        }
        return JSON.stringify({
          recap: "working",
          state: "in_progress",
          subject: "Lantern",
        });
      },
    });

    const w = world;
    const corpus = new CorpusStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");
    lanternId = lantern.id;

    w.addThread("t1", { title: "Lantern core fix", sectionId: null });
    w.addThread("t2", { title: "Lantern styling", sectionId: null });

    const state = await rebuildOrg(w);

    expect(state.status).toBe("idle");
    expect(state.counts.activeRoots).toBe(2);
    expect(state.counts.activeWorkstreams).toBe(1);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]!.name).toBe("Lantern");

    // Native section synced
    const section = w.sections.find((s) => s.name === "Lantern");
    expect(section).toBeDefined();
    expect(w.threads.get("t1")?.sectionId).toBe(section!.id);
    expect(w.threads.get("t2")?.sectionId).toBe(section!.id);
  });

  it("new root: automatically classifies new thread and updates placement", async () => {
    let lanternId = "";
    world = await fakeWorld({
      complete: ({ prompt }) => {
        if (prompt.includes("Classify the most specific")) {
          return JSON.stringify({ subjectId: lanternId, proposed: null });
        }
        return JSON.stringify({
          recap: "working",
          state: "in_progress",
          subject: "Lantern",
        });
      },
    });

    const w = world;
    const corpus = new CorpusStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");
    lanternId = lantern.id;

    w.addThread("t1", { title: "Lantern task 1" });
    await rebuildOrg(w);

    // Add new thread
    w.addThread("t2", { title: "Lantern task 2" });
    await w.harness.behavior.emitThreadEvent("thread.created", {
      thread: w.threads.get("t2")!,
    });

    // Rebuild/trigger
    const state = await rebuildOrg(w);
    expect(state.counts.activeRoots).toBe(2);
    const section = w.sections.find((s) => s.name === "Lantern")!;
    expect(w.threads.get("t2")?.sectionId).toBe(section.id);
  });

  it("correct identity: manual assignment is authoritative and moves the root", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new CorpusStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");
    const compass = corpus.create("Compass", "Product");

    w.addThread("t1", { title: "Ambiguous task" });
    // Initially assign to Lantern
    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "t1",
      entityId: lantern.id,
    });
    let state = await rebuildOrg(w);
    const lanternSec = w.sections.find((s) => s.name === "Lantern")!;
    expect(w.threads.get("t1")?.sectionId).toBe(lanternSec.id);

    // Manually reassign to Compass
    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "t1",
      entityId: compass.id,
    });
    state = await rebuildOrg(w);
    const compassSec = w.sections.find((s) => s.name === "Compass")!;
    expect(w.threads.get("t1")?.sectionId).toBe(compassSec.id);
    expect(state.groups.find((g) => g.name === "Compass")).toBeDefined();
  });

  it("archive: removes archived thread from active navigation and cleans up empty section", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new CorpusStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");

    w.addThread("t1", { title: "Lantern task" });
    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "t1",
      entityId: lantern.id,
    });
    await rebuildOrg(w);
    expect(w.sections.some((s) => s.name === "Lantern")).toBe(true);

    // Archive the thread
    const t1 = w.threads.get("t1")!;
    t1.archivedAt = Date.now();
    await w.harness.behavior.emitThreadEvent("thread.archived", { thread: t1 });

    const state = await rebuildOrg(w);
    expect(state.counts.activeRoots).toBe(0);
    expect(state.groups).toHaveLength(0);
    // Unused empty section cleaned up
    expect(w.sections.some((s) => s.name === "Lantern")).toBe(false);
  });

  it("done and return-to-active: done task has 0 expansion pressure; return-to-active restores pressure", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);
    const lantern = corpus.create("Lantern", "Product");
    const shelves = corpus.create("Shelves", "Feature", lantern.id);

    // 4 tasks on Shelves (exceeds collapse threshold 3)
    for (let i = 1; i <= 4; i++) {
      w.addThread(`t${i}`, { title: `Shelves task ${i}` });
      await w.harness.behavior.callRpc("taskAssign", {
        threadId: `t${i}`,
        entityId: shelves.id,
      });
    }

    let state = await rebuildOrg(w);
    // Active count 4 > collapseAt 3 -> expanded or product
    expect(state.counts.activeRoots).toBe(4);
    expect(state.counts.completedRoots).toBe(0);

    // Mark 3 tasks done in analysis table
    const now = Date.now();
    for (let i = 1; i <= 3; i++) {
      const thread = w.threads.get(`t${i}`)!;
      thread.status = "idle";
      thread.updatedAt = now;
      thread.latestAttentionAt = now;
      db.prepare(
        "INSERT OR REPLACE INTO ws_analysis (thread_id, revision, at, result) VALUES (?, ?, ?, ?)",
      ).run(
        `t${i}`,
        now,
        now,
        JSON.stringify({
          revision: now,
          recap: "Finished",
          state: "done",
          needsYou: null,
          subject: "Shelves",
          drift: null,
          goal: null,
          model: "fake",
          traceId: null,
        }),
      );
    }

    // Now active count is 1, completed count is 3
    state = await rebuildOrg(w);
    expect(state.counts.activeRoots).toBe(1);
    expect(state.counts.completedRoots).toBe(3);
    // Active count (1) <= collapseAt (3), so Shelves contracts into product Lantern
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]!.name).toBe("Lantern");
    expect(state.groups[0]!.completedCount).toBe(3);
    expect(state.groups[0]!.activeCount).toBe(1);

    // Return to active: t1 receives a new message
    const thread1 = w.threads.get("t1")!;
    thread1.status = "active";
    thread1.updatedAt = now + 1000;
    thread1.latestAttentionAt = now + 1000;
    // revision now outranks assessment revision
    state = await rebuildOrg(w);
    expect(state.counts.activeRoots).toBe(2);
    expect(state.counts.completedRoots).toBe(2);
  });

  it("reparent: derived groups follow catalog reparenting", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new CorpusStore(openDatabase(w.bb));
    const p1 = corpus.create("ProductOne", "Product 1");
    const p2 = corpus.create("ProductTwo", "Product 2");
    const feat = corpus.create("FeatureX", "Feature", p1.id);

    w.addThread("t1", { title: "Feature X task" });
    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "t1",
      entityId: feat.id,
    });
    let state = await rebuildOrg(w);
    expect(state.groups[0]!.name).toBe("ProductOne");

    // Reparent feat to p2
    await w.harness.behavior.callRpc("catalogReparent", {
      entityId: feat.id,
      parentId: p2.id,
    });
    state = await rebuildOrg(w);
    expect(state.groups[0]!.name).toBe("ProductTwo");
    const p2Sec = w.sections.find((s) => s.name === "ProductTwo")!;
    expect(w.threads.get("t1")?.sectionId).toBe(p2Sec.id);
  });

  it("merge: merges entity and updates derived workstream placement", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new CorpusStore(openDatabase(w.bb));
    const oldProd = corpus.create("OldProduct", "Old");
    const newProd = corpus.create("NewProduct", "New");

    w.addThread("t1", { title: "Task 1" });
    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "t1",
      entityId: oldProd.id,
    });
    let state = await rebuildOrg(w);
    expect(state.groups[0]!.name).toBe("OldProduct");

    // Merge oldProd into newProd
    await w.harness.behavior.callRpc("catalogMerge", {
      sourceEntityId: oldProd.id,
      targetEntityId: newProd.id,
    });
    state = await rebuildOrg(w);
    expect(state.groups[0]!.name).toBe("NewProduct");
    const newSec = w.sections.find((s) => s.name === "NewProduct")!;
    expect(w.threads.get("t1")?.sectionId).toBe(newSec.id);
  });

  it("no child inflation: child worker threads do not increment active counts", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new CorpusStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");

    w.addThread("root1", { title: "Root task" });
    w.addThread("child1", { title: "Child worker 1", parentThreadId: "root1" });
    w.addThread("child2", { title: "Child worker 2", parentThreadId: "root1" });

    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "root1",
      entityId: lantern.id,
    });

    const state = await rebuildOrg(w);
    // Only 1 root counted!
    expect(state.counts.totalRoots).toBe(1);
    expect(state.counts.activeRoots).toBe(1);
    expect(state.groups[0]!.totalCount).toBe(1);
  });

  it("retention on contraction: visible completed tasks remain navigable under product root", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);
    const lantern = corpus.create("Lantern", "Product");

    // All tasks completed
    const now = Date.now();
    for (let i = 1; i <= 3; i++) {
      w.addThread(`t${i}`, { title: `Task ${i}` });
      await w.harness.behavior.callRpc("taskAssign", {
        threadId: `t${i}`,
        entityId: lantern.id,
      });
      const thread = w.threads.get(`t${i}`)!;
      thread.status = "idle";
      thread.updatedAt = now;
      thread.latestAttentionAt = now;
      db.prepare(
        "INSERT OR REPLACE INTO ws_analysis (thread_id, revision, at, result) VALUES (?, ?, ?, ?)",
      ).run(
        `t${i}`,
        now,
        now,
        JSON.stringify({
          revision: now,
          recap: "Done",
          state: "done",
          needsYou: null,
          subject: "Lantern",
          drift: null,
          goal: null,
          model: "fake",
          traceId: null,
        }),
      );
    }

    const state = await rebuildOrg(w);
    expect(state.counts.activeRoots).toBe(0);
    expect(state.counts.completedRoots).toBe(3);
    // Product root is retained so all 3 completed tasks remain navigable!
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]!.name).toBe("Lantern");
    expect(state.groups[0]!.completedCount).toBe(3);
    const sec = w.sections.find((s) => s.name === "Lantern")!;
    expect(w.threads.get("t1")?.sectionId).toBe(sec.id);
  });

  it("unresolved navigation: unresolved tasks remain navigable in unfiled and are reported", async () => {
    world = await fakeWorld();
    const w = world;
    w.addThread("u1", { title: "Completely unresolved task" });

    const state = await rebuildOrg(w);
    expect(state.counts.unresolvedRoots).toBe(1);
    expect(state.unresolved).toHaveLength(1);
    expect(state.unresolved[0]!.id).toBe("u1");
    expect(state.unresolved[0]!.reason).toContain("Unresolved");
    expect(w.threads.get("u1")?.sectionId).toBeNull();
  });

  it("stable group IDs: section ID is preserved when derived identity persists", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new CorpusStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");

    w.addThread("t1", { title: "Task 1" });
    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "t1",
      entityId: lantern.id,
    });

    const state1 = await rebuildOrg(w);
    const sec1 = w.sections.find((s) => s.name === "Lantern")!.id;

    // Trigger second pass with new thread in same product
    w.addThread("t2", { title: "Task 2" });
    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "t2",
      entityId: lantern.id,
    });
    const state2 = await rebuildOrg(w);
    const sec2 = w.sections.find((s) => s.name === "Lantern")!.id;

    // Reused same section ID!
    expect(sec2).toBe(sec1);
    expect(state2.groups[0]!.sectionId).toBe(sec1);
  });

  it("no repeated model updates for unchanged snapshot", async () => {
    let classifyCalls = 0;
    world = await fakeWorld({
      complete: ({ prompt }) => {
        if (prompt.includes("Classify the most specific")) {
          classifyCalls++;
          return JSON.stringify({ subjectId: null, proposed: null });
        }
        return JSON.stringify({ recap: "ok", state: "in_progress", subject: null });
      },
    });

    const w = world;
    w.addThread("t1", { title: "Unchanging task" });

    await rebuildOrg(w);
    const initialCalls = classifyCalls;

    // Triggering when snapshot is unchanged makes 0 additional classify calls
    await getOrg(w);
    expect(classifyCalls).toBe(initialCalls);
  });

  it("no loops from derived writes", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new CorpusStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");

    w.addThread("t1", { title: "Task 1" });
    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "t1",
      entityId: lantern.id,
    });

    await rebuildOrg(w);
    // Running refresh (reconcile) should detect NO external changes
    const refreshed = (await w.harness.behavior.callRpc("refresh", null)) as {
      changed: boolean;
    };
    expect(refreshed.changed).toBe(false);
  });

  it("failure last-good state: inference failure retains previous valid groups", async () => {
    let shouldFail = false;
    let lanternId = "";
    world = await fakeWorld({
      complete: ({ prompt }) => {
        if (prompt.includes("Classify the most specific")) {
          if (shouldFail) throw new Error("Model gateway unavailable");
          return JSON.stringify({ subjectId: lanternId, proposed: null });
        }
        return JSON.stringify({ recap: "ok", state: "in_progress", subject: "Lantern" });
      },
    });

    const w = world;
    const corpus = new CorpusStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");
    lanternId = lantern.id;

    w.addThread("t1", { title: "Task 1" });
    const goodState = await rebuildOrg(w);
    expect(goodState.status).toBe("idle");
    expect(goodState.groups).toHaveLength(1);

    // Now make model fail on new thread classification
    shouldFail = true;
    w.addThread("t2", { title: "Task 2 needing classify" });
    const failedState = await rebuildOrg(w);

    expect(failedState.status).toBe("failed");
    expect(failedState.error).toContain("Model gateway unavailable");
    // Previous good groups are preserved!
    expect(failedState.groups).toHaveLength(1);
    expect(failedState.groups[0]!.name).toBe("Lantern");
  });
});
