import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/server/db.ts";
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
    expect(names).toContain("ws_notebook");
    expect(names).toContain("ws_proposal");
    expect(names).toContain("ws_journal");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
