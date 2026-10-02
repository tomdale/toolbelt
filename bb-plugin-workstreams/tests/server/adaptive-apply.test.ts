import { afterEach, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { CorpusStore } from "../../src/server/corpus.ts";
import { openDatabase } from "../../src/server/db.ts";
let world: Awaited<ReturnType<typeof fakeWorld>> | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});
it("binds activated groups before seeding so Apply creates no phantom root", async () => {
  let rootId = "",
    featureId = "";
  world = await fakeWorld({
    complete: ({ prompt }) => {
      if (prompt.includes("Choose active navigation"))
        return JSON.stringify({ activeEntityIds: [rootId, featureId] });
      return JSON.stringify({
        recap: "ongoing",
        state: "in_progress",
        subject: "Lantern",
      });
    },
  });
  const section = world.addSection("Lantern");
  for (let i = 0; i < 7; i++)
    world.addThread(`task-${i}`, {
      sectionId: section.id,
      title: `Independent task ${i}`,
    });
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
  rootId = corpus.list()[0]!.id;
  featureId = corpus.remember("Shelves", "Feature", rootId).id;
  for (let i = 0; i < 7; i++)
    corpus.assign(`task-${i}`, i < 4 ? featureId : rootId);
  await world.harness.behavior.callRpc("setPrefs", {
    patch: { organize: { adaptivePreview: true } },
  });
  const preview = (await world.harness.behavior.callRpc("bootstrap", {
    action: "start",
  })) as { state: { status: string; startedAt: number } };
  expect(preview.state.status).toBe("preview");
  await world.harness.behavior.callRpc("bootstrap", {
    action: "apply",
    runId: preview.state.startedAt,
    overrides: [],
  });
  expect(corpus.list()).toHaveLength(2);
  const featureSection = world.sections.find(
    (s) => s.name === "Lantern: Shelves",
  )!;
  expect(featureSection).toBeTruthy();
  expect(corpus.groups().get(featureSection.id)).toBe(featureId);
  expect(corpus.subjects().get("task-0")).toBe(featureId);
});
