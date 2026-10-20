import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { TopicStore } from "../../src/server/topics.ts";
import { openDatabase } from "../../src/server/db.ts";
let world: Awaited<ReturnType<typeof fakeWorld>> | undefined;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
});
const rebuild = (w: NonNullable<typeof world>) =>
  w.harness.behavior.callRpc("organization", {
    action: "rebuild",
  }) as Promise<any>;
describe("grouping regressions", () => {
  it.each([1, 7])(
    "includes %i done roots in capacity and contraction thresholds",
    async (doneCount) => {
      world = await fakeWorld();
      const w = world;
      const db = openDatabase(w.bb);
      const topics = new TopicStore(db);
      const p = topics.create("Product", "Product");
      const f = topics.create("Feature", "Feature", p.id);
      for (let i = 0; i < 7; i++) {
        w.addThread(`t${i}`, {
          status: "idle",
          latestAttentionAt: 10,
          archivedAt: i === 6 ? 20 : null,
        });
        topics.assign(`t${i}`, i < 3 ? p.id : f.id);
        if (i >= 7 - doneCount) {
          db.prepare(
            "INSERT INTO ws_analysis(thread_id, revision, at, result) VALUES (?,10,10,?)",
          ).run(
            `t${i}`,
            JSON.stringify({
              revision: 10,
              state: "done",
              recap: "Done",
              goal: null,
              needsYou: null,
              at: 10,
              model: "test",
            }),
          );
        }
      }
      const atCapacity = (await rebuild(w)).state;
      expect(atCapacity.groups).toHaveLength(1);
      expect(atCapacity.counts.totalRoots).toBe(6);

      w.threads.get("t6")!.archivedAt = null;
      const expanded = (await rebuild(w)).state;
      expect(expanded.groups).toHaveLength(2);
      expect(expanded.counts).toMatchObject({
        totalRoots: 7,
        activeRoots: 7 - doneCount,
        completedRoots: doneCount,
      });
      expect(
        expanded.groups.map((g: { sectionId: string }) => g.sectionId).sort(),
      ).toEqual(
        (await rebuild(w)).state.groups
          .map((g: { sectionId: string }) => g.sectionId)
          .sort(),
      );

      // Four visible roots keep the split even if every root is done.
      for (const i of [0, 1, 3]) w.threads.get(`t${i}`)!.archivedAt = 20;
      expect((await rebuild(w)).state.groups).toHaveLength(2);

      // Only archiving down to the contraction threshold folds the groups.
      w.threads.get("t4")!.archivedAt = 20;
      const contracted = (await rebuild(w)).state;
      expect(contracted.counts.totalRoots).toBe(3);
      expect(contracted.groups).toEqual([
        expect.objectContaining({ name: "Product", totalCount: 3 }),
      ]);
    },
  );
  it("replans when completion changes while projection is fetching a live root", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const topics = new TopicStore(db);
    const p = topics.create("Product", "Product");
    const f = topics.create("Feature", "Feature", p.id);
    for (let i = 0; i < 4; i++) {
      w.addThread(`t${i}`, { status: "idle", latestAttentionAt: 10 });
      topics.assign(`t${i}`, i < 2 ? p.id : f.id);
    }
    let completed = false;
    w.harness.inspection.sdk.stub(
      "threads.get",
      async (args: { threadId: string }) => {
        if (!completed) {
          completed = true;
          for (let i = 0; i < 4; i++)
            db.prepare(
              "INSERT INTO ws_analysis(thread_id, revision, at, result) VALUES (?,10,10,?)",
            ).run(
              `t${i}`,
              JSON.stringify({
                revision: 10,
                state: "done",
                recap: "Done",
                goal: null,
                needsYou: null,
                at: 10,
                model: "test",
              }),
            );
        }
        return w.threads.get(args.threadId)!;
      },
    );
    await w.harness.behavior.callRpc("setPrefs", {
      patch: { organize: { capacity: 2, collapseAt: 1 } },
    });
    await rebuild(w);
    await vi.waitFor(async () => {
      const { state } = (await w.harness.behavior.callRpc(
        "organization",
        null,
      )) as any;
      expect(state.groups).toHaveLength(2);
      expect(state.groups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Product",
            completedCount: 2,
            activeCount: 0,
          }),
          expect.objectContaining({
            name: "Product: Feature",
            completedCount: 2,
            activeCount: 0,
          }),
        ]),
      );
    });
    const writes = w.harness.inspection.sdk
      .callsTo("threads.update")
      .map((args) => (args[0] as { sectionId?: string }).sectionId);
    expect(writes).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      const name = i < 2 ? "Product" : "Product: Feature";
      expect(w.threads.get(`t${i}`)?.sectionId).toBe(
        w.sections.find((s) => s.name === name)!.id,
      );
    }
  });
  it("applies a policy-only preference change without a forced rebuild", async () => {
    world = await fakeWorld();
    const w = world;
    const topics = new TopicStore(openDatabase(w.bb));
    const p = topics.create("Product", "Product");
    const f = topics.create("Feature", "Feature", p.id);
    await w.harness.behavior.callRpc("setPrefs", {
      patch: { organize: { capacity: 6, collapseAt: 1 } },
    });
    for (let i = 0; i < 4; i++) {
      w.addThread(`t${i}`);
      topics.assign(`t${i}`, i < 2 ? p.id : f.id);
    }
    expect((await rebuild(w)).state.groups).toHaveLength(1);
    await w.harness.behavior.callRpc("setPrefs", {
      patch: { organize: { capacity: 2 } },
    });
    await vi.waitFor(async () => {
      const { state } = (await w.harness.behavior.callRpc(
        "organization",
        null,
      )) as any;
      expect(state.groups).toHaveLength(2);
    });
  });
  it("counts completed roots when retaining a split above capacity", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const topics = new TopicStore(db);
    const p = topics.create("Product", "Product");
    const f = topics.create("Feature", "Feature", p.id);
    topics.bindGroup(w.addSection("Product").id, p.id);
    topics.bindGroup(w.addSection("Product: Feature").id, f.id);
    for (let i = 0; i < 8; i++) {
      w.addThread(`t${i}`, { status: "idle", latestAttentionAt: 10 });
      topics.assign(`t${i}`, i === 0 ? p.id : f.id);
      if (i === 0 || i > 4)
        db.prepare(
          "INSERT INTO ws_analysis(thread_id, revision, at, result) VALUES (?,10,10,?)",
        ).run(
          `t${i}`,
          JSON.stringify({
            revision: 10,
            state: "done",
            recap: "Done",
            goal: null,
            needsYou: null,
            at: 10,
            model: "test",
          }),
        );
    }
    const { state } = await rebuild(w);
    expect(state.groups).toHaveLength(2);
    expect(state.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Product",
          activeCount: 0,
          completedCount: 1,
          totalCount: 1,
        }),
        expect.objectContaining({
          name: "Product: Feature",
          activeCount: 4,
          completedCount: 3,
          totalCount: 7,
          policyReason: expect.stringContaining(
            "7 visible roots drive grouping",
          ),
        }),
      ]),
    );
  });
  it("replans rather than applying a topic that changed while fetching a live root", async () => {
    world = await fakeWorld();
    const w = world;
    const topics = new TopicStore(openDatabase(w.bb));
    const a = topics.create("Alpha", "Product");
    const b = topics.create("Beta", "Product");
    w.addThread("t");
    topics.assign("t", a.id);
    let changed = false;
    w.harness.inspection.sdk.stub(
      "threads.get",
      async (args: { threadId: string }) => {
        if (args.threadId === "t" && !changed) {
          changed = true;
          topics.assign("t", b.id);
        }
        return w.threads.get(args.threadId)!;
      },
    );
    await rebuild(w);
    await vi.waitFor(() =>
      expect(
        w.sections.find((s) => s.id === w.threads.get("t")?.sectionId)?.name,
      ).toBe("Beta"),
    );
    const writes = w.harness.inspection.sdk
      .callsTo("threads.update")
      .map((args) => (args[0] as { sectionId?: string }).sectionId);
    expect(writes).toEqual([w.sections.find((s) => s.name === "Beta")!.id]);
  });
});
