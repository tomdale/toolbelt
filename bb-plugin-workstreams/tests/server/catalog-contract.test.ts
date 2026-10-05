import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import type {
  TopicAssignment,
  TopicState,
} from "../../src/domain/topics.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;

afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

describe("Catalog and Task Identity RPC Contract", () => {
  it("creates topics without creating workstreams", async () => {
    world = await fakeWorld({
      complete: () =>
        JSON.stringify({
          workstreams: [],
          assignments: [],
        }),
    });
    const w = world;

    // Create an entity in the catalog
    const { entity } = (await w.harness.behavior.callRpc("catalogCreate", {
      name: "Core Platform",
      description: "Platform work",
    })) as { entity: { id: string } };

    // Verify catalog RPC returns state
    const cat = (await w.harness.behavior.callRpc(
      "catalog",
      null,
    )) as TopicState;
    expect(cat.revision).toBeGreaterThanOrEqual(1);
    expect(cat.entities.some((e) => e.id === entity.id)).toBe(true);

    // Creating a topic no thread has creates no workstream.
    expect(w.sections).toHaveLength(0);
  });

  it("taskAssign sets a topic yourself, which files the thread by it", async () => {
    world = await fakeWorld({
      complete: () => JSON.stringify({ recap: "r", state: "done" }),
    });
    const w = world;
    const alpha = w.addSection("Alpha");
    const thread = w.addThread("t-task", {
      sectionId: alpha.id,
      title: "My Task",
    });
    const { entity: eng } = (await w.harness.behavior.callRpc("catalogCreate", {
      name: "Engineering",
      description: "Eng",
    })) as { entity: { id: string } };

    const assignResult = (await w.harness.behavior.callRpc("taskAssign", {
      threadId: thread.id,
      entityId: eng.id,
    })) as { assignment: TopicAssignment };
    expect(assignResult.assignment).toMatchObject({
      status: "assigned",
      entityId: eng.id,
      provenance: "manual",
    });
    await w.harness.behavior.callRpc("organization", { action: "rebuild" });
    const engineering = w.sections.find((s) => s.name === "Engineering")!;
    expect(w.threads.get("t-task")?.sectionId).toBe(engineering.id);

    // No topic, set yourself, leaves it Unfiled.
    const cleared = (await w.harness.behavior.callRpc("taskAssign", {
      threadId: thread.id,
      entityId: null,
    })) as { assignment: TopicAssignment };
    expect(cleared.assignment).toMatchObject({
      status: "unresolved",
      provenance: "manual",
    });
    await w.harness.behavior.callRpc("organization", { action: "rebuild" });
    expect(w.threads.get("t-task")?.sectionId).toBeNull();
  });

  it("catalogRename, catalogReparent, and catalogMerge maintain referential integrity", async () => {
    world = await fakeWorld({
      complete: () => JSON.stringify({ recap: "r", state: "done" }),
    });
    const w = world;

    const { entity: alpha } = (await w.harness.behavior.callRpc(
      "catalogCreate",
      {
        name: "AlphaFeature",
        description: "Alpha",
      },
    )) as { entity: { id: string } };
    const { entity: beta } = (await w.harness.behavior.callRpc(
      "catalogCreate",
      {
        name: "BetaFeature",
        description: "Beta",
      },
    )) as { entity: { id: string } };

    // Rename
    const renameRes = (await w.harness.behavior.callRpc("catalogRename", {
      entityId: alpha.id,
      name: "AlphaRenamed",
    })) as { entity: { name: string } };
    expect(renameRes.entity.name).toBe("AlphaRenamed");

    // Reparent Alpha under Beta
    const reparentRes = (await w.harness.behavior.callRpc("catalogReparent", {
      entityId: alpha.id,
      parentId: beta.id,
    })) as { entity: { parentId: string | null } };
    expect(reparentRes.entity.parentId).toBe(beta.id);

    // Reparenting Beta under Alpha is rejected as a cycle
    await expect(
      w.harness.behavior.callRpc("catalogReparent", {
        entityId: beta.id,
        parentId: alpha.id,
      }),
    ).rejects.toThrow(/cycle/);

    // Assign thread to Alpha
    const thread = w.addThread("t-target");
    await w.harness.behavior.callRpc("taskAssign", {
      threadId: thread.id,
      entityId: alpha.id,
    });

    // Merge Alpha into Beta
    const mergeRes = (await w.harness.behavior.callRpc("catalogMerge", {
      sourceEntityId: alpha.id,
      targetEntityId: beta.id,
    })) as {
      target: { name: string; aliases: string[] };
      affectedThreads: number;
    };

    expect(mergeRes.affectedThreads).toBe(1);
    expect(mergeRes.target.aliases).toContain("AlphaRenamed");

    // Thread is now assigned to Beta
    const afterMerge = (await w.harness.behavior.callRpc(
      "catalog",
      null,
    )) as TopicState;
    expect(afterMerge.assignments[thread.id]?.entityId).toBe(beta.id);

    // Update metadata (description and aliases)
    const updateRes = (await w.harness.behavior.callRpc(
      "catalogUpdateMetadata",
      {
        entityId: beta.id,
        description: "New beta description",
        aliases: ["BetaAlias1", "BetaAlias2"],
      },
    )) as { entity: { description: string; aliases: string[] } };
    expect(updateRes.entity.description).toBe("New beta description");
    expect(updateRes.entity.aliases).toContain("BetaAlias1");
  });

  it("catalog and state reads are pure and do not increment catalog revision", async () => {
    world = await fakeWorld({
      complete: () => JSON.stringify({ recap: "r", state: "done" }),
    });
    const w = world;

    await w.harness.behavior.callRpc("catalogCreate", {
      name: "Infra",
      description: "Infrastructure",
    });

    const initial = (await w.harness.behavior.callRpc(
      "catalog",
      null,
    )) as TopicState;
    const initialRev = initial.revision;

    for (let i = 0; i < 5; i++) {
      const readCatalog = (await w.harness.behavior.callRpc(
        "catalog",
        null,
      )) as TopicState;
      expect(readCatalog.revision).toBe(initialRev);

      await w.harness.behavior.callRpc("state", null);
    }
  });

  it("catalogUpdateMetadata updates metadata atomically and handles no-ops and collisions", async () => {
    world = await fakeWorld({
      complete: () => JSON.stringify({ recap: "r", state: "done" }),
    });
    const w = world;

    const { entity: alpha } = (await w.harness.behavior.callRpc(
      "catalogCreate",
      {
        name: "AlphaService",
        description: "Initial description",
        aliases: ["Alpha1"],
      },
    )) as { entity: { id: string } };

    const { entity: beta } = (await w.harness.behavior.callRpc(
      "catalogCreate",
      {
        name: "BetaService",
        description: "Beta description",
      },
    )) as { entity: { id: string } };

    // Update metadata on AlphaService
    const updated = (await w.harness.behavior.callRpc("catalogUpdateMetadata", {
      entityId: alpha.id,
      description: "Updated description",
      aliases: ["AlphaAlias"],
    })) as { entity: { description: string; aliases: string[] } };

    expect(updated.entity.description).toBe("Updated description");
    expect(updated.entity.aliases).toEqual(["AlphaAlias"]);

    // Colliding alias with existing entity name in parent scope fails
    await expect(
      w.harness.behavior.callRpc("catalogUpdateMetadata", {
        entityId: beta.id,
        aliases: ["AlphaService"],
      }),
    ).rejects.toThrow();

    // No-op does not bump revision
    const catBefore = (await w.harness.behavior.callRpc(
      "catalog",
      null,
    )) as TopicState;
    await w.harness.behavior.callRpc("catalogUpdateMetadata", {
      entityId: alpha.id,
      description: "Updated description",
      aliases: ["AlphaAlias"],
    });
    const catAfter = (await w.harness.behavior.callRpc(
      "catalog",
      null,
    )) as TopicState;
    expect(catAfter.revision).toBe(catBefore.revision);
  });

  it("taskAssign on a child sets its root's topic", async () => {
    world = await fakeWorld({
      complete: () => JSON.stringify({ recap: "r", state: "done" }),
    });
    const w = world;
    const rootThread = w.addThread("t-root", { title: "Root Thread" });
    const childThread = w.addThread("t-child", {
      parentThreadId: rootThread.id,
      title: "Child Thread",
    });
    const { entity: feature } = (await w.harness.behavior.callRpc(
      "catalogCreate",
      { name: "FeatureX", description: "Desc" },
    )) as { entity: { id: string } };
    const assignRes = (await w.harness.behavior.callRpc("taskAssign", {
      threadId: childThread.id,
      entityId: feature.id,
    })) as { assignment: TopicAssignment };
    expect(assignRes.assignment.entityId).toBe(feature.id);
    expect(assignRes.assignment.inheritedFrom).toBe(rootThread.id);
    const catalog = (await w.harness.behavior.callRpc(
      "catalog",
      null,
    )) as TopicState;
    expect(catalog.assignments[rootThread.id]?.entityId).toBe(feature.id);
  });

  it("taskReclassify hands the topic back and settles the root with Full analysis", async () => {
    let capturedPrompt = "";
    let topicId = "";
    world = await fakeWorld({
      complete: (call) => {
        capturedPrompt = call.prompt;
        return JSON.stringify({
          recap: "Designing the invoice engine",
          state: "in_progress",
          goal: "Billing invoice engine",
          subjectId: topicId,
          proposed: null,
        });
      },
    });
    const w = world;
    const { entity: billing } = (await w.harness.behavior.callRpc(
      "catalogCreate",
      { name: "Billing", description: "Billing invoices" },
    )) as { entity: { id: string } };
    topicId = billing.id;
    const rootThread = w.addThread("t-root", {
      title: "Root Billing Work",
      status: "idle",
    });
    const childThread = w.addThread("t-child", {
      parentThreadId: rootThread.id,
      title: "Child Typo Fix",
    });
    w.converse("t-root", ["Please design billing invoice engine"]);
    w.converse("t-child", ["Fix minor typo in css"]);
    await w.harness.behavior.callRpc("taskAssign", {
      threadId: rootThread.id,
      entityId: null,
    });

    const reclassRes = (await w.harness.behavior.callRpc("taskReclassify", {
      threadId: childThread.id,
    })) as { assignment: TopicAssignment };
    expect(reclassRes.assignment).toMatchObject({
      status: "assigned",
      entityId: billing.id,
      inheritedFrom: rootThread.id,
      provenance: "full",
    });
    expect(capturedPrompt).toContain("Please design billing invoice engine");
    expect(capturedPrompt).not.toContain("Fix minor typo in css");
  });
});
