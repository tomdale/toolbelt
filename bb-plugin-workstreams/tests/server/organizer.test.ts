import { afterEach, describe, expect, it, vi } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { RECAP_TOOL } from "../../src/domain/recap.ts";
import { fakeWorld } from "./fake-bb.ts";
import { TopicStore } from "../../src/server/topics.ts";
import { openDatabase } from "../../src/server/db.ts";
import type { OrganizerState } from "../../src/server/contract.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;

afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

const getOrg = async (w: World): Promise<OrganizerState> => {
  const result = (await w.harness.behavior.callRpc("organization", null)) as {
    state: OrganizerState;
  };
  return result.state;
};

const rebuildOrg = async (w: World): Promise<OrganizerState> => {
  const result = (await w.harness.behavior.callRpc("organization", {
    action: "rebuild",
  })) as { state: OrganizerState };
  return result.state;
};

describe("automatic update coordinator lifecycle", () => {
  it("initial populate: Full analysis settles each root's topic, and organizing files it", async () => {
    let lanternId = "";
    world = await fakeWorld({
      complete: () =>
        JSON.stringify({
          recap: "working",
          state: "in_progress",
          goal: "Lantern work",
          subjectId: lanternId,
          proposed: null,
        }),
    });
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
    lanternId = corpus.create("Lantern", "Product").id;
    w.addThread("t1", { title: "Lantern core fix", sectionId: null });
    w.addThread("t2", { title: "Lantern styling", sectionId: null });
    await w.harness.behavior.callRpc("refresh", null);
    await w.harness.behavior.runCli(["analyze", "t1"]);
    await w.harness.behavior.runCli(["analyze", "t2"]);

    const state = await rebuildOrg(w);
    expect(state.status).toBe("idle");
    expect(state.counts.activeRoots).toBe(2);
    expect(state.groups.map((g) => g.name)).toEqual(["Lantern"]);
    const section = w.sections.find((s) => s.name === "Lantern")!;
    expect(w.threads.get("t1")?.sectionId).toBe(section.id);
    expect(w.threads.get("t2")?.sectionId).toBe(section.id);
  });

  it("organizing never calls a model", async () => {
    const calls: string[] = [];
    world = await fakeWorld({
      complete: ({ prompt }) => {
        calls.push(prompt);
        return JSON.stringify({ recap: "r", state: "done" });
      },
    });
    const w = world;
    w.addThread("t1", { title: "No topic yet" });
    await rebuildOrg(w);
    await rebuildOrg(w);
    expect(calls).toHaveLength(0);
  });
  it("new root: a thread created from another starts with its topic", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");
    w.addThread("t1", { title: "Lantern task 1" });
    corpus.assign("t1", lantern.id, { provenance: "full" });
    await rebuildOrg(w);

    // A fork of t1 inherits its topic as soon as it exists.
    const t2 = w.addThread("t2", {
      title: "Lantern task 2",
      sourceThreadId: "t1",
    });
    await w.harness.behavior.emitThreadEvent("thread.created", { thread: t2 });
    expect(corpus.assignment("t2")).toMatchObject({
      entityId: lantern.id,
      provenance: "inherited",
    });
    const state = await rebuildOrg(w);
    expect(state.counts.activeRoots).toBe(2);
    const section = w.sections.find((s) => s.name === "Lantern")!;
    expect(w.threads.get("t2")?.sectionId).toBe(section.id);
  });
  it("correct identity: manual assignment is authoritative and moves the root", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
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
    const corpus = new TopicStore(openDatabase(w.bb));
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
    const corpus = new TopicStore(db);
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
    const corpus = new TopicStore(openDatabase(w.bb));
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
    const corpus = new TopicStore(openDatabase(w.bb));
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
    const corpus = new TopicStore(openDatabase(w.bb));
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
    const corpus = new TopicStore(db);
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
    expect(state.unresolved[0]!.reason).toContain("No topic");
    expect(w.threads.get("u1")?.sectionId).toBeNull();
  });

  it("stable group IDs: section ID is preserved when derived identity persists", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
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
        return JSON.stringify({
          recap: "ok",
          state: "in_progress",
          subject: null,
        });
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
    const corpus = new TopicStore(openDatabase(w.bb));
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

  it("multi-product partitions: derives groups across multiple products simultaneously without unknown identity errors", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
    const prodA = corpus.create("ProductAlpha", "Product A");
    const featA = corpus.create("FeatureA", "Feature under A", prodA.id);
    const prodB = corpus.create("ProductBeta", "Product B");
    const featB = corpus.create("FeatureB", "Feature under B", prodB.id);

    // Add threads for Product A and Product B
    w.addThread("t-a1", { title: "Task A1" });
    w.addThread("t-a2", { title: "Task A2" });
    w.addThread("t-b1", { title: "Task B1" });
    w.addThread("t-b2", { title: "Task B2" });

    corpus.assign("t-a1", featA.id, { provenance: "manual" });
    corpus.assign("t-a2", prodA.id, { provenance: "manual" });
    corpus.assign("t-b1", featB.id, { provenance: "manual" });
    corpus.assign("t-b2", prodB.id, { provenance: "manual" });

    const state = await rebuildOrg(w);
    expect(state.status).toBe("idle");
    expect(state.error).toBeNull();
    const groupNames = state.groups.map((g) => g.name);
    expect(groupNames).toContain("ProductAlpha");
    expect(groupNames).toContain("ProductBeta");
  });

  it("no topic set yourself stays: analysis never gives that thread one", async () => {
    world = await fakeWorld({
      complete: () =>
        JSON.stringify({
          recap: "ok",
          state: "in_progress",
          goal: "Task",
          subjectId: prodId,
          proposed: null,
        }),
    });
    let prodId = "";
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
    prodId = corpus.create("ProductA", "Product").id;
    w.addThread("t1", { title: "Task 1", status: "idle" });
    w.converse("t1", ["Do the thing"]);
    await w.harness.behavior.callRpc("refresh", null);
    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "t1",
      entityId: null,
    });
    await w.harness.behavior.runCli(["analyze", "t1"]);
    expect(corpus.assignment("t1")).toMatchObject({
      status: "unresolved",
      provenance: "manual",
    });
  });
  it("section cleanup: rebound section is not deleted during cleanup", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
    const prodA = corpus.create("Alpha", "Product Alpha");
    const prodB = corpus.create("Beta", "Product Beta");

    // Existing section named Beta already bound to Alpha
    const sec = w.addSection("Beta");
    corpus.bindGroup(sec.id, prodA.id);

    // Thread t1 assigned to Beta
    w.addThread("t1", { title: "Beta task" });
    corpus.assign("t1", prodB.id, { provenance: "manual" });

    const state = await rebuildOrg(w);
    expect(state.status).toBe("idle");
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]!.name).toBe("Beta");

    // Section must NOT have been deleted
    expect(w.sections.some((s) => s.id === sec.id)).toBe(true);
    expect(w.threads.get("t1")?.sectionId).toBe(sec.id);
  });

  it("completed retention: completed root/sibling tasks retain navigation when active tasks expand to child features", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
    const prod = corpus.create("Lantern", "Product");
    const f1 = corpus.create("Core", "Core feature", prod.id);
    const f2 = corpus.create("UI", "UI feature", prod.id);
    const f3 = corpus.create("Docs", "Docs feature", prod.id);

    // 4 active tasks in Core, 4 active tasks in UI (exceeds capacity 6)
    for (let i = 1; i <= 4; i++) {
      w.addThread(`core-${i}`, { title: `Core task ${i}` });
      corpus.assign(`core-${i}`, f1.id, { provenance: "manual" });
      w.addThread(`ui-${i}`, { title: `UI task ${i}` });
      corpus.assign(`ui-${i}`, f2.id, { provenance: "manual" });
    }

    // 1 completed task on Lantern root, 1 completed task on Docs (f3)
    w.addThread("done-root", { title: "Lantern initial setup" });
    corpus.assign("done-root", prod.id, { provenance: "manual" });
    w.turn("done-root", "completed");
    await w.harness.behavior.emitThreadEvent("thread.idle", {
      thread: w.threads.get("done-root")!,
      lastAssistantText: "Done.",
    });

    w.addThread("done-docs", { title: "Docs task" });
    corpus.assign("done-docs", f3.id, { provenance: "manual" });
    w.turn("done-docs", "completed");
    await w.harness.behavior.emitThreadEvent("thread.idle", {
      thread: w.threads.get("done-docs")!,
      lastAssistantText: "Done.",
    });

    const state = await rebuildOrg(w);
    expect(state.status).toBe("idle");

    // Completed tasks must NOT be in unresolved
    expect(state.unresolved.filter((u) => u.id === "done-root")).toHaveLength(
      0,
    );
    expect(state.unresolved.filter((u) => u.id === "done-docs")).toHaveLength(
      0,
    );

    // Completed tasks must be filed in native sections, not Unfiled!
    const doneRootThread = w.threads.get("done-root");
    const doneDocsThread = w.threads.get("done-docs");
    expect(doneRootThread?.sectionId).not.toBeNull();
    expect(doneDocsThread?.sectionId).not.toBeNull();

    // The group holding done-root must be Lantern
    const lanternGroup = state.groups.find((g) => g.name === "Lantern");
    expect(lanternGroup).toBeDefined();
    expect(lanternGroup?.roots.some((r) => r.id === "done-root")).toBe(true);
    expect(lanternGroup?.roots.some((r) => r.id === "done-docs")).toBe(true);
  });

  it("section safety: adopted external user-created section is not deleted when empty", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
    const prod = corpus.create("Docs", "Docs Product");

    // User created native section named Docs in BB before Workstreams ran
    const userSec = w.addSection("Docs");
    openDatabase(w.bb)
      .prepare(
        "INSERT INTO ws_workstream (section_id, created_by, created_at, updated_at) VALUES (?, 'user', 1, 1) ON CONFLICT(section_id) DO UPDATE SET created_by = 'user'",
      )
      .run(userSec.id);

    // Active task in Docs adopts the user section
    w.addThread("t1", { title: "Docs task" });
    corpus.assign("t1", prod.id, { provenance: "manual" });

    const state1 = await rebuildOrg(w);
    expect(state1.groups[0]!.sectionId).toBe(userSec.id);

    // Task archives, leaving Docs empty
    const t1 = w.threads.get("t1")!;
    t1.archivedAt = Date.now();
    await w.harness.behavior.emitThreadEvent("thread.archived", { thread: t1 });
    const state2 = await rebuildOrg(w);
    expect(state2.groups).toHaveLength(0);

    // External user section must NOT be deleted from BB!
    expect(w.sections.some((s) => s.id === userSec.id)).toBe(true);
  });

  it("concurrent rebuild: rebuild during active run is not swallowed and executes fresh pass", async () => {
    world = await fakeWorld();
    const w = world;
    w.addThread("t1", { title: "Task 1" });
    await rebuildOrg(w);
    const [res1, res2] = await Promise.all([rebuildOrg(w), rebuildOrg(w)]);
    expect(res1.status).toBe("idle");
    expect(res2.status).toBe("idle");
  });
  it("partial mutations state truth: partial native mutations are reflected in state on sync failure", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
    const prodA = corpus.create("Alpha", "Product Alpha");
    const prodB = corpus.create("Beta", "Product Beta");

    w.addThread("t-alpha", { title: "Alpha task" });
    w.addThread("t-beta", { title: "Beta task" });
    corpus.assign("t-alpha", prodA.id, { provenance: "manual" });
    corpus.assign("t-beta", prodB.id, { provenance: "manual" });

    // Inject SDK failure on thread update for t-beta
    let failBeta = true;
    w.harness.sdk.stub(
      "threads.update",
      async (args: { threadId: string; sectionId: string | null }) => {
        if (failBeta && args.threadId === "t-beta") {
          throw new Error("SDK thread update failed for t-beta");
        }
        const t = w.threads.get(args.threadId);
        if (t) t.sectionId = args.sectionId;
        return t as never;
      },
    );

    const failedState = await rebuildOrg(w);
    expect(failedState.status).toBe("failed");
    expect(failedState.error).toContain("SDK thread update failed for t-beta");

    // State truth: t-alpha was updated and has its section, groups reflect derived state
    expect(failedState.groups.length).toBeGreaterThan(0);
    const alphaGroup = failedState.groups.find((g) => g.name === "Alpha");
    expect(alphaGroup).toBeDefined();
    expect(alphaGroup?.sectionId).not.toBeNull();
  });

  it("event lifecycle: topic changes trigger the organizer without a rebuild", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");
    const compass = corpus.create("Compass", "Navigation product");
    const t1 = w.addThread("t1", { title: "Lantern core fix", sectionId: null });
    await w.harness.behavior.emitThreadEvent("thread.created", { thread: t1 });

    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "t1",
      entityId: lantern.id,
    });
    await vi.waitFor(
      () => {
        const section = w.sections.find((s) => s.name === "Lantern");
        expect(section).toBeDefined();
        expect(w.threads.get("t1")?.sectionId).toBe(section!.id);
      },
      { timeout: 2000 },
    );

    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "t1",
      entityId: compass.id,
    });
    await vi.waitFor(
      () => {
        const section = w.sections.find((s) => s.name === "Compass");
        expect(section).toBeDefined();
        expect(w.threads.get("t1")?.sectionId).toBe(section!.id);
      },
      { timeout: 2000 },
    );
  });
});

