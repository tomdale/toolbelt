import { afterEach, expect, it, vi } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { CorpusStore } from "../../src/server/corpus.ts";
import { openDatabase } from "../../src/server/db.ts";
let world: Awaited<ReturnType<typeof fakeWorld>> | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});
async function setup() {
  let entityId = "";
  const releases: (() => void)[] = [];
  let active = 0,
    peak = 0;
  world = await fakeWorld({
    complete: async ({ prompt }) => {
      if (prompt.includes("Identify the most specific")) {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return JSON.stringify({ subjectId: entityId, proposed: null });
      }
      if (prompt.includes("Choose active navigation"))
        return JSON.stringify({ activeEntityIds: [entityId] });
      return JSON.stringify({
        recap: "work",
        state: "in_progress",
        subject: "Lantern",
      });
    },
  });
  const section = world.addSection("Lantern");
  for (let i = 0; i < 5; i++)
    world.addThread(`task-${i}`, { sectionId: section.id, title: `Task ${i}` });
  await world.harness.behavior.callRpc("refresh", null);
  const corpus = new CorpusStore(openDatabase(world.bb));
  corpus.seed([
    {
      sectionId: section.id,
      name: "Lantern",
      description: "Product",
      aliases: [],
    },
  ]);
  entityId = corpus.list()[0]!.id;
  await world.harness.behavior.callRpc("setPrefs", {
    patch: { organize: { adaptivePreview: true } },
  });
  return { w: world, releases, corpus, peak: () => peak };
}
it("classifies with three bounded workers and publishes stage/count progress", async () => {
  const { w, releases, peak } = await setup();
  const pending = w.harness.behavior.callRpc("bootstrap", { action: "start" });
  await vi.waitFor(() => expect(releases).toHaveLength(3));
  expect(
    await w.harness.behavior.callRpc("bootstrap", { action: "get" }),
  ).toMatchObject({
    state: {
      progress: { stage: "classifying", completed: 0, total: 5, cached: 0 },
    },
  });
  releases.splice(0).forEach((resolve) => resolve());
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  expect(
    await w.harness.behavior.callRpc("bootstrap", { action: "get" }),
  ).toMatchObject({ state: { progress: { completed: 3 } } });
  releases.splice(0).forEach((resolve) => resolve());
  expect(await pending).toMatchObject({
    state: {
      status: "preview",
      progress: { stage: "regrouping", completed: 5, total: 5 },
    },
  });
  expect(peak()).toBe(3);
  expect(w.sections).toHaveLength(1);
});
it("does not assign late completions or resurrect progress after cancellation", async () => {
  const { w, releases, corpus } = await setup();
  const pending = w.harness.behavior.callRpc("bootstrap", { action: "start" });
  await vi.waitFor(() => expect(releases).toHaveLength(3));
  await w.harness.behavior.callRpc("bootstrap", { action: "cancel" });
  releases.splice(0).forEach((resolve) => resolve());
  await pending;
  expect(corpus.subjects().size).toBe(0);
  expect(
    (await w.harness.behavior.callRpc("bootstrap", {
      action: "get",
    })) as unknown,
  ).toMatchObject({ state: null });
  expect(
    w.completions.some((c) => c.prompt.includes("Choose active navigation")),
  ).toBe(false);
});
