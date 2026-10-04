import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { openDatabase } from "../../src/server/db.ts";
import { CorpusStore, classificationEvidence } from "../../src/server/corpus.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

async function setup(options: { onPrompt?: (prompt: string) => void } = {}) {
  let shelvesId = "";
  world = await fakeWorld({
    settings: { debug: true },
    complete: ({ prompt }) => {
      options.onPrompt?.(prompt);
      if (prompt.includes("Classify the most specific")) {
        return JSON.stringify({
          subjectId: shelvesId,
          proposed: null,
        });
      }
      if (prompt.includes("Choose active navigation")) {
        return JSON.stringify({ activeEntityIds: [storage.id] });
      }
      return JSON.stringify({ recap: "Working on it", state: "in_progress", subject: null });
    },
  });
  const w = world;
  const section = w.addSection("Storage");
  const corpus = new CorpusStore(openDatabase(w.bb));
  const storage = corpus.remember("Storage", "Storage product", null, ["Warehouse"]);
  const shelves = corpus.remember("Shelves", "Shelves feature", storage.id, ["Racks"]);
  shelvesId = shelves.id;
  corpus.syncGroups([{ sectionId: section.id, name: "Storage", description: "Storage product", aliases: [] }]);
  const rootThread = w.addThread("t_root", {
    sectionId: section.id,
    title: "Root shelves task",
  });
  const childThread = w.addThread("t_child", {
    parentThreadId: rootThread.id,
    title: "Child review subtask",
  });
  corpus.assign(rootThread.id, shelves.id, { provenance: "automatic", evidence: "ev_1" });
  await w.harness.behavior.callRpc("refresh", null);
  return { w, section, corpus, storage, shelves, rootThread, childThread };
}

