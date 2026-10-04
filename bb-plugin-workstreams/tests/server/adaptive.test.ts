import { afterEach, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { CorpusStore } from "../../src/server/corpus.ts";
import { openDatabase } from "../../src/server/db.ts";
let world: Awaited<ReturnType<typeof fakeWorld>> | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});
it("recognizes an inactive feature and retains subject through broad placement", async () => {
  let featureId = "";
  world = await fakeWorld({
    complete: ({ prompt }) =>
      prompt.includes("Classify the most specific")
        ? JSON.stringify({ subjectId: featureId, proposed: null })
        : JSON.stringify({
            recap: "ongoing",
            state: "in_progress",
            subject: "Lantern",
          }),
  });
  const section = world.addSection("Lantern");
  world.addThread("existing", { sectionId: section.id, title: "Lantern task" });
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
  const root = corpus.list()[0]!;
  const feature = corpus.remember("Shared shelves", "Feature", root.id, [
    "Shelves",
  ]);
  featureId = feature.id;
  const result = await world.harness.behavior.callRpc("route", {
    prompt: "Lantern shelves",
    suggest: true,
    draftKey: "one",
  });
  expect(result).toMatchObject({
    outcome: "new-thread",
    subjectId: feature.id,
    sectionId: section.id,
    placement: null,
  });
  const known = (await world.harness.behavior.callRpc("catalog", null)) as {
    entities: unknown[];
  };
  expect(known).toMatchObject({
    entities: expect.arrayContaining([
      expect.objectContaining({ id: feature.id, aliases: ["Shelves"] }),
    ]),
  });
  expect(world.sections).toHaveLength(1);
});
it("adaptive organization classifies task and derives groups automatically", async () => {
  let featureId = "";
  world = await fakeWorld({
    complete: ({ prompt }) => {
      if (prompt.includes("Classify the most specific"))
        return JSON.stringify({ subjectId: featureId, proposed: null });
      return JSON.stringify({
        recap: "ongoing",
        state: "in_progress",
        subject: "Lantern",
      });
    },
  });
  const section = world.addSection("Lantern");
  world.addThread("existing", {
    sectionId: section.id,
    title: "Lantern shelves task",
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
  featureId = corpus.remember(
    "Shared shelves",
    "Feature",
    corpus.list()[0]!.id,
  ).id;
  const org = (await world.harness.behavior.callRpc("organization", {
    action: "rebuild",
  })) as {
    state: { status: string; groups: { name: string }[] };
  };
  expect(org.state.status).toBe("idle");
  expect(corpus.subjects().get("existing")).toBe(featureId);
});
