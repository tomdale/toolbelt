import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { openDatabase } from "../../src/server/db.ts";
import { CorpusStore } from "../../src/server/corpus.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

async function setup() {
  let shelvesId = "";
  world = await fakeWorld({
    settings: { debug: true },
    complete: ({ prompt }) => {
      if (prompt.includes("Classify the most specific")) {
        return JSON.stringify({
          subjectId: shelvesId,
          proposed: null,
        });
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
});
