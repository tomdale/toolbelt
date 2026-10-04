import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import {
  CorpusStore,
  classificationEvidence,
} from "../../src/server/corpus.ts";
import { openDatabase } from "../../src/server/db.ts";
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

    // Changing thread section in BB preserves identity
    const beta = w.addSection("Beta");
    w.threads.set(thread.id, { ...w.threads.get(thread.id)!, sectionId: beta.id });
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
    )) as CatalogState;
    const initialRev = initial.revision;

    for (let i = 0; i < 5; i++) {
      const readCatalog = (await w.harness.behavior.callRpc(
        "catalog",
        null,
      )) as CatalogState;
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
    )) as CatalogState;
    await w.harness.behavior.callRpc("catalogUpdateMetadata", {
      entityId: alpha.id,
      description: "Updated description",
      aliases: ["AlphaAlias"],
    });
    const catAfter = (await w.harness.behavior.callRpc(
      "catalog",
      null,
    )) as CatalogState;
    expect(catAfter.revision).toBe(catBefore.revision);
  });

  it("taskAssign and taskAssignment reconcile roots so child threads correctly inherit root assignment", async () => {
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
      {
        name: "FeatureX",
        description: "Desc",
      },
    )) as { entity: { id: string } };

    // Assigning on child thread reconciles and assigns to root
    const assignRes = (await w.harness.behavior.callRpc("taskAssign", {
      threadId: childThread.id,
      entityId: feature.id,
    })) as { assignment: CanonicalAssignment };

    expect(assignRes.assignment.entityId).toBe(feature.id);
    expect(assignRes.assignment.inheritedFrom).toBe(rootThread.id);

    // Root thread itself is assigned
    const rootAssign = (await w.harness.behavior.callRpc("taskAssignment", {
      threadId: rootThread.id,
    })) as { assignment: CanonicalAssignment };
    expect(rootAssign.assignment.entityId).toBe(feature.id);
    expect(rootAssign.assignment.inheritedFrom).toBeNull();
  });

  it("taskReclassify on child thread infers and hashes evidence of active root thread, preserving root freshness", async () => {
    let capturedPrompt = "";
    let mockEntityId = "";
    world = await fakeWorld({
      complete: (call) => {
        capturedPrompt = call.prompt;
        return JSON.stringify({
          subjectId: mockEntityId,
          proposed: null,
        });
      },
    });
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);

    const { entity: billing } = (await w.harness.behavior.callRpc(
      "catalogCreate",
      {
        name: "Billing",
        description: "Billing invoices",
      },
    )) as { entity: { id: string } };
    mockEntityId = billing.id;

    const rootThread = w.addThread("t-root", { title: "Root Billing Work" });
    const childThread = w.addThread("t-child", {
      parentThreadId: rootThread.id,
      title: "Child Typo Fix",
    });

    w.converse("t-root", ["Please design billing invoice engine"]);
    w.converse("t-child", ["Fix minor typo in css"]);

    // Populate analysis recap for root and child
    db.prepare(
      "INSERT INTO ws_analysis(thread_id, revision, at, result) VALUES (?, 1, 1, ?)",
    ).run(
      rootThread.id,
      JSON.stringify({
        recap: "Billing system architecture and invoice pipeline",
        state: "idle",
        needsYou: null,
        subject: null,
        drift: null,
      }),
    );
    db.prepare(
      "INSERT INTO ws_analysis(thread_id, revision, at, result) VALUES (?, 1, 1, ?)",
    ).run(
      childThread.id,
      JSON.stringify({
        recap: "CSS color tweak",
        state: "idle",
        needsYou: null,
        subject: null,
        drift: null,
      }),
    );

    // Call taskReclassify on the CHILD thread
    const reclassRes = (await w.harness.behavior.callRpc("taskReclassify", {
      threadId: childThread.id,
    })) as { assignment: CanonicalAssignment };

    // The assignment returned reflects the child thread's inherited assignment
    expect(reclassRes.assignment.status).toBe("assigned");
    expect(reclassRes.assignment.entityId).toBe(billing.id);
    expect(reclassRes.assignment.inheritedFrom).toBe(rootThread.id);
    expect(reclassRes.assignment.provenance).toBe("automatic");

    // The classifier prompt contained ROOT title and recap, NOT child
    expect(capturedPrompt).toContain("Root Billing Work");
    expect(capturedPrompt).toContain(
      "Billing system architecture and invoice pipeline",
    );
    expect(capturedPrompt).not.toContain("Child Typo Fix");
    expect(capturedPrompt).not.toContain("CSS color tweak");

    // Compute expected evidence from ROOT thread's evidence matching Organize
    const projects = await w.bb.sdk.projects.list();
    const projectName =
      (rootThread.projectId
        ? projects.find((p) => p.id === rootThread.projectId)?.name
        : null) ?? null;
    const rootEvidence = classificationEvidence({
      requests: ["Please design billing invoice engine"],
      title: rootThread.title,
      project: projectName,
    });

    // Root thread must be fresh against root evidence
    expect(corpus.isFresh(rootThread.id, rootEvidence)).toBe(true);
    // Child thread query also resolves through root and is fresh
    expect(corpus.isFresh(childThread.id, rootEvidence)).toBe(true);
  });
});
