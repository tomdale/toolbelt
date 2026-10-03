import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { CorpusStore } from "../../src/server/corpus.ts";
import { openDatabase } from "../../src/server/db.ts";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import type { CanonicalAssignment } from "../../src/domain/corpus.ts";
import { matchesEntity } from "../../src/app/composer/WorkstreamPicker.tsx";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;

afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

const defaultExecution = {
  projectId: "proj_1",
  environment: {
    type: "host" as const,
    hostId: "host_1",
    workspace: { type: "unmanaged" as const, path: null },
  },
  providerId: "codex",
  model: "gpt-5",
  reasoningLevel: "medium",
  permissionMode: "auto",
  executionInputSources: {},
  input: [{ type: "text" as const, text: "Do task", mentions: [] }],
};

describe("Phase 2 Composer Identity & Navigation Separation", () => {
  it("abandon inactive identity draft -> zero mutations", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);

    const initialRev = corpus.revision();
    const storage = corpus.remember("Storage", "Storage product");
    const shelves = corpus.remember("Shelves", "Shelves feature", storage.id, [
      "Bookcase",
    ]);

    const revBeforeDraft = corpus.revision();
    const entitiesBefore = corpus.list();
    const sectionsBefore = [...w.sections];

    // User explores/resolves inactive identity in composer
    const resolved = (await w.harness.behavior.callRpc("catalogResolve", {
      entityId: shelves.id,
    })) as { sectionId: string | null; name: string | null };

    // Pure draft resolution: no section created, no mutations
    expect(resolved.sectionId).toBeNull();
    expect(resolved.name).toBeNull();

    // Abandon draft without submitting
    expect(corpus.revision()).toBe(revBeforeDraft);
    expect(corpus.list()).toEqual(entitiesBefore);
    expect(w.sections).toEqual(sectionsBefore);
    expect(corpus.assignments()).toEqual({});
    expect(corpus.groups()).toEqual(new Map());
  });

  it("submit identity in broader home", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);

    const storageSection = w.addSection("Storage");
    await w.harness.behavior.callRpc("refresh", null);
    const storageEntity = corpus.remember("Storage", "Storage product");
    corpus.bindGroup(storageSection.id, storageEntity.id);
    const shelves = corpus.remember("Shelves", "Shelves feature", storageEntity.id);

    // Submit thread in broader home "Storage", with specific identity "Shelves"
    const { threadId, sectionId } = (await w.harness.behavior.callRpc(
      "startThread",
      {
        sectionId: storageSection.id,
        identity: {
          entityId: shelves.id,
          provenance: "manual",
        },
        execution: defaultExecution,
      },
    )) as { threadId: string; sectionId: string };

    expect(sectionId).toBe(storageSection.id);
    expect(w.threads.get(threadId)?.sectionId).toBe(storageSection.id);

    const { assignment } = (await w.harness.behavior.callRpc("taskAssignment", {
      threadId,
    })) as { assignment: CanonicalAssignment };

    expect(assignment.status).toBe("assigned");
    expect(assignment.entityId).toBe(shelves.id);
    expect(assignment.label).toBe("Storage: Shelves");
    expect(assignment.provenance).toBe("manual");
  });

  it("placement override preserves identity", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);

    const alpha = w.addSection("Alpha");
    const beta = w.addSection("Beta");
    await w.harness.behavior.callRpc("refresh", null);
    const feature = corpus.remember("Feature Alpha", "Alpha feature");
    corpus.bindGroup(alpha.id, feature.id);

    // Manual placement override: user chooses Beta instead of Alpha, keeping Feature Alpha identity
    const { threadId: t1, sectionId: s1 } = (await w.harness.behavior.callRpc(
      "startThread",
      {
        sectionId: beta.id,
        identity: {
          entityId: feature.id,
          provenance: "manual",
        },
        execution: defaultExecution,
      },
    )) as { threadId: string; sectionId: string };

    expect(s1).toBe(beta.id);
    expect(w.threads.get(t1)?.sectionId).toBe(beta.id);

    const a1 = (await w.harness.behavior.callRpc("taskAssignment", {
      threadId: t1,
    })) as { assignment: CanonicalAssignment };
    expect(a1.assignment.entityId).toBe(feature.id);
    expect(a1.assignment.provenance).toBe("manual");

    // Manual placement override: user chooses No workstream (null), keeping Feature Alpha identity
    const { threadId: t2, sectionId: s2 } = (await w.harness.behavior.callRpc(
      "startThread",
      {
        sectionId: null,
        identity: {
          entityId: feature.id,
          provenance: "manual",
        },
        execution: defaultExecution,
      },
    )) as { threadId: string; sectionId: string | null };

    expect(s2).toBeNull();
    expect(w.threads.get(t2)?.sectionId).toBeNull();

    const a2 = (await w.harness.behavior.callRpc("taskAssignment", {
      threadId: t2,
    })) as { assignment: CanonicalAssignment };
    expect(a2.assignment.entityId).toBe(feature.id);
  });

  it("explicit selection stays manual", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);

    const feature = corpus.remember("Manual Feature", "Explicitly selected");

    const { threadId } = (await w.harness.behavior.callRpc("startThread", {
      sectionId: null,
      identity: {
        entityId: feature.id,
        provenance: "manual",
      },
      execution: defaultExecution,
    })) as { threadId: string };

    const { assignment } = (await w.harness.behavior.callRpc("taskAssignment", {
      threadId,
    })) as { assignment: CanonicalAssignment };
    expect(assignment.provenance).toBe("manual");

    // Immune to fresh checks / reclassification across restarts
    const reloadedCorpus = new CorpusStore(openDatabase(w.bb));
    expect(reloadedCorpus.isFresh(threadId, "new-classifier-evidence")).toBe(
      true,
    );
  });

  it("accepting suggestion stays automatic", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);

    const feature = corpus.remember("Auto Feature", "Classified feature");

    const { threadId } = (await w.harness.behavior.callRpc("startThread", {
      sectionId: null,
      identity: {
        entityId: feature.id,
        provenance: "automatic",
      },
      execution: defaultExecution,
    })) as { threadId: string };

    const { assignment } = (await w.harness.behavior.callRpc("taskAssignment", {
      threadId,
    })) as { assignment: CanonicalAssignment };
    expect(assignment.provenance).toBe("automatic");
  });

  it("stale route/restart fallback carries stable identity", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);

    const alpha = w.addSection("Alpha");
    const feature = corpus.remember("Stable Identity", "Durable entity");

    const composed = w.addThread("t-composed", { createdAt: Date.now() });
    const hook = w.harness.registrations.hooks["message.dispatch"]!;

    // Route decision is expired/stale (not in router memory)
    await hook(
      makeMessageDispatchHookContext({
        thread: composed,
        input: { text: "Work on stable identity" },
        parentThreadId: null,
        origin: "app",
        experimental_submission: {
          pluginId: "workstreams",
          data: {
            routeId: "stale-expired-uuid",
            sectionId: alpha.id,
            identity: {
              entityId: feature.id,
              provenance: "manual",
            },
          },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(w.threads.get("t-composed")?.sectionId).toBe(alpha.id);
    const assignment = corpus.assignment("t-composed");
    expect(assignment.status).toBe("assigned");
    expect(assignment.entityId).toBe(feature.id);
    expect(assignment.provenance).toBe("manual");
  });

  it("stale route/restart fallback carries proposal", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);

    const alpha = w.addSection("Alpha");
    const composed = w.addThread("t-proposal", { createdAt: Date.now() });
    const hook = w.harness.registrations.hooks["message.dispatch"]!;

    // Fallback carries explicit draft proposal
    await hook(
      makeMessageDispatchHookContext({
        thread: composed,
        input: { text: "Brand new feature" },
        parentThreadId: null,
        origin: "app",
        experimental_submission: {
          pluginId: "workstreams",
          data: {
            routeId: "stale-expired-uuid",
            sectionId: alpha.id,
            identity: {
              proposal: {
                name: "Brand New Feature",
                description: "Proposed in draft",
              },
              provenance: "automatic",
            },
          },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(w.threads.get("t-proposal")?.sectionId).toBe(alpha.id);
    const created = corpus.list().find((e) => e.name === "Brand New Feature");
    expect(created).toBeDefined();

    const assignment = corpus.assignment("t-proposal");
    expect(assignment.status).toBe("assigned");
    expect(assignment.entityId).toBe(created!.id);
    expect(assignment.provenance).toBe("automatic");
  });

  it("failed spawn leaves no unintended Catalog or groups", async () => {
    world = await fakeWorld({
      spawn: async () => {
        throw new Error("Simulated spawn failure: VM out of memory");
      },
    });
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);

    const initialEntities = corpus.list();
    const initialSections = [...w.sections];
    const initialGroups = new Map(corpus.groups());

    await expect(
      w.harness.behavior.callRpc("startThread", {
        sectionId: null,
        newWorkstream: {
          name: "Doomed Section",
          description: "Should not persist",
        },
        identity: {
          proposal: {
            name: "Doomed Feature",
            description: "Should not persist",
          },
          provenance: "automatic",
        },
        execution: defaultExecution,
      }),
    ).rejects.toThrow(/Simulated spawn failure/);

    // Verify zero unintended mutations in Catalog, sections, and groups
    expect(corpus.list()).toEqual(initialEntities);
    expect(w.sections).toEqual(initialSections);
    expect(corpus.groups()).toEqual(initialGroups);
  });

  it("search matches ancestry and aliases", () => {
    const root = {
      id: "root-1",
      name: "Storage",
      description: "Storage product",
      parentId: null,
      aliases: ["Warehouse", "Vault"],
    };
    const child = {
      id: "child-1",
      name: "Shelves",
      description: "Shelving unit",
      parentId: "root-1",
      aliases: ["Racks"],
    };
    const grandchild = {
      id: "grandchild-1",
      name: "Top Shelf",
      description: "Highest shelf",
      parentId: "child-1",
      aliases: ["Peak"],
    };
    const entities = [root, child, grandchild];

    // Matches entity name
    expect(matchesEntity(child, entities, "Shelves")).toBe(true);

    // Matches entity alias
    expect(matchesEntity(child, entities, "Racks")).toBe(true);

    // Matches ancestor name
    expect(matchesEntity(child, entities, "Storage")).toBe(true);

    // Matches ancestor alias
    expect(matchesEntity(child, entities, "Warehouse")).toBe(true);
    expect(matchesEntity(child, entities, "Vault")).toBe(true);

    // Grandchild matches all ancestral names and aliases
    expect(matchesEntity(grandchild, entities, "Storage")).toBe(true);
    expect(matchesEntity(grandchild, entities, "Vault")).toBe(true);
    expect(matchesEntity(grandchild, entities, "Shelves")).toBe(true);
    expect(matchesEntity(grandchild, entities, "Racks")).toBe(true);
    expect(matchesEntity(grandchild, entities, "Peak")).toBe(true);

    // Non-matching query returns false
    expect(matchesEntity(child, entities, "NonexistentQuery")).toBe(false);
  });
});