type Entry = {
  action: string;
  source: string;
  status: string;
  rationale: string;
  detail: string | null;
  undo: unknown;
  threads: { id: string; name: string }[];
  workstreams: { id: string; name: string }[];
};

const organizerEntries = async (w: World): Promise<Entry[]> => {
  const { entries } = (await w.harness.behavior.callRpc("journal", null)) as {
    entries: Entry[];
  };
  return entries.filter((e) => e.action === "batch" && e.source === "auto");
};

/** The thread's agent reports `state` for its latest turn. */
async function report(w: World, threadId: string, state: string) {
  await w.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: threadId, parentThreadId: null },
    }),
  );
  w.turn(threadId);
  await w.harness.behavior.callAgentTool(
    RECAP_TOOL,
    { state, goal: "Shipped the fix", latest: ["Fixed it"] },
    { threadId },
  );
}

describe("organizer status and Activity", () => {
  it("counts a thread whose agent reported it complete as done", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");
    w.addThread("t1", { status: "idle", latestAttentionAt: 500 });
    w.addThread("t2", { status: "idle", latestAttentionAt: 500 });
    corpus.assign("t1", lantern.id, { provenance: "manual" });
    corpus.assign("t2", lantern.id, { provenance: "manual" });
    await w.harness.behavior.callRpc("refresh", null);

    await report(w, "t1", "complete");
    const state = await rebuildOrg(w);

    expect(state.counts.completedRoots).toBe(1);
    expect(state.counts.activeRoots).toBe(1);
    const member = state.groups[0]!.roots.find((r) => r.id === "t1");
    expect(member?.completed).toBe(true);
  });

  it("records each pass's section changes as one automatic entry", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");
    w.addThread("t1", { title: "Lantern core fix", sectionId: null });
    corpus.assign("t1", lantern.id, { provenance: "manual" });

    await rebuildOrg(w);
    const section = w.sections.find((s) => s.name === "Lantern")!;
    const [entry, ...rest] = await organizerEntries(w);
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({
      status: "applied",
      rationale: "Organized by topic: 1 thread moved, 1 workstream created",
      threads: [{ id: "t1", name: "Lantern core fix" }],
      workstreams: [{ id: section.id, name: "Lantern" }],
      undo: null,
    });
    expect(entry!.detail).toContain(
      "Moved “Lantern core fix” from Unfiled to Lantern",
    );

    // A pass that changes nothing records nothing.
    await rebuildOrg(w);
    expect(await organizerEntries(w)).toHaveLength(1);
  });

  it("moves a thread back after a move made outside Workstreams, and says so", async () => {
    world = await fakeWorld();
    const w = world;
    const corpus = new TopicStore(openDatabase(w.bb));
    const lantern = corpus.create("Lantern", "Product");
    w.addThread("t1", { title: "Lantern core fix", sectionId: null });
    corpus.assign("t1", lantern.id, { provenance: "manual" });
    await rebuildOrg(w);
    const home = w.sections.find((s) => s.name === "Lantern")!;

    const elsewhere = w.addSection("Elsewhere");
    w.threads.set("t1", { ...w.threads.get("t1")!, sectionId: elsewhere.id });
    await rebuildOrg(w);

    expect(w.threads.get("t1")?.sectionId).toBe(home.id);
    const [latest] = await organizerEntries(w);
    expect(latest!.detail).toContain(
      "Moved “Lantern core fix” from Elsewhere to Lantern",
    );
  });
});
