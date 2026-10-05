import { afterEach, expect, it } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld } from "./fake-bb.ts";
let world: Awaited<ReturnType<typeof fakeWorld>> | null = null;
/** Starts a thread from the New thread view with the banner's identity. */
async function compose(
  w: NonNullable<typeof world>,
  identity: Record<string, unknown>,
): Promise<{ threadId: string }> {
  const thread = w.addThread("t-composed", { createdAt: Date.now() });
  await w.harness.registrations.hooks["message.dispatch"]!(
    makeMessageDispatchHookContext({
      thread,
      input: { text: "Composed" },
      parentThreadId: null,
      origin: "app",
      experimental_submission: {
        pluginId: "workstreams",
        data: { identity } as never,
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { threadId: thread.id };
}
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
  const decision = (await world.harness.behavior.callRpc("route", {
    prompt: "Change upcoming tasks",
    suggest: true,
    draftKey: "draft",
  })) as { subjectId: string | null; proposal?: unknown; name: string };
  expect(decision.name).toBe("Lantern: Sidebar: Up Next");
  expect(decision.subjectId).toBeNull();
  expect(decision.proposal).toMatchObject({
    name: "Up Next",
  });
  expect(
    ((await world.harness.behavior.callRpc("catalog", null)) as { entities: unknown[] })
      .entities,
  ).toEqual([]);
  await compose(world!, {
      proposal: decision.proposal,
    });
  const result = (await world.harness.behavior.callRpc("catalog", null)) as {
    entities: { name: string }[];
  };
  expect(result.entities.map((e) => e.name).sort()).toEqual([
    "Lantern",
    "Sidebar",
    "Up Next",
  ]);
});
it("files a discovery under its existing parent when the classifier restates that parent", async () => {
  let subagentsId = "";
  world = await fakeWorld({
    // The classifier names Subagents as the parent and repeats it as a
    // missing ancestor.
    complete: () =>
      JSON.stringify({
        subjectId: null,
        proposed: {
          name: "Workforest",
          description:
            "Plugin for new thread UI providing workspace isolation functionality",
          parentId: subagentsId,
          ancestors: [
            {
              name: "Subagents",
              description: "Subagent orchestration and plugin platform",
            },
          ],
        },
      }),
  });
  const { entity } = (await world.harness.behavior.callRpc("catalogCreate", {
    name: "Subagents",
    description: "Background subagent workers",
  })) as { entity: { id: string } };
  subagentsId = entity.id;
  const decision = (await world.harness.behavior.callRpc("route", {
    prompt: "Remove the isolated workspace UI the workforest plugin injects",
    suggest: true,
    draftKey: "draft",
  })) as {
    outcome: string;
    name: string;
    description: string;
    proposal?: unknown;
  };
  expect(decision.outcome).toBe("new-workstream");
  expect(decision.name).toBe("Subagents: Workforest");
  const { threadId } = await compose(world!, { proposal: decision.proposal, provenance: "automatic" });
  await world.harness.behavior.callRpc("organization", { action: "rebuild" });
  const catalog = (await world.harness.behavior.callRpc("catalog", null)) as {
    entities: {
      id: string;
      name: string;
      description: string;
      parentId: string | null;
    }[];
    assignments: Record<string, { label: string | null }>;
  };
  expect(
    catalog.entities.map(({ name, parentId }) => ({ name, parentId })),
  ).toEqual(
    expect.arrayContaining([
      { name: "Subagents", parentId: null },
      { name: "Workforest", parentId: subagentsId },
    ]),
  );
  expect(catalog.entities).toHaveLength(2);
  expect(catalog.entities.find((e) => e.id === subagentsId)?.description).toBe(
    "Background subagent workers",
  );
  expect(catalog.assignments[threadId]?.label).toBe("Subagents: Workforest");
  expect(world.sections.map((s) => s.name)).toEqual(["Subagents"]);
});
