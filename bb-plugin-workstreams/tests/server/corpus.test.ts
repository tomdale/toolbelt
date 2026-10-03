import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/server/db.ts";
import { CorpusStore } from "../../src/server/corpus.ts";
import { entityAncestors } from "../../src/domain/corpus.ts";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
const store = () => {
  const host = createFakePluginHost({ pluginId: `corpus-${hosts.length}` });
  hosts.push(host);
  return { host, corpus: new CorpusStore(openDatabase(host.bb)) };
};

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

describe("CorpusStore", () => {
  it("builds missing local ancestry and resets all Catalog data only", () => {
    const { corpus } = store();
    const direct = corpus.rememberProposal({
      name: "Root Item",
      description: "No ancestors",
      parentId: null,
      ancestors: null,
    });
    expect(direct.parentId).toBeNull();
    const child = corpus.rememberProposal({
      name: "Up Next",
      description: "Upcoming tasks",
      parentId: null,
      ancestors: [
        { name: "Lantern", description: "Product" },
        { name: "Sidebar", description: "Navigation" },
      ],
    });
    const product = corpus.resolve("Lantern")!;
    const sidebar = corpus.resolve("Sidebar", product.id)!;
    expect(child.parentId).toBe(sidebar.id);
    corpus.assign("t", child.id, {
      evidence: "evidence",
      provenance: "automatic",
    });
    corpus.syncGroups([
      {
        sectionId: "g",
        name: "Lantern: Sidebar: Up Next",
        description: "",
        aliases: [],
      },
    ]);
    expect(corpus.groups().get("g")).toBe(child.id);
    corpus.reset();
    expect(corpus.list()).toEqual([]);
    expect(corpus.subjects().size).toBe(0);
    expect(corpus.groups().size).toBe(0);
    corpus.syncGroups([
      {
        sectionId: "g",
        name: "Core & Architecture",
        description: "",
        aliases: [],
      },
    ]);
    expect(corpus.list()).toEqual([]);
  });
  it("rejects conflicting aliases on existing identities without changing storage", () => {
    const { corpus } = store();
    corpus.remember("Alpha", "first");
    const beta = corpus.remember("Beta", "second");
    const before = corpus.list();
    expect(() => corpus.remember("Alpha", "changed", null, ["Beta"])).toThrow(
      "alias",
    );
    expect(corpus.list()).toEqual(before);
    expect(corpus.resolve("Beta")?.id).toBe(beta.id);
  });
  it("keeps semantic names independent of changed navigation labels", () => {
    const { corpus } = store();
    corpus.seed([
      { sectionId: "s", name: "Lantern", description: "old", aliases: [] },
    ]);
    const root = corpus.list()[0]!;
    corpus.seed([
      {
        sectionId: "s",
        name: "Beacon",
        description: "new",
        aliases: ["Light"],
      },
    ]);
    expect(corpus.resolve("Beacon")).toBeNull();
    expect(corpus.resolve("Lantern")?.id).toBe(root.id);
    expect(corpus.resolve("Light")?.description).toBe("old");
    const feature = corpus.remember("Shelves", "feature", root.id);
    corpus.bindGroup("f", feature.id);
    corpus.seed([
      { sectionId: "s", name: "Beacon", description: "new", aliases: [] },
      {
        sectionId: "f",
        name: "Beacon: Shelves",
        description: "feature",
        aliases: [],
      },
    ]);
    expect(corpus.list()).toHaveLength(2);
    expect(corpus.list().find((e) => e.id === feature.id)?.name).toBe(
      "Shelves",
    );
    expect(corpus.groups().get("f")).toBe(feature.id);
  });
  it("adds its migration without breaking already-migrated storage", () => {
    const { host } = store();
    const migrate = host.bb.storage.migrate.bind(host.bb.storage);
    const spy = vi
      .spyOn(host.bb.storage, "migrate")
      .mockImplementation((db, migrations) => {
        const boundary = migrations.indexOf(
          "ALTER TABLE ws_agent_recap ADD COLUMN waiting_cancelled INTEGER NOT NULL DEFAULT 0",
        );
        return migrate(db, migrations.slice(0, boundary + 1));
      });
    const db = openDatabase(host.bb);
    db.prepare(
      "INSERT INTO ws_workstream(section_id, created_by, created_at, updated_at) VALUES ('section-a', 'user', 1, 1)",
    ).run();
    spy.mockRestore();
    openDatabase(host.bb);
    expect(
      (
        db.prepare("SELECT section_id FROM ws_workstream").get() as {
          section_id: string;
        }
      ).section_id,
    ).toBe("section-a");
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'ws_corpus_subject'",
        )
        .get(),
    ).toBeTruthy();
  });

  it("seeds exact section labels and keeps entities after their groups disappear", () => {
    const { corpus } = store();
    corpus.seed([
      {
        sectionId: "group-1",
        name: "Product: Billing",
        description: "Billing work",
        aliases: ["Invoices"],
      },
    ]);
    const seeded = corpus.list()[0]!;
    expect(seeded.name).toBe("Product: Billing");
    expect(seeded.parentId).toBeNull();
    corpus.seed([]);
    expect(corpus.groups()).toEqual(new Map());
    expect(corpus.list()).toEqual([seeded]);
  });

  it("resolves aliases and scopes matching names by explicit parent", () => {
    const { corpus } = store();
    const left = corpus.remember("Platform", "", null);
    const right = corpus.remember("Commerce", "", null);
    const leftFeature = corpus.remember("Settings", "left", left.id, [
      "Preferences",
    ]);
    const rightFeature = corpus.remember("Settings", "right", right.id);
    expect(corpus.resolve(" preferences ", left.id)?.id).toBe(leftFeature.id);
    expect(corpus.resolve("Settings", right.id)?.id).toBe(rightFeature.id);
    expect(corpus.resolve("Settings", null)).toBeNull();
  });

  it("rejects unknown parents and invalid cyclic parent updates", () => {
    const { host, corpus } = store();
    const db = openDatabase(host.bb);
    expect(() => corpus.remember("Orphan", "", "missing")).toThrow(
      /Unknown corpus parent/,
    );
    const root = corpus.remember("Root", "");
    const child = corpus.remember("Child", "", root.id);
    db.prepare("UPDATE ws_corpus_entity SET parent_id = ? WHERE id = ?").run(
      child.id,
      root.id,
    );
    expect(() => corpus.remember("Nested", "", root.id)).toThrow(
      /parent cycle/,
    );
    expect(corpus.list().find((item) => item.id === child.id)?.parentId).toBe(
      root.id,
    );
  });

  it("rejects assignment to unknown entities and retains specific subjects under broad placement", () => {
    const { corpus } = store();
    expect(() => corpus.assign("thread-x", "missing")).toThrow(
      /Unknown corpus entity/,
    );
    const broad = corpus.remember("Engineering", "");
    const specific = corpus.remember("Billing migration", "", broad.id);
    corpus.bindGroup("section-engineering", broad.id);
    corpus.assign("thread-x", specific.id);
    expect(corpus.subjects()).toEqual(new Map([["thread-x", specific.id]]));
  });

  it("assignment doesn't move native thread placement", () => {
    const { host, corpus } = store();
    const db = openDatabase(host.bb);
    db.prepare(
      "INSERT INTO ws_seen_thread(thread_id, section_id, parent_thread_id, title) VALUES ('t1', 'sec-home', NULL, 'Thread 1')",
    ).run();

    const entity = corpus.remember("Feature", "Feature desc");
    const assignment = corpus.assign("t1", entity.id);

    expect(assignment.status).toBe("assigned");
    expect(assignment.entityId).toBe(entity.id);

    // Verify placement in ws_seen_thread was not modified
    const seen = db
      .prepare("SELECT section_id FROM ws_seen_thread WHERE thread_id = 't1'")
      .get() as { section_id: string };
    expect(seen.section_id).toBe("sec-home");
  });

  it("moving thread doesn't rewrite task identity", () => {
    const { host, corpus } = store();
    const db = openDatabase(host.bb);
    db.prepare(
      "INSERT INTO ws_seen_thread(thread_id, section_id, parent_thread_id, title) VALUES ('t1', 'sec-old', NULL, 'Thread 1')",
    ).run();

    const entity = corpus.remember("Feature", "Feature desc");
    corpus.assign("t1", entity.id);

    // Simulate moving thread native section
    db.prepare(
      "UPDATE ws_seen_thread SET section_id = 'sec-new' WHERE thread_id = 't1'",
    ).run();

    const assignment = corpus.assignment("t1");
    expect(assignment.status).toBe("assigned");
    expect(assignment.entityId).toBe(entity.id);
  });

  it("merges update references across subjects, groups, and children", () => {
    const { corpus } = store();
    const source = corpus.remember("OldAlpha", "Old alpha feature", null, [
      "LegacyAlpha",
    ]);
    const target = corpus.remember("NewBeta", "New beta feature");
    const child = corpus.remember("ChildFeature", "Child of alpha", source.id);

    corpus.assign("t-alpha", source.id);
    corpus.bindGroup("sec-alpha", source.id);

    const initialRev = corpus.revision();
    const result = corpus.merge(source.id, target.id);

    expect(result.affectedThreads).toBe(1);
    expect(result.reparentedChildren).toBe(1);
    expect(corpus.revision()).toBeGreaterThan(initialRev);

    // Source is gone
    expect(corpus.getById(source.id)).toBeNull();

    // Assignment updated to target
    const assignment = corpus.assignment("t-alpha");
    expect(assignment.entityId).toBe(target.id);
    expect(assignment.status).toBe("assigned");

    // Child reparented to target
    const updatedChild = corpus.getById(child.id);
    expect(updatedChild?.parentId).toBe(target.id);

    // Group binding updated to target
    expect(corpus.groups().get("sec-alpha")).toBe(target.id);

    // Target absorbed source name and aliases
    const updatedTarget = corpus.getById(target.id);
    expect(updatedTarget?.aliases).toContain("OldAlpha");
    expect(updatedTarget?.aliases).toContain("LegacyAlpha");
  });

  it("rejects cycles on reparenting", () => {
    const { corpus } = store();
    const root = corpus.remember("Root", "Root item");
    const child = corpus.remember("Child", "Child item", root.id);
    const grandchild = corpus.remember(
      "Grandchild",
      "Grandchild item",
      child.id,
    );

    // Reparent self
    expect(() => corpus.reparent(child.id, child.id)).toThrow(
      /Cannot reparent an entity under itself/,
    );

    // Reparent ancestor under descendant creates cycle
    expect(() => corpus.reparent(root.id, grandchild.id)).toThrow(/cycle/);
    expect(() => corpus.reparent(root.id, child.id)).toThrow(/cycle/);

    // Valid reparenting succeeds
    const reparented = corpus.reparent(grandchild.id, root.id);
    expect(reparented.parentId).toBe(root.id);
  });

  it("keeps manual selections stable across restart and immune to fresh checks", () => {
    const { host, corpus } = store();
    const entity = corpus.remember("Billing", "Billing feature");
    corpus.assign("t1", entity.id, { provenance: "manual" });

    // isFresh always true for manual selections regardless of evidence string
    expect(corpus.isFresh("t1", "different-evidence")).toBe(true);

    // Reopen store from same db (simulating restart)
    const db = openDatabase(host.bb);
    const reloaded = new CorpusStore(db);

    const assignment = reloaded.assignment("t1");
    expect(assignment.status).toBe("assigned");
    expect(assignment.entityId).toBe(entity.id);
    expect(assignment.provenance).toBe("manual");
    expect(reloaded.isFresh("t1", "another-evidence")).toBe(true);
  });

  it("ensures children inherit root identity and mutations apply to root", () => {
    const { host, corpus } = store();
    const db = openDatabase(host.bb);
    db.prepare(
      "INSERT INTO ws_seen_thread(thread_id, section_id, parent_thread_id, title) VALUES ('t-root', NULL, NULL, 'Root')",
    ).run();
    db.prepare(
      "INSERT INTO ws_seen_thread(thread_id, section_id, parent_thread_id, title) VALUES ('t-child', NULL, 't-root', 'Child')",
    ).run();
    db.prepare(
      "INSERT INTO ws_seen_thread(thread_id, section_id, parent_thread_id, title) VALUES ('t-grandchild', NULL, 't-child', 'Grandchild')",
    ).run();

    const entity1 = corpus.remember("Feature 1", "First feature");
    const entity2 = corpus.remember("Feature 2", "Second feature");

    // Assign root
    corpus.assign("t-root", entity1.id);

    // Child and grandchild inherit
    const childAssign = corpus.assignment("t-child");
    expect(childAssign.status).toBe("assigned");
    expect(childAssign.entityId).toBe(entity1.id);
    expect(childAssign.inheritedFrom).toBe("t-root");

    const grandAssign = corpus.assignment("t-grandchild");
    expect(grandAssign.status).toBe("assigned");
    expect(grandAssign.entityId).toBe(entity1.id);
    expect(grandAssign.inheritedFrom).toBe("t-root");

    // Mutating child re-assigns root
    corpus.assign("t-grandchild", entity2.id);
    expect(corpus.assignment("t-root").entityId).toBe(entity2.id);
    expect(corpus.assignment("t-child").entityId).toBe(entity2.id);

    // Clearing child clears root
    corpus.clear("t-child");
    expect(corpus.assignment("t-root").status).toBe("unresolved");
    expect(corpus.assignment("t-grandchild").status).toBe("unresolved");
  });

  it("validates scoped name and alias collisions on rename and reparent", () => {
    const { corpus } = store();
    const root = corpus.remember("Root", "");
    const a = corpus.remember("Alpha", "first", root.id, ["AliasA"]);
    const b = corpus.remember("Beta", "second", root.id);

    // Renaming to existing name under same parent fails
    expect(() => corpus.rename(b.id, "Alpha")).toThrow(/conflicts/);

    // Renaming to existing alias under same parent fails
    expect(() => corpus.rename(b.id, "AliasA")).toThrow(/conflicts/);

    // Other parent scope
    const otherRoot = corpus.remember("OtherRoot", "");
    const c = corpus.remember("Alpha", "third", otherRoot.id);

    // Reparenting to root where "Alpha" already exists fails
    expect(() => corpus.reparent(c.id, root.id)).toThrow(/conflicts/);
  });

  it("updates metadata with validation and bumps revision", () => {
    const { corpus } = store();
    const root = corpus.remember("Platform", "Base platform");
    const feature = corpus.remember("Auth", "Initial auth", root.id, ["Login"]);
    const revBefore = corpus.revision();

    // Update description and aliases
    const updated = corpus.updateMetadata(feature.id, {
      description: "Updated authentication system",
      aliases: ["Sign-in", "SSO"],
    });

    expect(updated.description).toBe("Updated authentication system");
    expect(updated.aliases).toEqual(["Sign-in", "SSO"]);
    expect(corpus.revision()).toBeGreaterThan(revBefore);

    // Reject alias matching name
    expect(() =>
      corpus.updateMetadata(feature.id, { aliases: ["Auth"] }),
    ).toThrow(/alias must differ from its name/);

    // Sibling conflict check
    corpus.remember("Billing", "Billing feature", root.id, ["Payments"]);
    expect(() =>
      corpus.updateMetadata(feature.id, { aliases: ["Payments"] }),
    ).toThrow(/already resolves to an entity/);
  });

  it("syncGroups does not bump revision on no-op", () => {
    const { corpus } = store();
    const entity = corpus.create("Engineering", "Engineering work");
    const records = [
      {
        sectionId: "sec-1",
        name: "Engineering",
        description: "Engineering work",
        aliases: [],
      },
    ];

    // First sync binds group and bumps revision
    const rev1 = corpus.revision();
    expect(corpus.syncGroups(records)).toBe(true);
    const rev2 = corpus.revision();
    expect(rev2).toBeGreaterThan(rev1);

    // Repeated sync with identical bindings is a no-op
    expect(corpus.syncGroups(records)).toBe(false);
    expect(corpus.revision()).toBe(rev2);

    // bindGroup with existing binding is a no-op
    corpus.bindGroup("sec-1", entity.id);
    expect(corpus.revision()).toBe(rev2);

    // unbindGroup with nonexistent section is a no-op
    corpus.unbindGroup("nonexistent-sec");
    expect(corpus.revision()).toBe(rev2);
  });

  it("enforces strict creation vs discovery remember upsert", () => {
    const { corpus } = store();
    corpus.create("Alpha", "Initial alpha");

    // Strict create rejects duplicate name in same scope
    expect(() => corpus.create("Alpha", "Duplicate alpha")).toThrow(
      /already exists/,
    );

    // Strict create rejects alias colliding with existing name
    expect(() => corpus.create("Beta", "Beta", null, ["Alpha"])).toThrow(
      /already resolves/,
    );

    // Discovery remember upserts description and aliases
    const updated = corpus.remember("Alpha", "Updated alpha", null, ["A1"]);
    expect(updated.description).toBe("Updated alpha");
    expect(updated.aliases).toContain("A1");
  });

  it("atomic updateMetadata validates collisions, supports no-op, and updates revision", () => {
    const { corpus } = store();
    const e1 = corpus.create("Billing", "Billing engine", null, ["Invoice"]);
    const e2 = corpus.create("Payments", "Payments engine");

    const revBefore = corpus.revision();

    // No-op update does not bump revision
    const same = corpus.updateMetadata(e1.id, {
      description: "Billing engine",
      aliases: ["Invoice"],
    });
    expect(same.description).toBe("Billing engine");
    expect(corpus.revision()).toBe(revBefore);

    // Collision with another entity in scope throws
    expect(() =>
      corpus.updateMetadata(e2.id, { aliases: ["Invoice"] }),
    ).toThrow(/already resolves/);
    expect(corpus.revision()).toBe(revBefore);

    // Valid update updates metadata and bumps revision
    const updated = corpus.updateMetadata(e1.id, {
      description: "Next billing",
      aliases: ["Invoicing", "Bills"],
    });
    expect(updated.description).toBe("Next billing");
    expect(updated.aliases).toEqual(["Invoicing", "Bills"]);
    expect(corpus.revision()).toBeGreaterThan(revBefore);
  });

  it("nested merge recursively merges matching children, reparents grandchildren, and preserves all references", () => {
    const { corpus } = store();
    // Structure:
    // Target:
    //   TargetRoot
    //     Backend (targetBackend)
    //       Database (targetDb)
    //
    // Source:
    //   SourceRoot
    //     Backend (sourceBackend)
    //       Database (sourceDb)
    //         Migrations (sourceMigrations) [grandchild with subject assignment]
    //       Queue (sourceQueue) [child under Backend with no target counterpart]
    const targetRoot = corpus.create("TargetRoot");
    const targetBackend = corpus.create("Backend", "", targetRoot.id);
    const targetDb = corpus.create("Database", "", targetBackend.id);

    const sourceRoot = corpus.create("SourceRoot");
    const sourceBackend = corpus.create("Backend", "", sourceRoot.id);
    const sourceDb = corpus.create("Database", "", sourceBackend.id);
    const sourceMigrations = corpus.create("Migrations", "", sourceDb.id);
    const sourceQueue = corpus.create("Queue", "", sourceBackend.id);

    corpus.assign("t-source-root", sourceRoot.id);
    corpus.assign("t-source-backend", sourceBackend.id);
    corpus.assign("t-source-db", sourceDb.id);
    corpus.assign("t-migrations", sourceMigrations.id);
    corpus.assign("t-queue", sourceQueue.id);

    corpus.bindGroup("sec-backend", sourceBackend.id);
    corpus.bindGroup("sec-migrations", sourceMigrations.id);

    const result = corpus.merge(sourceRoot.id, targetRoot.id);

    // SourceRoot is deleted
    expect(corpus.getById(sourceRoot.id)).toBeNull();
    // SourceBackend was merged into targetBackend and deleted
    expect(corpus.getById(sourceBackend.id)).toBeNull();
    // SourceDb was merged into targetDb and deleted
    expect(corpus.getById(sourceDb.id)).toBeNull();

    // SourceMigrations reparented under targetDb!
    const reparentedMigrations = corpus.getById(sourceMigrations.id);
    expect(reparentedMigrations?.parentId).toBe(targetDb.id);

    // SourceQueue reparented under targetBackend!
    const reparentedQueue = corpus.getById(sourceQueue.id);
    expect(reparentedQueue?.parentId).toBe(targetBackend.id);

    // Descendant entityAncestors works cleanly without crashes or missing identities
    const entities = corpus.list();
    const migrationAncestors = entityAncestors(sourceMigrations.id, entities);
    expect(migrationAncestors).toEqual([
      sourceMigrations.id,
      targetDb.id,
      targetBackend.id,
      targetRoot.id,
    ]);

    // Assignments successfully migrated
    expect(corpus.assignment("t-source-root").entityId).toBe(targetRoot.id);
    expect(corpus.assignment("t-source-backend").entityId).toBe(
      targetBackend.id,
    );
    expect(corpus.assignment("t-source-db").entityId).toBe(targetDb.id);
    expect(corpus.assignment("t-migrations").entityId).toBe(
      sourceMigrations.id,
    );
    expect(corpus.assignment("t-queue").entityId).toBe(sourceQueue.id);

    // Group bindings migrated
    expect(corpus.groups().get("sec-backend")).toBe(targetBackend.id);
    expect(corpus.groups().get("sec-migrations")).toBe(sourceMigrations.id);
  });

  it("merge rolls back completely on alias collision with no partial updates", () => {
    const { corpus } = store();
    const parentA = corpus.create("ParentA");
    const parentB = corpus.create("ParentB");

    // Sibling of target has alias "ConflictAlias" in parentA scope
    corpus.create("Sibling", "Sibling under A", parentA.id, ["ConflictAlias"]);
    const target = corpus.create("Target", "Target entity", parentA.id);

    // Source under parentB has alias "ConflictAlias" (valid in parentB scope)
    const source = corpus.create("Source", "Source entity", parentB.id, [
      "ConflictAlias",
    ]);
    const sourceChild = corpus.create("Child", "Source child", source.id);
    corpus.assign("t-child", sourceChild.id);

    const revBefore = corpus.revision();

    // Merge must throw due to alias collision with Sibling in target's parent scope
    expect(() => corpus.merge(source.id, target.id)).toThrow(/conflicts/);

    // All entities still exist and are untouched (transaction rolled back)
    expect(corpus.getById(source.id)).not.toBeNull();
    expect(corpus.getById(sourceChild.id)?.parentId).toBe(source.id);
    expect(corpus.assignment("t-child").entityId).toBe(sourceChild.id);
    expect(corpus.revision()).toBe(revBefore);
  });

  it("mutation no-ops do not bump revision for identical assign and clear", () => {
    const { corpus } = store();
    const entity = corpus.create("Feature", "Feature desc");
    const a1 = corpus.assign("t1", entity.id, { provenance: "manual" });
    const rev1 = corpus.revision();

    // Assigning identical entity, provenance, and evidence is a no-op
    const a2 = corpus.assign("t1", entity.id, { provenance: "manual" });
    expect(corpus.revision()).toBe(rev1);
    expect(a2.entityId).toBe(entity.id);

    // Clearing an unassigned thread is a no-op
    corpus.clear("unassigned-thread");
    expect(corpus.revision()).toBe(rev1);

    // Clearing assigned thread bumps revision
    corpus.clear("t1");
    expect(corpus.revision()).toBeGreaterThan(rev1);
  });
});
