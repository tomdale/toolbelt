import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { openDatabase } from "../../src/server/db.ts";
import { TopicStore } from "../../src/server/topics.ts";

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
      return JSON.stringify({
        recap: "Working on it",
        state: "in_progress",
        goal: "Root shelves task",
        subjectId: shelvesId,
        proposed: null,
      });
    },
  });
  const w = world;
  const section = w.addSection("Storage");
  const corpus = new TopicStore(openDatabase(w.bb));
  const storage = corpus.remember("Storage", "Storage product", null, ["Warehouse"]);
  const shelves = corpus.remember("Shelves", "Shelves feature", storage.id, ["Racks"]);
  shelvesId = shelves.id;
  corpus.bindGroup(section.id, storage.id);
  const rootThread = w.addThread("t_root", {
    sectionId: section.id,
    title: "Root shelves task",
  });
  const childThread = w.addThread("t_child", {
    parentThreadId: rootThread.id,
    title: "Child review subtask",
  });
  corpus.assign(rootThread.id, shelves.id, { provenance: "full", evidence: "ev_1" });
  await w.harness.behavior.callRpc("refresh", null);
  return { w, section, corpus, storage, shelves, rootThread, childThread };
}

describe("CLI topics commands", () => {
  it("topics list prints sorted lexical complete list and supports --json", async () => {
    const { w, storage, shelves } = await setup();

    // Human output
    const listRes = await w.harness.behavior.runCli(["topics", "list"]);
    expect(listRes.exitCode).toBe(0);
    expect(listRes.stdout).toContain("Storage");
    expect(listRes.stdout).toContain("Storage: Shelves");
    expect(listRes.stdout).toContain(storage.id);
    expect(listRes.stdout).toContain(shelves.id);
    expect(listRes.stdout).toContain("[aliases: Warehouse]");
    expect(listRes.stdout).toContain("[aliases: Racks]");

    // JSON output
    const jsonRes = await w.harness.behavior.runCli(["topics", "list", "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.stdout);
    expect(parsed.entities).toHaveLength(2);
    expect(parsed.entities.map((e: { name: string }) => e.name).sort()).toEqual(["Shelves", "Storage"]);
  });

  it("topics show displays full details by name, alias, or ID and supports --json", async () => {
    const { w, storage, shelves, rootThread } = await setup();

    // Show by exact name
    const showName = await w.harness.behavior.runCli(["topics", "show", "Shelves"]);
    expect(showName.exitCode).toBe(0);
    expect(showName.stdout).toContain("Topic: Storage: Shelves");
    expect(showName.stdout).toContain(`ID:              ${shelves.id}`);
    expect(showName.stdout).toContain("Aliases:         Racks");
    expect(showName.stdout).toContain("Assigned tasks:  2");

    // Show by alias
    const showAlias = await w.harness.behavior.runCli(["topics", "show", "Warehouse"]);
    expect(showAlias.exitCode).toBe(0);
    expect(showAlias.stdout).toContain(`ID:              ${storage.id}`);

    // Show by ID with --json
    const showJson = await w.harness.behavior.runCli(["topics", "show", shelves.id, "--json"]);
    expect(showJson.exitCode).toBe(0);
    const parsed = JSON.parse(showJson.stdout);
    expect(parsed.entity.id).toBe(shelves.id);
    expect(parsed.path).toBe("Storage: Shelves");
    expect(parsed.assignedThreads).toContain(rootThread.id);

    // Unknown entity throws clean error
    const showUnknown = await w.harness.behavior.runCli(["topics", "show", "NonExistent"]);
    expect(showUnknown.exitCode).not.toBe(0);
  });

  it("topics create creates a new product or feature with parent and aliases", async () => {
    const { w, corpus } = await setup();

    const createRes = await w.harness.behavior.runCli([
      "topics",
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
    expect(createRes.stdout).toContain('Created topic "Bins"');

    const created = corpus.list().find((e) => e.name === "Bins")!;
    expect(created).toBeDefined();
    expect(created.description).toBe("Storage bins");
    expect(created.aliases.sort()).toEqual(["Containers", "Tubs"]);
    const storage = corpus.list().find((e) => e.name === "Storage")!;
    expect(created.parentId).toBe(storage.id);
  });

  it("topics edit updates name, description, and aliases atomically", async () => {
    const { w, corpus, shelves } = await setup();

    const editRes = await w.harness.behavior.runCli([
      "topics",
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

  it("topics reparent moves an entity under a new parent or to root", async () => {
    const { w, corpus, shelves } = await setup();

    // Reparent shelves to root
    const toRoot = await w.harness.behavior.runCli(["topics", "reparent", shelves.id, "--to", "root"]);
    expect(toRoot.exitCode).toBe(0);
    expect(corpus.getById(shelves.id)!.parentId).toBeNull();

    // Reparent back to Storage by name
    const toStorage = await w.harness.behavior.runCli(["topics", "reparent", shelves.id, "--to", "Storage"]);
    expect(toStorage.exitCode).toBe(0);
    const storage = corpus.list().find((e) => e.name === "Storage")!;
    expect(corpus.getById(shelves.id)!.parentId).toBe(storage.id);
  });

  it("topics merge merges source into target and preserves assignments", async () => {
    const { w, corpus, storage, shelves, rootThread } = await setup();
    const other = corpus.remember("Legacy Shelves", "Old", null, ["OldRacks"]);

    const mergeRes = await w.harness.behavior.runCli([
      "topics",
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

  it("topics edit failure on alias conflict is atomic and rolls back name changes", async () => {
    const { w, corpus, shelves } = await setup();

    // Storage already has alias "Warehouse" in root scope.
    // Shelves is a child of Storage. Let's create an entity with an alias in Shelves' scope.
    const sibling = corpus.remember("Drawers", "Drawers feature", shelves.parentId, ["Cabinets"]);

    // Attempting to edit Shelves with a name change AND a conflicting alias with Drawers ("Cabinets")
    const failRes = await w.harness.behavior.runCli([
      "topics",
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

  it("topics mutations notify realtime views", async () => {
    const { w, shelves, storage } = await setup();

    const count0 = w.harness.inspection.realtimeSignals.length;

    // catalog create
    const createRes = await w.harness.behavior.runCli([
      "topics",
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
      "topics",
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
      "topics",
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
      "topics",
      "merge",
      shelves.id,
      storage.id,
    ]);
    expect(mergeRes.exitCode).toBe(0);
    expect(w.harness.inspection.realtimeSignals.length).toBeGreaterThan(count3);
    expect(w.harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");
  });
});

describe("CLI thread topic commands", () => {
  it("thread show displays thread assignment, status, provenance, and root inheritance", async () => {
    const { w, rootThread, childThread, shelves } = await setup();

    // Root thread show
    const rootRes = await w.harness.behavior.runCli(["thread", "show", rootThread.id]);
    expect(rootRes.exitCode).toBe(0);
    expect(rootRes.stdout).toContain(`Thread:          Root shelves task (@thread:${rootThread.id})`);
    expect(rootRes.stdout).toContain("Workstream:      Storage");
    expect(rootRes.stdout).toContain("Topic:           Storage: Shelves");
    expect(rootRes.stdout).toContain("Source:          settled by Full analysis");

    // Child thread inherits root
    const childRes = await w.harness.behavior.runCli(["thread", "show", childThread.id]);
    expect(childRes.exitCode).toBe(0);
    expect(childRes.stdout).toContain(`Follows parent:  @thread:${rootThread.id}`);

    // JSON format
    const jsonRes = await w.harness.behavior.runCli(["thread", "show", rootThread.id, "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.stdout);
    expect(parsed.threadId).toBe(rootThread.id);
    expect(parsed.assignment.entityId).toBe(shelves.id);
  });

  it("thread assign manually sets identity and updates root for child threads", async () => {
    const { w, corpus, childThread, rootThread, storage } = await setup();

    // Assign via child thread -> must mutate root task!
    const assignRes = await w.harness.behavior.runCli(["thread", "assign", childThread.id, "Storage"]);
    expect(assignRes.exitCode).toBe(0);
    expect(assignRes.stdout).toContain(`Assigned @thread:${childThread.id} to "Storage"`);

    const rootAssign = corpus.assignment(rootThread.id);
    expect(rootAssign.entityId).toBe(storage.id);
    expect(rootAssign.provenance).toBe("manual");

    const childAssign = corpus.assignment(childThread.id);
    expect(childAssign.entityId).toBe(storage.id);
    expect(childAssign.inheritedFrom).toBe(rootThread.id);
  });

  it("thread clear clears thread assignment to unresolved and mutates root", async () => {
    const { w, corpus, childThread, rootThread } = await setup();

    const clearRes = await w.harness.behavior.runCli(["thread", "clear", childThread.id]);
    expect(clearRes.exitCode).toBe(0);
    expect(clearRes.stdout).toContain("has no topic now");

    const rootAssign = corpus.assignment(rootThread.id);
    expect(rootAssign.status).toBe("unresolved");
    expect(rootAssign.entityId).toBeNull();
  });

  it("thread reclassify re-runs classification against the Catalog", async () => {
    const { w, corpus, rootThread, shelves } = await setup();
    corpus.clear(rootThread.id);

    const reclassifyRes = await w.harness.behavior.runCli(["thread", "reclassify", rootThread.id]);
    expect(reclassifyRes.exitCode).toBe(0);
    expect(reclassifyRes.stdout).toContain(`@thread:${rootThread.id}'s topic is now`);

    const assignment = corpus.assignment(rootThread.id);
    expect(assignment.status).toBe("assigned");
    expect(assignment.entityId).toBe(shelves.id);
    expect(assignment.provenance).toBe("full");
  });

  it("thread mutations notify realtime views", async () => {
    const { w, rootThread, storage } = await setup();

    const count0 = w.harness.inspection.realtimeSignals.length;

    // task assign
    const assignRes = await w.harness.behavior.runCli(["thread", "assign", rootThread.id, storage.id]);
    expect(assignRes.exitCode).toBe(0);
    expect(w.harness.inspection.realtimeSignals.length).toBeGreaterThan(count0);
    expect(w.harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");

    const count1 = w.harness.inspection.realtimeSignals.length;

    // task clear
    const clearRes = await w.harness.behavior.runCli(["thread", "clear", rootThread.id]);
    expect(clearRes.exitCode).toBe(0);
    expect(w.harness.inspection.realtimeSignals.length).toBeGreaterThan(count1);
    expect(w.harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");

    const count2 = w.harness.inspection.realtimeSignals.length;

    // task reclassify
    const reclassRes = await w.harness.behavior.runCli(["thread", "reclassify", rootThread.id]);
    expect(reclassRes.exitCode).toBe(0);
    expect(w.harness.inspection.realtimeSignals.length).toBeGreaterThan(count2);
    expect(w.harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");
  });

  it("thread reclassify on a child settles its root with Full analysis, and organizing asks nothing more", async () => {
    const prompts: string[] = [];
    const { w, corpus, rootThread, childThread, shelves } = await setup({
      onPrompt: (p) => prompts.push(p),
    });
    w.converse(rootThread.id, ["Design warehouse shelves distribution"]);
    w.converse(childThread.id, ["Fix minor child button styling"]);

    const reclassRes = await w.harness.behavior.runCli(["thread", "reclassify", childThread.id]);
    expect(reclassRes.exitCode).toBe(0);

    const analysis = prompts.find((p) => p.includes("You describe one agent thread"))!;
    expect(analysis).toContain("Design warehouse shelves distribution");
    expect(analysis).not.toContain("Fix minor child button styling");
    const childAssign = corpus.assignment(childThread.id);
    expect(childAssign.entityId).toBe(shelves.id);
    expect(childAssign.inheritedFrom).toBe(rootThread.id);

    const before = prompts.length;
    await w.harness.behavior.callRpc("organization", { action: "rebuild" });
    expect(prompts.length).toBe(before);
  });

  it("reads and retries organization via CLI and rejects removed manual placement commands", async () => {
    const { w } = await setup();

    // 1. organization read
    const readRes = await w.harness.behavior.runCli(["organization", "--json"]);
    expect(readRes.exitCode).toBe(0);
    const readState = JSON.parse(readRes.stdout);
    expect(readState).toHaveProperty("status");
    expect(readState).toHaveProperty("counts");

    // 2. organization rebuild
    const retryRes = await w.harness.behavior.runCli(["organization", "--rebuild", "--json"]);
    expect(retryRes.exitCode).toBe(0);
    const retryState = JSON.parse(retryRes.stdout);
    expect(retryState.status).toBe("idle");

    // 3. Removed manual placement commands are not recognized
    for (const cmd of ["file", "new", "prioritize", "edit", "handoff", "rebuild"]) {
      const res = await w.harness.behavior.runCli([cmd]);
      expect(res.exitCode).not.toBe(0);
    }
  });
});
