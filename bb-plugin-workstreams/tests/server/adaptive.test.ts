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
      prompt.includes("Identify the most specific")
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
  await world.harness.behavior.callRpc("setPrefs", {
    patch: { newWork: { corpusClassification: true } },
  });
  const result = await world.harness.behavior.callRpc("route", {
    prompt: "Lantern shelves",
    suggest: true,
    draftKey: "one",
  });
  expect(result).toMatchObject({
    outcome: "new-thread",
    subjectId: expect.stringMatching(/^automatic:/),
    sectionId: section.id,
    placement: null,
  });
  const known = await world.harness.behavior.callRpc("corpus", null);
  expect(known).toMatchObject({
    entities: expect.arrayContaining([
      expect.objectContaining({ id: feature.id, aliases: ["Shelves"] }),
    ]),
  });
  expect(world.sections).toHaveLength(1);
});
it("adaptive organization sends counts rather than tasks to regrouping and leaves mutations for Apply", async () => {
  let featureId = "";
  world = await fakeWorld({
    complete: ({ prompt }) => {
      if (prompt.includes("Identify the most specific"))
        return JSON.stringify({ subjectId: featureId, proposed: null });
      if (prompt.includes("Choose active navigation")) {
        const snapshot = JSON.parse(prompt.split("Snapshot:\n")[1]!);
        return JSON.stringify({
          activeEntityIds: [
            snapshot.entities.find(
              (e: { parentId: string | null }) => e.parentId === null,
            ).id,
          ],
        });
      }
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
  await world.harness.behavior.callRpc("setPrefs", {
    patch: { organize: { adaptivePreview: true } },
  });
  const preview = await world.harness.behavior.callRpc("bootstrap", {
    action: "start",
  });
  expect(preview).toMatchObject({ state: { status: "preview" } });
  const prompt = world.completions.find((c) =>
    c.prompt.includes("Choose active navigation"),
  )!.prompt;
  expect(prompt).toContain('"counts"');
  expect(prompt).not.toContain("Lantern shelves task");
  expect(world.sections).toHaveLength(1);
  expect(corpus.subjects().get("existing")).toBe(featureId);
});
