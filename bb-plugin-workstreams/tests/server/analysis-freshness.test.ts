import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld } from "./fake-bb.ts";
import { TopicStore } from "../../src/server/topics.ts";
import { openDatabase } from "../../src/server/db.ts";

let world: Awaited<ReturnType<typeof fakeWorld>> | undefined;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
});
function gate() {
  let release!: (value: string) => void;
  const promise = new Promise<string>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const answer = (id: string, goal = "Build Alpha") =>
  JSON.stringify({
    recap: "Working",
    state: "in_progress",
    goal,
    subjectId: id,
    proposed: null,
    names: { products: ["Alpha"], features: [] },
  });

describe("inference application freshness", () => {
  it.each(["project id", "project hint"])(
    "rejects an analysis after its %s changes",
    async (kind) => {
      const pending = gate();
      world = await fakeWorld({ complete: () => pending.promise });
      const w = world;
      const db = openDatabase(w.bb);
      const topics = new TopicStore(db);
      const a = topics.create("Alpha", "Product");
      let name = "Original";
      w.harness.inspection.sdk.stub("projects.list", async () => [
        { id: "proj_1", name, sources: [] },
      ]);
      w.addThread("t", { status: "idle", latestAttentionAt: 10 });
      w.converse("t", ["Fix the pipeline"]);
      const running = w.harness.behavior.runCli(["analyze", "t"]);
      await vi.waitFor(() => expect(w.completions).toHaveLength(1));
      if (kind === "project id")
        w.threads.set("t", { ...w.threads.get("t")!, projectId: "proj_other" });
      else name = "Renamed";
      pending.release(answer(a.id));
      await running;
      expect(topics.assignment("t").provenance).toBeNull();
      expect(
        db.prepare("SELECT * FROM ws_analysis WHERE thread_id = 't'").get(),
      ).toBeUndefined();
    },
  );
  it("discards all effects of an old analysis after a new turn starts", async () => {
    const pending = gate();
    world = await fakeWorld({ complete: () => pending.promise });
    const w = world;
    const db = openDatabase(w.bb);
    const topics = new TopicStore(db);
    const a = topics.create("Alpha", "Product");
    const b = topics.create("Beta", "Product");
    w.addThread("t", { status: "idle", latestAttentionAt: 10 });
    w.converse("t", ["Build Alpha"]);
    topics.assign("t", a.id, { provenance: "full" });
    const running = w.harness.behavior.runCli(["analyze", "t"]);
    await vi.waitFor(() => expect(w.completions).toHaveLength(1));
    w.threads.set("t", {
      ...w.threads.get("t")!,
      status: "active",
      latestAttentionAt: 20,
    });
    topics.assign("t", b.id, { provenance: "full" });
    pending.release(answer(a.id));
    await running;
    expect(topics.assignment("t").entityId).toBe(b.id);
    expect(
      db.prepare("SELECT * FROM ws_analysis WHERE thread_id = 't'").get(),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT * FROM ws_name_observation WHERE thread_id = 't'")
        .all(),
    ).toEqual([]);
  });
  it("protects a correction made at the same thread revision", async () => {
    const pending = gate();
    world = await fakeWorld({ complete: () => pending.promise });
    const w = world;
    const topics = new TopicStore(openDatabase(w.bb));
    const a = topics.create("Alpha", "Product");
    const b = topics.create("Beta", "Product");
    w.addThread("t", { status: "idle", latestAttentionAt: 10 });
    w.converse("t", ["Build Alpha"]);
    const running = w.harness.behavior.runCli(["analyze", "t"]);
    await vi.waitFor(() => expect(w.completions).toHaveLength(1));
    topics.assign("t", b.id, { provenance: "full" });
    pending.release(answer(a.id));
    await running;
    expect(topics.assignment("t").entityId).toBe(b.id);
  });
  it.each([10, 20])(
    "does not apply Quick results after idle at attention revision %s",
    async (revision) => {
      const pending = gate();
      world = await fakeWorld({ complete: () => pending.promise });
      const w = world;
      const topics = new TopicStore(openDatabase(w.bb));
      const a = topics.create("Alpha", "Product");
      const t = w.addThread("t", {
        title: null,
        status: "starting",
        latestAttentionAt: 10,
      });
      await w.harness.registrations.hooks["message.dispatch"]!(
        makeMessageDispatchHookContext({
          thread: t,
          origin: "app",
          input: { text: "Build Alpha", blocks: [] },
        }),
      );
      await vi.waitFor(() => expect(w.completions).toHaveLength(1));
      w.threads.set("t", { ...t, status: "idle", latestAttentionAt: revision });
      pending.release(answer(a.id));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(topics.assignment("t").provenance).toBeNull();
      expect(w.threads.get("t")?.title).toBeNull();
    },
  );
});
