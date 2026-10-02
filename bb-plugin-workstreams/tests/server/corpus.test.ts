import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/server/db.ts";
import { CorpusStore } from "../../src/server/corpus.ts";

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
  it("reseeds authored metadata without losing identity or parent scope", () => {
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
    expect(corpus.resolve("Beacon")?.id).toBe(root.id);
    expect(corpus.resolve("Lantern")?.id).toBe(root.id);
    expect(corpus.resolve("Light")?.description).toBe("new");
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
});
