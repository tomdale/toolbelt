import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import type {
  CanonicalAssignment,
  CatalogState,
} from "../../src/domain/corpus.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;

afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

describe("Catalog and Task Identity RPC Contract", () => {
  it("pure resolution resolves active home without creating sections", async () => {
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
    )) as CatalogState;
    expect(cat.revision).toBeGreaterThanOrEqual(1);
    expect(cat.entities.some((e) => e.id === entity.id)).toBe(true);

    // Resolve un-homed entity returns nulls without creating workstreams
    const resolved = (await w.harness.behavior.callRpc("catalogResolve", {
      entityId: entity.id,
    })) as { sectionId: string | null; name: string | null };
    expect(resolved.sectionId).toBeNull();
    expect(resolved.name).toBeNull();
  });

  it("taskAssign assigns task without moving thread section and preserves placement", async () => {
    world = await fakeWorld({
      complete: () => JSON.stringify({ recap: "r", state: "done" }),
    });
    const w = world;
    const alpha = w.addSection("Alpha");
    const thread = w.addThread("t-task", {
      sectionId: alpha.id,
      title: "My Task",
    });

    // Seed an entity
    const { entity: eng } = (await w.harness.behavior.callRpc("catalogCreate", {
      name: "Engineering",
      description: "Eng",
    })) as { entity: { id: string } };

    const assignResult = (await w.harness.behavior.callRpc("taskAssign", {
      threadId: thread.id,
      entityId: eng.id,
    })) as { assignment: CanonicalAssignment };

    expect(assignResult.assignment.status).toBe("assigned");
    expect(assignResult.assignment.entityId).toBe(eng.id);
    expect(assignResult.assignment.provenance).toBe("manual");

    // Thread is STILL in Alpha section! Native section placement did not move!
    expect(w.threads.get("t-task")?.sectionId).toBe(alpha.id);

    // Moving thread to another section preserves identity
    const beta = w.addSection("Beta");
    await w.harness.behavior.callRpc("moveThread", {
      threadId: thread.id,
      sectionId: beta.id,
    });
    expect(w.threads.get("t-task")?.sectionId).toBe(beta.id);

    const afterMove = (await w.harness.behavior.callRpc("taskAssignment", {
      threadId: thread.id,
    })) as { assignment: CanonicalAssignment };
    expect(afterMove.assignment.status).toBe("assigned");
    expect(afterMove.assignment.entityId).toBe(eng.id);

    // taskClear marks unresolved without moving thread
    const cleared = (await w.harness.behavior.callRpc("taskClear", {
      threadId: thread.id,
    })) as { assignment: CanonicalAssignment };
    expect(cleared.assignment.status).toBe("unresolved");
    expect(cleared.assignment.entityId).toBeNull();
    expect(w.threads.get("t-task")?.sectionId).toBe(beta.id);
  });

  it("taskReclassify sets automatic provenance with evidence", async () => {
    world = await fakeWorld({
      complete: () => JSON.stringify({ recap: "r", state: "done" }),
    });
    const w = world;
    const thread = w.addThread("t-auto", { title: "Auto Task" });

    const { entity: billing } = (await w.harness.behavior.callRpc(
      "catalogCreate",
      {
        name: "Billing",
        description: "Billing",
      },
    )) as { entity: { id: string } };

    const reclassResult = (await w.harness.behavior.callRpc("taskReclassify", {
      threadId: thread.id,
      entityId: billing.id,
      evidence: "evidence-hash-123",
    })) as { assignment: CanonicalAssignment };

    expect(reclassResult.assignment.status).toBe("assigned");
    expect(reclassResult.assignment.entityId).toBe(billing.id);
    expect(reclassResult.assignment.provenance).toBe("automatic");
    expect(reclassResult.assignment.evidence).toBe("evidence-hash-123");
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
    const assignAfterMerge = (await w.harness.behavior.callRpc(
      "taskAssignment",
      { threadId: thread.id },
    )) as { assignment: CanonicalAssignment };
    expect(assignAfterMerge.assignment.entityId).toBe(beta.id);

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
});
