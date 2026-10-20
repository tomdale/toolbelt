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
      expect(state.groups).toHaveLength(1);
      expect(state.groups[0]).toMatchObject({
        name: "Product",
        completedCount: 4,
        activeCount: 0,
      });
    });
    const writes = w.harness.inspection.sdk
      .callsTo("threads.update")
      .map((args) => (args[0] as { sectionId?: string }).sectionId);
    expect(writes).toHaveLength(4);
    expect(
      writes.every(
        (id) => id === w.sections.find((s) => s.name === "Product")!.id,
      ),
    ).toBe(true);
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
  it("folds a completed-only parent and four active feature roots into one useful group", async () => {
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
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]).toMatchObject({
      name: "Product",
      activeCount: 4,
      completedCount: 4,
      totalCount: 8,
      policyReason: expect.stringContaining("4 active"),
    });
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
