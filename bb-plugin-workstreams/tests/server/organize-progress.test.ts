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
      if (prompt.includes("Classify the most specific")) {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return JSON.stringify({ subjectId: entityId, proposed: null });
      }
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
  return { w: world, releases, corpus, peak: () => peak };
}

it("classifies with three bounded workers and publishes stage/count progress", async () => {
  const { w, releases, peak } = await setup();
  const pending = w.harness.behavior.callRpc("organization", { action: "rebuild" });
  await vi.waitFor(() => expect(releases).toHaveLength(3));
  expect(
    await w.harness.behavior.callRpc("organization", { action: "get" }),
  ).toMatchObject({
    state: {
      progress: { stage: "classifying", completed: 0, total: 5, cached: 0 },
    },
  });
  releases.splice(0).forEach((resolve) => resolve());
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  expect(
    await w.harness.behavior.callRpc("organization", { action: "get" }),
  ).toMatchObject({ state: { progress: { completed: 3 } } });
  releases.splice(0).forEach((resolve) => resolve());
  const finalState = (await pending) as {
    state: { status: string; counts: { activeRoots: number } };
  };
  expect(finalState).toMatchObject({
    state: {
      status: "idle",
      counts: { activeRoots: 5 },
    },
  });
  expect(peak()).toBe(3);
  expect(w.sections).toHaveLength(1);
});