describe("CLI Catalog commands", () => {
  it("catalog list prints sorted lexical complete list and supports --json", async () => {
    const { w, storage, shelves } = await setup();

    // Human output
    const listRes = await w.harness.behavior.runCli(["catalog", "list"]);
    expect(listRes.exitCode).toBe(0);
    expect(listRes.stdout).toContain("Storage");
    expect(listRes.stdout).toContain("Storage: Shelves");
    expect(listRes.stdout).toContain(storage.id);
    expect(listRes.stdout).toContain(shelves.id);
    expect(listRes.stdout).toContain("[aliases: Warehouse]");
    expect(listRes.stdout).toContain("[aliases: Racks]");

    // JSON output
    const jsonRes = await w.harness.behavior.runCli(["catalog", "list", "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.stdout);
    expect(parsed.entities).toHaveLength(2);
    expect(parsed.entities.map((e: { name: string }) => e.name).sort()).toEqual(["Shelves", "Storage"]);
  });

  it("catalog show displays full details by name, alias, or ID and supports --json", async () => {
    const { w, storage, shelves, rootThread } = await setup();

    // Show by exact name
    const showName = await w.harness.behavior.runCli(["catalog", "show", "Shelves"]);
    expect(showName.exitCode).toBe(0);
    expect(showName.stdout).toContain("Product/Feature: Storage: Shelves");
    expect(showName.stdout).toContain(`ID:              ${shelves.id}`);
    expect(showName.stdout).toContain("Aliases:         Racks");
    expect(showName.stdout).toContain("Assigned tasks:  2");

    // Show by alias
    const showAlias = await w.harness.behavior.runCli(["catalog", "show", "Warehouse"]);
    expect(showAlias.exitCode).toBe(0);
    expect(showAlias.stdout).toContain(`ID:              ${storage.id}`);

    // Show by ID with --json
    const showJson = await w.harness.behavior.runCli(["catalog", "show", shelves.id, "--json"]);
    expect(showJson.exitCode).toBe(0);
    const parsed = JSON.parse(showJson.stdout);
    expect(parsed.entity.id).toBe(shelves.id);
    expect(parsed.path).toBe("Storage: Shelves");
    expect(parsed.assignedThreads).toContain(rootThread.id);

    // Unknown entity throws clean error
    const showUnknown = await w.harness.behavior.runCli(["catalog", "show", "NonExistent"]);
    expect(showUnknown.exitCode).not.toBe(0);
  });

  it("catalog create creates a new product or feature with parent and aliases", async () => {
    const { w, corpus } = await setup();

    const createRes = await w.harness.behavior.runCli([
      "catalog",
      "create",
      "Bins",
      "--description",
      "Storage bins",
      "--parent",
      "Storage",
      "--aliases",
      "Containers,Tubs",
    ]);
    expect(createRes.exitCode).toBe(0);
    expect(createRes.stdout).toContain('Created product/feature "Bins"');

    const created = corpus.list().find((e) => e.name === "Bins")!;
    expect(created).toBeDefined();
    expect(created.description).toBe("Storage bins");
    expect(created.aliases.sort()).toEqual(["Containers", "Tubs"]);
    const storage = corpus.list().find((e) => e.name === "Storage")!;
    expect(created.parentId).toBe(storage.id);
  });

  it("catalog edit updates name, description, and aliases atomically", async () => {
    const { w, corpus, shelves } = await setup();

    const editRes = await w.harness.behavior.runCli([
      "catalog",
      "edit",
      shelves.id,
      "--name",
      "Custom Shelving",
      "--description",
      "Heavy duty shelving",
      "--aliases",
      "Industrial Racks",
    ]);
    expect(editRes.exitCode).toBe(0);

    const updated = corpus.getById(shelves.id)!;
    expect(updated.name).toBe("Custom Shelving");
    expect(updated.description).toBe("Heavy duty shelving");
    expect(updated.aliases).toEqual(["Industrial Racks"]);
  });

  it("catalog reparent moves an entity under a new parent or to root", async () => {
    const { w, corpus, shelves } = await setup();

    // Reparent shelves to root
    const toRoot = await w.harness.behavior.runCli(["catalog", "reparent", shelves.id, "--to", "root"]);
    expect(toRoot.exitCode).toBe(0);
    expect(corpus.getById(shelves.id)!.parentId).toBeNull();

    // Reparent back to Storage by name
    const toStorage = await w.harness.behavior.runCli(["catalog", "reparent", shelves.id, "--to", "Storage"]);
    expect(toStorage.exitCode).toBe(0);
    const storage = corpus.list().find((e) => e.name === "Storage")!;
    expect(corpus.getById(shelves.id)!.parentId).toBe(storage.id);
  });

  it("catalog merge merges source into target and preserves assignments", async () => {
    const { w, corpus, storage, shelves, rootThread } = await setup();
    const other = corpus.remember("Legacy Shelves", "Old", null, ["OldRacks"]);

    const mergeRes = await w.harness.behavior.runCli([
      "catalog",
      "merge",
      other.id,
      shelves.id,
    ]);
    expect(mergeRes.exitCode).toBe(0);
    expect(mergeRes.stdout).toContain('Merged "Legacy Shelves" into "Shelves"');

    expect(corpus.getById(other.id)).toBeNull();
    expect(corpus.getById(shelves.id)!.aliases).toContain("OldRacks");
    expect(corpus.assignment(rootThread.id).entityId).toBe(shelves.id);
  });

  it("catalog edit failure on alias conflict is atomic and rolls back name changes", async () => {
    const { w, corpus, shelves } = await setup();

    // Storage already has alias "Warehouse" in root scope.
    // Shelves is a child of Storage. Let's create an entity with an alias in Shelves' scope.
    const sibling = corpus.remember("Drawers", "Drawers feature", shelves.parentId, ["Cabinets"]);

    // Attempting to edit Shelves with a name change AND a conflicting alias with Drawers ("Cabinets")
    const failRes = await w.harness.behavior.runCli([
      "catalog",
      "edit",
      shelves.id,
      "--name",
      "Modular Shelving",
      "--aliases",
      "Cabinets",
    ]);
    expect(failRes.exitCode).not.toBe(0);

    // Assert atomic rollback: Shelves must NOT have been renamed to "Modular Shelving"!
    const current = corpus.getById(shelves.id)!;
    expect(current.name).toBe("Shelves");
    expect(current.aliases).toEqual(["Racks"]);
  });

  it("catalog mutations notify realtime views", async () => {
    const { w, shelves, storage } = await setup();

    const count0 = w.harness.inspection.realtimeSignals.length;

    // catalog create
    const createRes = await w.harness.behavior.runCli([
      "catalog",
      "create",
      "Pallets",
      "--description",
      "Wood pallets",
    ]);
    expect(createRes.exitCode).toBe(0);
    expect(w.harness.inspection.realtimeSignals.length).toBeGreaterThan(count0);
    expect(w.harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");

    const count1 = w.harness.inspection.realtimeSignals.length;

    // catalog edit
    const editRes = await w.harness.behavior.runCli([
      "catalog",
      "edit",
      shelves.id,
      "--description",
      "Updated description",
    ]);
    expect(editRes.exitCode).toBe(0);
    expect(w.harness.inspection.realtimeSignals.length).toBeGreaterThan(count1);
    expect(w.harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");

    const count2 = w.harness.inspection.realtimeSignals.length;

    // catalog reparent
    const reparentRes = await w.harness.behavior.runCli([
      "catalog",
      "reparent",
      shelves.id,
      "--to",
      "root",
    ]);
    expect(reparentRes.exitCode).toBe(0);
    expect(w.harness.inspection.realtimeSignals.length).toBeGreaterThan(count2);
    expect(w.harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");

    const count3 = w.harness.inspection.realtimeSignals.length;

    // catalog merge
    const mergeRes = await w.harness.behavior.runCli([
      "catalog",
      "merge",
      shelves.id,
      storage.id,
    ]);
    expect(mergeRes.exitCode).toBe(0);
    expect(w.harness.inspection.realtimeSignals.length).toBeGreaterThan(count3);
    expect(w.harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");
  });
});

describe("CLI Task Identity commands", () => {
  it("task show displays thread assignment, status, provenance, and root inheritance", async () => {
    const { w, rootThread, childThread, shelves } = await setup();

    // Root thread show
    const rootRes = await w.harness.behavior.runCli(["task", "show", rootThread.id]);
    expect(rootRes.exitCode).toBe(0);
    expect(rootRes.stdout).toContain(`Thread:          Root shelves task (@thread:${rootThread.id})`);
    expect(rootRes.stdout).toContain("Workstream:      Storage");
    expect(rootRes.stdout).toContain("Product/Feature: Storage: Shelves (assigned)");
    expect(rootRes.stdout).toContain("Provenance:      automatic");
    expect(rootRes.stdout).toContain("Evidence:        ev_1");

    // Child thread inherits root
    const childRes = await w.harness.behavior.runCli(["task", "show", childThread.id]);
    expect(childRes.exitCode).toBe(0);
    expect(childRes.stdout).toContain(`Inherited from:  @thread:${rootThread.id}`);

    // JSON format
    const jsonRes = await w.harness.behavior.runCli(["task", "show", rootThread.id, "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.stdout);
    expect(parsed.threadId).toBe(rootThread.id);
    expect(parsed.assignment.entityId).toBe(shelves.id);
  });

  it("task assign manually sets identity and updates root for child threads", async () => {
    const { w, corpus, childThread, rootThread, storage } = await setup();

    // Assign via child thread -> must mutate root task!
    const assignRes = await w.harness.behavior.runCli(["task", "assign", childThread.id, "Storage"]);
    expect(assignRes.exitCode).toBe(0);
    expect(assignRes.stdout).toContain(`Assigned @thread:${childThread.id} to "Storage"`);

    const rootAssign = corpus.assignment(rootThread.id);
    expect(rootAssign.entityId).toBe(storage.id);
    expect(rootAssign.provenance).toBe("manual");

    const childAssign = corpus.assignment(childThread.id);
    expect(childAssign.entityId).toBe(storage.id);
    expect(childAssign.inheritedFrom).toBe(rootThread.id);
  });

  it("task clear clears thread assignment to unresolved and mutates root", async () => {
    const { w, corpus, childThread, rootThread } = await setup();

    const clearRes = await w.harness.behavior.runCli(["task", "clear", childThread.id]);
    expect(clearRes.exitCode).toBe(0);
    expect(clearRes.stdout).toContain("Cleared product/feature identity");

    const rootAssign = corpus.assignment(rootThread.id);
    expect(rootAssign.status).toBe("unresolved");
    expect(rootAssign.entityId).toBeNull();
  });

  it("task reclassify re-runs classification against the Catalog", async () => {
    const { w, corpus, rootThread, shelves } = await setup();
    corpus.clear(rootThread.id);

    const reclassifyRes = await w.harness.behavior.runCli(["task", "reclassify", rootThread.id]);
    expect(reclassifyRes.exitCode).toBe(0);
    expect(reclassifyRes.stdout).toContain(`Reclassified @thread:${rootThread.id}`);

    const assignment = corpus.assignment(rootThread.id);
    expect(assignment.status).toBe("assigned");
    expect(assignment.entityId).toBe(shelves.id);
    expect(assignment.provenance).toBe("automatic");
  });

  it("task mutations notify realtime views", async () => {
    const { w, rootThread, storage } = await setup();

    const count0 = w.harness.inspection.realtimeSignals.length;

    // task assign
    const assignRes = await w.harness.behavior.runCli(["task", "assign", rootThread.id, storage.id]);
    expect(assignRes.exitCode).toBe(0);
    expect(w.harness.inspection.realtimeSignals.length).toBeGreaterThan(count0);
    expect(w.harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");

    const count1 = w.harness.inspection.realtimeSignals.length;

    // task clear
    const clearRes = await w.harness.behavior.runCli(["task", "clear", rootThread.id]);
    expect(clearRes.exitCode).toBe(0);
    expect(w.harness.inspection.realtimeSignals.length).toBeGreaterThan(count1);
    expect(w.harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");

    const count2 = w.harness.inspection.realtimeSignals.length;

    // task reclassify
    const reclassRes = await w.harness.behavior.runCli(["task", "reclassify", rootThread.id]);
    expect(reclassRes.exitCode).toBe(0);
    expect(w.harness.inspection.realtimeSignals.length).toBeGreaterThan(count2);
    expect(w.harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");
  });

  it("task reclassify with explicit --identity override assigns with manual provenance and no dummy evidence sentinel", async () => {
    const { w, corpus, rootThread, storage } = await setup();

    const res = await w.harness.behavior.runCli(["task", "reclassify", rootThread.id, "--identity", "Storage"]);
    expect(res.exitCode).toBe(0);

    const assignment = corpus.assignment(rootThread.id);
    expect(assignment.entityId).toBe(storage.id);
    expect(assignment.provenance).toBe("manual");
    expect(assignment.evidence).toBeNull();
  });

  it("identity corrections leave thread placement untouched", async () => {
    const { w, section, rootThread, storage } = await setup();

    expect(w.threads.get(rootThread.id)?.sectionId).toBe(section.id);

    // Assign to another entity
    await w.harness.behavior.runCli(["task", "assign", rootThread.id, storage.id]);
    expect(w.threads.get(rootThread.id)?.sectionId).toBe(section.id);

    // Clear
    await w.harness.behavior.runCli(["task", "clear", rootThread.id]);
    expect(w.threads.get(rootThread.id)?.sectionId).toBe(section.id);

    // Reclassify
    await w.harness.behavior.runCli(["task", "reclassify", rootThread.id]);
    expect(w.threads.get(rootThread.id)?.sectionId).toBe(section.id);
  });

  it("task reclassify on child thread classifies root thread and has immediate isFresh parity with Organize", async () => {
    const prompts: string[] = [];
    const { w, corpus, rootThread, childThread, shelves } = await setup({
      onPrompt: (p) => prompts.push(p),
    });

    w.converse(rootThread.id, ["Design warehouse shelves distribution"]);
    w.converse(childThread.id, ["Fix minor child button styling"]);

    const db = openDatabase(w.bb);
    db.prepare(
      "INSERT INTO ws_analysis(thread_id, revision, at, result) VALUES (?, 1, 1, ?)",
    ).run(
      rootThread.id,
      JSON.stringify({
        recap: "Warehouse shelves distribution architecture",
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
        recap: "CSS button styling",
        state: "idle",
        needsYou: null,
        subject: null,
        drift: null,
      }),
    );

    // Run CLI reclassify on the CHILD thread
    const reclassRes = await w.harness.behavior.runCli(["task", "reclassify", childThread.id]);
    expect(reclassRes.exitCode).toBe(0);

    // 1. Root evidence was passed to classifier, not child evidence
    const classifyPrompt = prompts.find((p) => p.includes("Classify the most specific"))!;
    expect(classifyPrompt).toBeDefined();
    expect(classifyPrompt).toContain("Root shelves task");
    expect(classifyPrompt).toContain("Warehouse shelves distribution architecture");
    expect(classifyPrompt).toContain("Design warehouse shelves distribution");
    expect(classifyPrompt).not.toContain("Child review subtask");
    expect(classifyPrompt).not.toContain("CSS button styling");
    expect(classifyPrompt).not.toContain("Fix minor child button styling");

    // 2. Child assignment inherits from root
    const childAssign = corpus.assignment(childThread.id);
    expect(childAssign.status).toBe("assigned");
    expect(childAssign.entityId).toBe(shelves.id);
    expect(childAssign.inheritedFrom).toBe(rootThread.id);
    expect(childAssign.provenance).toBe("automatic");

    // 3. Evidence matches Organize evidence exactly (human-readable project name)
    const projects = await w.bb.sdk.projects.list();
    const projectName = projects.find((p) => p.id === rootThread.projectId)?.name ?? null;
    const expectedEvidence = classificationEvidence({
      requests: ["Design warehouse shelves distribution"],
      title: rootThread.title,
      project: projectName,
    });

    expect(corpus.isFresh(rootThread.id, expectedEvidence)).toBe(true);
    expect(corpus.isFresh(childThread.id, expectedEvidence)).toBe(true);

    // 4. Organize reuses the fresh classification immediately without re-classifying
    const classifyPromptsBefore = prompts.filter((p) => p.includes("Classify the most specific")).length;
    const orgState = (await w.harness.behavior.callRpc("organization", { action: "rebuild" })) as {
      state: { groups: { roots: { id: string }[] }[] };
    };
    expect(orgState.state.groups.some((g) => g.roots.some((r) => r.id === rootThread.id))).toBe(true);
    const classifyPromptsAfter = prompts.filter((p) => p.includes("Classify the most specific")).length;
    expect(classifyPromptsAfter).toBe(classifyPromptsBefore);
  });
});
