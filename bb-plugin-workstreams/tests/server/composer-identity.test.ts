import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { CorpusStore } from "../../src/server/corpus.ts";
import { openDatabase } from "../../src/server/db.ts";
import { savePrefs } from "../../src/server/prefs.ts";
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
    const shelves = corpus.remember(
      "Shelves",
      "Shelves feature",
      storageEntity.id,
    );

    // Submit thread with specific identity "Shelves"
    const { threadId } = (await w.harness.behavior.callRpc(
      "startThread",
      {
        identity: {
          entityId: shelves.id,
          provenance: "manual",
        },
        execution: defaultExecution,
      },
    )) as { threadId: string; sectionId: string | null };

    const { assignment } = (await w.harness.behavior.callRpc("taskAssignment", {
      threadId,
    })) as { assignment: CanonicalAssignment };

    expect(assignment.status).toBe("assigned");
    expect(assignment.entityId).toBe(shelves.id);
    expect(assignment.label).toBe("Storage: Shelves");
    expect(assignment.provenance).toBe("manual");
  });

  it("submitting identity assigns task without manual placement", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);

    const feature = corpus.remember("Feature Alpha", "Alpha feature");

    const { threadId: t1, sectionId: s1 } = (await w.harness.behavior.callRpc(
      "startThread",
      {
        identity: {
          entityId: feature.id,
          provenance: "manual",
        },
        execution: defaultExecution,
      },
    )) as { threadId: string; sectionId: string | null };

    expect(s1).toBeNull();
    const a1 = (await w.harness.behavior.callRpc("taskAssignment", {
      threadId: t1,
    })) as { assignment: CanonicalAssignment };
    expect(a1.assignment.entityId).toBe(feature.id);
    expect(a1.assignment.provenance).toBe("manual");
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

    const assignment = corpus.assignment("t-composed");
    expect(assignment.status).toBe("assigned");
    expect(assignment.entityId).toBe(feature.id);
    expect(assignment.provenance).toBe("manual");
  });

  it("stale route/restart fallback carries proposal", async () => {
    world = await fakeWorld({
      complete: ({ prompt }) => {
        if (prompt.includes("Classify the most specific")) {
          return JSON.stringify({
            subjectId: null,
            proposed: {
              name: "Brand New Feature",
              description: "Proposed in draft",
            },
          });
        }
        return JSON.stringify({ recap: "ok", state: "done" });
      },
    });
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

  it("pure draft classification in route preview does not mutate groups or bump revision", async () => {
    world = await fakeWorld({
      settings: { suggestions: true },
      complete: ({ prompt }) => {
        if (prompt.includes("## Catalog")) {
          return JSON.stringify({
            subjectId: null,
            proposed: {
              name: "Search System",
              description: "Search engine",
            },
          });
        }
        if (prompt.includes("Someone is starting new work")) {
          return JSON.stringify({
            outcome: "new-thread",
            workstream: "Unbound Navigation",
            title: "Search task",
            confidence: "high",
            reason: "Search task",
          });
        }
        return JSON.stringify({ recap: "r", state: "done", subject: null });
      },
    });
    const w = world;
    const db = openDatabase(w.bb);
    savePrefs(db, { newWork: { suggestions: true } });
    const corpus = new CorpusStore(db);

    const unbound = w.addSection("Unbound Navigation");
    const revBefore = corpus.revision();
    const groupsBefore = new Map(corpus.groups());

    const routeRes = (await w.harness.behavior.callRpc("route", {
      prompt: "Implement search indexing and retrieval",
      suggest: true,
      nativeComposer: true,
      draftKey: "draft-purity-check",
    })) as { id: string };

    expect(routeRes.id).toBeDefined();
    // Groups must not be synced or mutated during preview classification
    expect(corpus.revision()).toBe(revBefore);
    expect(corpus.groups()).toEqual(groupsBefore);
    expect(corpus.groups().get(unbound.id)).toBeUndefined();
  });

  it("filing in existing unbound section does not bind section to task identity", async () => {
    let featureId = "";
    world = await fakeWorld({
      settings: { suggestions: true },
      complete: ({ prompt }) => {
        if (prompt.includes("Classify the most specific"))
          return JSON.stringify({ subjectId: featureId, proposed: null });
        if (prompt.includes("Someone is starting new work")) {
          return JSON.stringify({
            outcome: "new-thread",
            workstream: "Unbound Legacy",
            title: "Auth task",
            confidence: "high",
            reason: "Auth task",
          });
        }
        return JSON.stringify({
          recap: "r",
          state: "done",
          subject: "Auth Feature",
        });
      },
    });
    const w = world;
    const db = openDatabase(w.bb);
    savePrefs(db, { newWork: { suggestions: true } });
    const corpus = new CorpusStore(db);

    const legacySection = w.addSection("Unbound Legacy");
    await w.harness.behavior.callRpc("refresh", null);
    const feature = corpus.remember("Auth Feature", "Auth description");
    featureId = feature.id;

    expect(corpus.groups().get(legacySection.id)).toBeUndefined();
    const revBefore = corpus.revision();

    // 1. Native submission via message.dispatch with an explicit sectionId and identity
    const composed = w.addThread("t-composed-unbound", {
      createdAt: Date.now(),
    });
    const hook = w.harness.registrations.hooks["message.dispatch"]!;

    await hook(
      makeMessageDispatchHookContext({
        thread: composed,
        input: { text: "Work on auth feature in legacy section" },
        parentThreadId: null,
        origin: "app",
        experimental_submission: {
          pluginId: "workstreams",
          data: {
            sectionId: legacySection.id,
            identity: {
              entityId: feature.id,
              provenance: "manual",
            },
          },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(corpus.assignment("t-composed-unbound").entityId).toBe(feature.id);

    // CRITICAL: The existing section must remain UNBOUND
    expect(corpus.groups().get(legacySection.id)).toBeUndefined();

    // 2. Active route decision recommending existing section via fileComposed
    const prompt = "Second auth task";
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt,
      suggest: true,
      nativeComposer: true,
      draftKey: "draft-auth-existing",
    })) as { id: string };

    const composed2 = w.addThread("t-composed-route", {
      createdAt: Date.now(),
    });
    await hook(
      makeMessageDispatchHookContext({
        thread: composed2,
        input: { text: prompt },
        parentThreadId: null,
        origin: "app",
        experimental_submission: {
          pluginId: "workstreams",
          data: {
            routeId: decision.id,
            sectionId: legacySection.id,
            identity: {
              entityId: feature.id,
              provenance: "manual",
            },
          },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(corpus.assignment("t-composed-route").entityId).toBe(feature.id);

    // CRITICAL: The existing section still must remain UNBOUND
    expect(corpus.groups().get(legacySection.id)).toBeUndefined();
  });

  it("message.dispatch forwards actual parentThreadId and preserves root inheritance", async () => {
    world = await fakeWorld({
      settings: { suggestions: true },
      complete: ({ prompt }) => {
        if (prompt.includes("Someone is starting new work")) {
          return JSON.stringify({
            outcome: "new-thread",
            workstream: "Root Section",
            title: "Child task",
            confidence: "high",
            reason: "Child task",
          });
        }
        return JSON.stringify({
          recap: "r",
          state: "done",
          subject: "Child Entity",
        });
      },
    });
    const w = world;
    const db = openDatabase(w.bb);
    savePrefs(db, { newWork: { suggestions: true } });
    const corpus = new CorpusStore(db);

    const rootEntity = corpus.remember("Root Entity", "Root task identity");
    const childEntity = corpus.remember("Child Entity", "Child task identity");

    const rootSection = w.addSection("Root Section");
    const rootThread = w.addThread("t-root-thread", {
      sectionId: rootSection.id,
      createdAt: Date.now() - 5000,
    });
    // Assign root thread to rootEntity
    corpus.assign(rootThread.id, rootEntity.id, { provenance: "manual" });
    expect(corpus.assignment(rootThread.id).entityId).toBe(rootEntity.id);

    // Call route for child prompt
    const childPrompt = "Subtask prompt to do inside root";
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt: childPrompt,
      suggest: true,
      nativeComposer: true,
      draftKey: "child-draft",
    })) as { id: string };

    const childThread = w.addThread("t-child-thread", {
      parentThreadId: rootThread.id,
      createdAt: Date.now(),
    });

    const hook = w.harness.registrations.hooks["message.dispatch"]!;
    await hook(
      makeMessageDispatchHookContext({
        thread: childThread,
        input: { text: childPrompt },
        parentThreadId: rootThread.id,
        origin: "app",
        experimental_submission: {
          pluginId: "workstreams",
          data: {
            routeId: decision.id,
            sectionId: rootSection.id,
            identity: {
              entityId: childEntity.id,
              provenance: "automatic",
            },
          },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    // 1. Parent thread id is preserved in seen thread, so findRootThread resolves root
    expect(corpus.findRootThread(childThread.id)).toBe(rootThread.id);

    // 2. Child thread inherits the root thread's identity
    const childAssign = corpus.assignment(childThread.id);
    expect(childAssign.status).toBe("assigned");
    expect(childAssign.inheritedFrom).toBe(rootThread.id);
    expect(childAssign.entityId).toBe(rootEntity.id);

    // 3. Crucial invariant: child submission never rewrote the root thread's identity
    const rootAssign = corpus.assignment(rootThread.id);
    expect(rootAssign.entityId).toBe(rootEntity.id);
    expect(rootAssign.provenance).toBe("manual");
  });

  it("stale route dispatch on child thread preserves parentThreadId and root identity", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);

    const rootEntity = corpus.remember("Root Project", "Root desc");
    const childEntity = corpus.remember("Child Feature", "Child desc");

    const rootSection = w.addSection("Root Section");
    const rootThread = w.addThread("t-root-2", {
      sectionId: rootSection.id,
      createdAt: Date.now() - 5000,
    });
    corpus.assign(rootThread.id, rootEntity.id, { provenance: "manual" });

    const childThread = w.addThread("t-child-2", {
      parentThreadId: rootThread.id,
      createdAt: Date.now(),
    });

    const hook = w.harness.registrations.hooks["message.dispatch"]!;
    await hook(
      makeMessageDispatchHookContext({
        thread: childThread,
        input: { text: "Child work prompt" },
        parentThreadId: rootThread.id,
        origin: "app",
        experimental_submission: {
          pluginId: "workstreams",
          data: {
            sectionId: rootSection.id,
            identity: {
              entityId: childEntity.id,
              provenance: "manual",
            },
          },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(corpus.findRootThread(childThread.id)).toBe(rootThread.id);
    expect(corpus.assignment(childThread.id).inheritedFrom).toBe(rootThread.id);
    expect(corpus.assignment(childThread.id).entityId).toBe(rootEntity.id);
    expect(corpus.assignment(rootThread.id).entityId).toBe(rootEntity.id);
  });

  it("fileComposed with manual unresolved override does not fall back to route decision subject", async () => {
    world = await fakeWorld({
      settings: { suggestions: true },
      complete: ({ prompt }) => {
        if (prompt.includes("## Catalog")) {
          return JSON.stringify({
            subjectId: feature.id,
            proposed: null,
          });
        }
        return JSON.stringify({
          outcome: "new-thread",
          workstream: "Alpha Section",
          title: "Feature task",
          confidence: "high",
          reason: "Fits Alpha",
          subjectId: feature.id,
        });
      },
    });
    const w = world;
    const db = openDatabase(w.bb);
    savePrefs(db, { newWork: { suggestions: true } });
    const corpus = new CorpusStore(db);

    const feature = corpus.remember(
      "Feature To Avoid",
      "Should not be assigned",
    );
    const alphaSection = w.addSection("Alpha Section");

    const prompt = "Do task without identity";
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt,
      suggest: true,
      nativeComposer: true,
      draftKey: "draft-unresolved",
    })) as { id: string };

    const composed = w.addThread("t-unresolved", { createdAt: Date.now() });
    const hook = w.harness.registrations.hooks["message.dispatch"]!;

    await hook(
      makeMessageDispatchHookContext({
        thread: composed,
        input: { text: prompt },
        parentThreadId: null,
        origin: "app",
        experimental_submission: {
          pluginId: "workstreams",
          data: {
            routeId: decision.id,
            sectionId: alphaSection.id,
            identity: {
              entityId: null,
              proposal: null,
              provenance: "manual",
            },
          },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(w.threads.get("t-unresolved")?.sectionId).toBeNull();
    const assignment = corpus.assignment("t-unresolved");
    expect(assignment.status).toBe("unresolved");
    expect(assignment.entityId).toBeNull();
  });

  it("startThread with manual unresolved leaves thread unresolved", async () => {
    world = await fakeWorld();
    const w = world;
    const db = openDatabase(w.bb);
    const corpus = new CorpusStore(db);

    const { threadId } = (await w.harness.behavior.callRpc("startThread", {
      identity: {
        entityId: null,
        proposal: null,
        provenance: "manual",
      },
      execution: defaultExecution,
    })) as { threadId: string };

    const assignment = corpus.assignment(threadId);
    expect(assignment.status).toBe("unresolved");
    expect(assignment.entityId).toBeNull();
  });
});
