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
  it("does not apply a Quick topic after its first turn has finished", async () => {
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
    w.threads.set("t", { ...t, status: "idle", latestAttentionAt: 20 });
    pending.release(answer(a.id));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(topics.assignment("t").provenance).toBeNull();
    expect(w.threads.get("t")?.title).toBeNull();
  });
});
