import { afterEach, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
let world: Awaited<ReturnType<typeof fakeWorld>> | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});
it("keeps draft discoveries tentative and commits ancestry only on submission", async () => {
  world = await fakeWorld({
    complete: () =>
      JSON.stringify({
        subjectId: null,
        proposed: {
          name: "Up Next",
          description: "Upcoming tasks",
          parentId: null,
          ancestors: [
            { name: "Lantern", description: "Product" },
            { name: "Sidebar", description: "Navigation" },
          ],
        },
      }),
  });
  await world.harness.behavior.callRpc("setPrefs", {
    patch: { newWork: { corpusClassification: true } },
  });
  const decision = (await world.harness.behavior.callRpc("route", {
    prompt: "Change upcoming tasks",
    suggest: true,
    draftKey: "draft",
  })) as { subjectId: string; name: string };
  expect(decision.name).toBe("Lantern: Sidebar: Up Next");
  expect(await world.harness.behavior.callRpc("corpus", null)).toEqual({
    entities: [],
  });
  await world.harness.behavior.callRpc("createWorkstream", {
    name: decision.name,
    description: "",
    subjectId: decision.subjectId,
  });
  const result = (await world.harness.behavior.callRpc("corpus", null)) as {
    entities: { name: string }[];
  };
  expect(result.entities.map((e) => e.name).sort()).toEqual([
    "Lantern",
    "Sidebar",
    "Up Next",
  ]);
});
