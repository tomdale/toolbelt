import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/server/db.ts";
it("upgrades populated storage while preserving workstreams and activity", async () => {
  const host = createFakePluginHost({ pluginId: "storage-upgrade" });
  try {
    const migrate = host.bb.storage.migrate.bind(host.bb.storage);
    const spy = vi
      .spyOn(host.bb.storage, "migrate")
      .mockImplementation((db, migrations) => {
        const boundary = migrations.indexOf(
          "DROP TABLE IF EXISTS ws_notebook_run_dependency",
        );
        return migrate(db, migrations.slice(0, boundary));
      });
    const db = openDatabase(host.bb);
    db.prepare(
      "INSERT INTO ws_snooze(key,evidence_count,at) VALUES ('proposal-key',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO ws_notebook(thread_id,title,text,updated_at) VALUES ('t','Task','Private learned material',1)",
    ).run();
    db.prepare(
      "INSERT INTO ws_workstream(section_id,created_by,created_at,updated_at) VALUES ('s','user',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO ws_meta(key,value) VALUES ('thread-snoozes','{}')",
    ).run();
    spy.mockRestore();
    openDatabase(host.bb);
    expect(db.prepare("SELECT section_id FROM ws_workstream").all()).toEqual([
      { section_id: "s" },
    ]);
    expect(
      db.prepare("SELECT value FROM ws_meta WHERE key='thread-snoozes'").get(),
    ).toEqual({ value: "{}" });
    expect(() => db.prepare("SELECT * FROM ws_notebook").all()).toThrow();
    expect(() => db.prepare("SELECT * FROM ws_snooze").all()).toThrow();
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
it("installs with current storage and no retired state or banner tables", async () => {
  const host = createFakePluginHost({ pluginId: "storage-retirement" });
  try {
    const db = openDatabase(host.bb);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).not.toContain("state");
    expect(names).not.toContain("banners");
    expect(names).not.toContain("ws_understanding_observation");
    expect(names.some((n) => n.startsWith("ws_notebook"))).toBe(false);
    expect(names).not.toContain("ws_proposal");
    expect(names).not.toContain("ws_snooze");
    expect(names).not.toContain("ws_recap");
    expect(names).not.toContain("ws_archive_dismissed");
    expect(names).toContain("ws_agent_recap");
    expect(names).toContain("ws_journal");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
it("upgrades title ownership rows without marking any provisional", async () => {
  const host = createFakePluginHost({ pluginId: "storage-titles" });
  try {
    const migrate = host.bb.storage.migrate.bind(host.bb.storage);
    const spy = vi
      .spyOn(host.bb.storage, "migrate")
      .mockImplementation((db, migrations) => {
        // Storage as it was before titles could be provisional.
        const boundary = migrations.indexOf(
          "ALTER TABLE ws_title ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0",
        );
        expect(boundary).toBeGreaterThan(0);
        return migrate(db, migrations.slice(0, boundary));
      });
    const db = openDatabase(host.bb);
    db.prepare(
      "INSERT INTO ws_title(thread_id,observed,written,locked,retitled_at) VALUES ('t1','Ours','Ours',0,5),('t2','Mine',NULL,1,NULL)",
    ).run();
    spy.mockRestore();
    openDatabase(host.bb);
    expect(
      db.prepare("SELECT * FROM ws_title ORDER BY thread_id").all(),
    ).toEqual([
      {
        thread_id: "t1",
        observed: "Ours",
        written: "Ours",
        locked: 0,
        retitled_at: 5,
        provisional: 0,
      },
      {
        thread_id: "t2",
        observed: "Mine",
        written: null,
        locked: 1,
        retitled_at: null,
        provisional: 0,
      },
    ]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
