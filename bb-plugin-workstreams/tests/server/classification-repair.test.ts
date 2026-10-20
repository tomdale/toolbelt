import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld } from "./fake-bb.ts";
import { TopicStore } from "../../src/server/topics.ts";
import { openDatabase } from "../../src/server/db.ts";
let world: Awaited<ReturnType<typeof fakeWorld>> | undefined;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
});
async function dispatch(w: NonNullable<typeof world>) {
  const thread = w.addThread("t", {
    title: null,
    status: "starting",
    latestAttentionAt: 10,
  });
  await w.harness.registrations.hooks["message.dispatch"]!(
    makeMessageDispatchHookContext({
      thread,
      origin: "app",
      input: { text: "Audit the release pipeline", blocks: [] },
    }),
  );
}
describe("bounded classification repair", () => {
  it("repairs an invalid topic ID without losing the independently valid title", async () => {
    let topicId = "";
    let n = 0;
    world = await fakeWorld({
      complete: () =>
        JSON.stringify(
          n++ === 0
            ? {
                goal: "Release pipeline audit",
                subjectId: "Product / Pipelines",
              }
            : { goal: null, subjectId: topicId },
        ),
    });
    const w = world;
    const topics = new TopicStore(openDatabase(w.bb));
    topicId = topics.create("Pipeline", "Release pipeline").id;
    await dispatch(w);
    await vi.waitFor(() =>
      expect(w.threads.get("t")?.title).toBe("Release pipeline audit"),
    );
    expect(topics.assignment("t").entityId).toBe(topicId);
    expect(w.completions).toHaveLength(2);
  });
  it("keeps a usable title and leaves topic unresolved after two invalid responses", async () => {
    world = await fakeWorld({
      complete: () =>
        JSON.stringify({
          goal: "Release pipeline audit",
          subjectId: "Not an ID",
        }),
    });
    const w = world;
    await dispatch(w);
    await vi.waitFor(() =>
      expect(w.threads.get("t")?.title).toBe("Release pipeline audit"),
    );
    expect(w.completions).toHaveLength(2);
    expect(
      new TopicStore(openDatabase(w.bb)).assignment("t").provenance,
    ).toBeNull();
  });
  it("retains valid Full status and objective without clearing the topic on invalid output", async () => {
    world = await fakeWorld({
      complete: () =>
        JSON.stringify({
          goal: "Release pipeline audit",
          recap: "Review ready",
          state: "review",
          subjectId: "Not an ID",
        }),
    });
    const w = world;
    const topics = new TopicStore(openDatabase(w.bb));
    const p = topics.create("Pipeline", "Release pipeline");
    w.addThread("t", { status: "idle" });
    w.converse("t", ["Audit the release pipeline"]);
    topics.assign("t", p.id, { provenance: "full" });
    await w.harness.behavior.runCli(["analyze", "t"]);
    expect(topics.assignment("t").entityId).toBe(p.id);
    const state = (await w.harness.behavior.callRpc("state", null)) as any;
    expect(state.analysis.t).toMatchObject({
      state: "review",
      goal: "Release pipeline audit",
      topicError: expect.any(String),
      objective: { title: "Release pipeline audit" },
    });
  });
});
