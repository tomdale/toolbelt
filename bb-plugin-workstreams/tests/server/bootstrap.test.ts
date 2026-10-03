import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { openDatabase } from "../../src/server/db.ts";
import { CorpusStore } from "../../src/server/corpus.ts";
import type { BootstrapState } from "../../src/server/bootstrap.ts";
type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});
const call = async (w: World, input: unknown) => {
  let request = input as { action: string; runId?: number };
  if (request.action === "apply" && request.runId === undefined) {
    const saved = (await w.harness.behavior.callRpc("bootstrap", {
      action: "get",
    })) as { state: BootstrapState };
    request = { ...request, runId: saved.state.startedAt };
  }
  return (
    (await w.harness.behavior.callRpc("bootstrap", request)) as {
      state: BootstrapState;
    }
  ).state;
};
async function setup() {
  let seededAlphaId = "";
  world = await fakeWorld({
    settings: { debug: true },
    complete: ({ prompt }) => {
      if (prompt.includes("Classify the most specific")) {
        if (prompt.includes("loose")) {
          return JSON.stringify({
            subjectId: null,
            proposed: { name: "Gamma", description: "Gamma effort" },
          });
        }
        return JSON.stringify({
          subjectId: seededAlphaId,
          proposed: null,
        });
      }
      if (prompt.includes("Choose active navigation groups")) {
        const data = JSON.parse(prompt.split("Snapshot:\n")[1]!);
        const gamma = data.entities.find(
          (e: { name: string }) => e.name === "Gamma",
        );
        return JSON.stringify({
          activeEntityIds: [seededAlphaId, gamma?.id].filter(Boolean),
        });
      }
      return JSON.stringify({
        recap: "Done",
        state: "done",
        subject: "Alpha",
        drift: null,
      });
    },
  });
  const w = world;
  const alpha = w.addSection("Alpha"),
    beta = w.addSection("Beta");
  const corpus = new CorpusStore(openDatabase(w.bb));
  corpus.seed([
    {
      sectionId: alpha.id,
      name: "Alpha",
      description: "Whole Alpha effort",
      aliases: ["A"],
    },
    {
      sectionId: beta.id,
      name: "Beta",
      description: "Beta effort",
      aliases: [],
    },
  ]);
  seededAlphaId = corpus.list().find((e) => e.name === "Alpha")!.id;
  w.addThread("mine", { sectionId: beta.id, title: "mine" });
  w.addThread("keep", { sectionId: alpha.id, title: "keep" });
  w.addThread("loose", { title: "loose" });
  w.addThread("stray", { sectionId: beta.id, title: "stray" });
  w.addThread("child", { parentThreadId: "mine" });
  w.addThread("hidden", { visibility: "hidden" });
  w.addThread("archived", { archivedAt: 1 });
  await w.harness.behavior.callRpc("refresh", null);
  return { w, alpha, beta };
}
describe("explicit organizer", () => {
  it("uses one completion, previews every root, applies and undoes placements plus metadata", async () => {
    const { w, alpha, beta } = await setup();
    const state = await call(w, { action: "start" });
    expect(state.status).toBe("preview");
    expect(state.roots.map((r) => r.id).sort()).toEqual([
      "keep",
      "loose",
      "mine",
      "stray",
    ]);
    expect(
      w.completions.filter((c) => c.prompt.includes("Snapshot:\n")),
    ).toHaveLength(1);
    expect(w.sections).toHaveLength(2);
    expect(w.threads.get("mine")?.sectionId).toBe(beta.id);
    expect(state.traceIds).toHaveLength(1);
    const applied = await call(w, { action: "apply", overrides: [] });
    expect(applied.status).toBe("applied");
    expect(w.threads.get("mine")?.sectionId).toBe(alpha.id);
    expect(w.threads.get("stray")?.sectionId).toBe(alpha.id);
    expect(w.sections.some((s) => s.name === "Gamma")).toBe(true);
    const db = w.bb.storage.database();
    expect(
      db
        .prepare("SELECT description FROM ws_workstream WHERE section_id = ?")
        .get(alpha.id),
    ).toEqual({ description: "Whole Alpha effort" });
    await w.harness.behavior.callRpc("undo", { entryId: applied.entryId });
    const restoredBeta = w.sections.find((s) => s.name === "Beta")!;
    expect(restoredBeta.id).not.toBe(beta.id);
    expect(w.threads.get("mine")?.sectionId).toBe(restoredBeta.id);
    expect(w.threads.get("stray")?.sectionId).toBe(restoredBeta.id);
    expect(w.threads.get("loose")?.sectionId).toBeNull();
    expect(w.sections.map((s) => s.name)).toEqual(["Alpha", "Beta"]);
    expect(
      db
        .prepare("SELECT description FROM ws_workstream WHERE section_id = ?")
        .get(alpha.id),
    ).toEqual({ description: null });
  });
  it("leaves unchecked and concurrently moved threads alone, and never files them on refresh", async () => {
    const { w, beta } = await setup();
    await call(w, { action: "start" });
    w.threads.set("mine", { ...w.threads.get("mine")!, sectionId: null });
    const applied = await call(w, {
      action: "apply",
      overrides: [{ threadId: "loose", accepted: false }],
    });
    expect(applied.error).toContain("changed since");
    expect(w.threads.get("mine")?.sectionId).toBeNull();
    expect(w.threads.get("loose")?.sectionId).toBeNull();
    expect(w.sections.some((s) => s.name === "Gamma")).toBe(false);
    await w.harness.behavior.runCli(["analyze", "loose"]);
    await w.harness.behavior.callRpc("refresh", null);
    expect(w.threads.get("loose")?.sectionId).toBeNull();
    expect(w.sections.some((s) => s.id === beta.id)).toBe(false);
  });
  it("CLI apply consumes the saved preview without another model call", async () => {
    const { w } = await setup();
    expect(
      (await w.harness.behavior.runCli(["rebuild", "--apply"])).exitCode,
    ).not.toBe(0);
    expect((await w.harness.behavior.runCli(["rebuild"])).stdout).toContain(
      "Preview:",
    );
    expect(w.sections).toHaveLength(2);
    const preview = await call(w, { action: "get" });
    expect(
      (
        await w.harness.behavior.runCli([
          "rebuild",
          "--apply",
          "--run-id",
          String(preview.startedAt),
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      w.completions.filter((c) => c.prompt.includes("Snapshot:\n")),
    ).toHaveLength(1);
  });
  it("keeps a cleanup candidate occupied by an unchecked move", async () => {
    const { w, beta } = await setup();
    const preview = await call(w, { action: "start" });
    expect(preview.preview!.removals.some((r) => r.sectionId === beta.id)).toBe(
      true,
    );
    const result = await call(w, {
      action: "apply",
      overrides: [{ threadId: "mine", accepted: false }],
    });
    expect(w.sections.some((s) => s.id === beta.id)).toBe(true);
    expect(w.threads.get("mine")?.sectionId).toBe(beta.id);
    expect(result.error).toContain("no longer qualified");
  });
  it("cancel leaves the map unchanged", async () => {
    const { w } = await setup();
    await call(w, { action: "start" });
    await call(w, { action: "cancel" });
    expect(w.sections).toHaveLength(2);
    expect(await call(w, { action: "get" })).toBeNull();
  });
  it("rejects an obsolete preview id and a concurrently edited map", async () => {
    const { w, alpha } = await setup();
    const old = await call(w, { action: "start" });
    const current = await call(w, { action: "start" });
    expect(current.startedAt).toBeGreaterThan(old.startedAt);
    await expect(
      call(w, { action: "apply", runId: old.startedAt, overrides: [] }),
    ).rejects.toThrow("replaced");
    await w.harness.behavior.callRpc("editWorkstream", {
      sectionId: alpha.id,
      description: "Manual scope",
    });
    const result = await call(w, { action: "apply", overrides: [] });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("metadata changed");
    expect(w.sections).toHaveLength(2);
  });
  it("cancels an in-flight completion without resurrecting its preview", async () => {
    let resolve!: (text: string) => void;
    const response = new Promise<string>((done) => {
      resolve = done;
    });
    world = await fakeWorld({
      complete: ({ prompt }) =>
        prompt.includes("Snapshot:\n")
          ? response
          : JSON.stringify({ recap: "done", state: "done", subject: null }),
    });
    world.addThread("t");
    await call(world, { action: "start" });
    await call(world, { action: "cancel" });
    resolve(
      JSON.stringify({
        workstreams: [],
        assignments: [{ threadId: "t", workstream: null, reason: "Unrelated" }],
      }),
    );
    await new Promise((done) => setTimeout(done, 20));
    expect(await call(world, { action: "get" })).toBeNull();
    expect(world.sections).toHaveLength(0);
  });
  it("skips roots that become hidden or children after the preview", async () => {
    const { w, beta } = await setup();
    await call(w, { action: "start" });
    w.threads.set("mine", { ...w.threads.get("mine")!, visibility: "hidden" });
    w.threads.set("loose", {
      ...w.threads.get("loose")!,
      parentThreadId: "keep",
    });
    const result = await call(w, { action: "apply", overrides: [] });
    expect(result.error).toContain("2 thread(s)");
    expect(w.threads.get("mine")?.sectionId).toBe(beta.id);
    expect(w.sections.some((s) => s.name === "Gamma")).toBe(false);
  });
  it("preserves authored descriptions and protects metadata edited after Apply from Undo", async () => {
    const { w, alpha } = await setup();
    await w.harness.behavior.callRpc("editWorkstream", {
      sectionId: alpha.id,
      description: "Authored scope",
    });
    const preview = await call(w, { action: "start" });
    expect(
      preview.preview?.workstreams.find((s) => s.sectionId === alpha.id)
        ?.description,
    ).toBe("Authored scope");
    const applied = await call(w, { action: "apply", overrides: [] });
    const db = w.bb.storage.database();
    expect(
      db
        .prepare(
          "SELECT description,description_source FROM ws_workstream WHERE section_id=?",
        )
        .get(alpha.id),
    ).toEqual({ description: "Authored scope", description_source: "user" });
    await w.harness.behavior.callRpc("editWorkstream", {
      sectionId: alpha.id,
      aliases: ["A"],
    });
    await w.harness.behavior.callRpc("undo", { entryId: applied.entryId });
    expect(
      db
        .prepare("SELECT aliases FROM ws_workstream WHERE section_id=?")
        .get(alpha.id),
    ).toEqual({ aliases: '["A"]' });
  });
  it("rechecks a later thread after an earlier write allows an external move", async () => {
    const { w, alpha } = await setup();
    await call(w, { action: "start" });
    let writes = 0;
    w.harness.inspection.sdk.stub(
      "threads.update",
      async (args: { threadId: string; sectionId: string | null }) => {
        w.threads.set(args.threadId, {
          ...w.threads.get(args.threadId)!,
          sectionId: args.sectionId,
        });
        if (++writes === 1)
          w.threads.set("stray", {
            ...w.threads.get("stray")!,
            sectionId: alpha.id,
          });
        return w.threads.get(args.threadId)!;
      },
    );
    const result = await call(w, { action: "apply", overrides: [] });
    expect(result.error).toContain("changed since");
    expect(w.threads.get("stray")?.sectionId).toBe(alpha.id);
  });
  it("rejects repeated overrides at the RPC boundary", async () => {
    const { w } = await setup();
    const preview = await call(w, { action: "start" });
    await expect(
      w.harness.behavior.callRpc("bootstrap", {
        action: "apply",
        runId: preview.startedAt,
        overrides: [
          { threadId: "loose", accepted: true },
          { threadId: "loose", accepted: false },
        ],
      }),
    ).rejects.toThrow();
    expect(w.sections).toHaveLength(2);
  });
  it("rejects malformed model output without creating a partial map", async () => {
    world = await fakeWorld({
      complete: () => JSON.stringify({ workstreams: [], assignments: [] }),
    });
    world.addThread("t");
    const state = await call(world, { action: "start" });
    expect(state.status).toBe("failed");
    expect(world.sections).toHaveLength(0);
  });

  it("semantic edits stale saved previews and safely reject apply", async () => {
    const { w } = await setup();
    const preview = await call(w, { action: "start" });
    expect(preview.status).toBe("preview");
    expect(preview.preview?.isStale).toBe(false);

    // Create an entity in the catalog
    const { entity } = (await w.harness.behavior.callRpc("catalogCreate", {
      name: "Feature Alpha",
      description: "Alpha feature",
    })) as { entity: { id: string } };

    // Perform a semantic assignment
    await w.harness.behavior.callRpc("taskAssign", {
      threadId: "mine",
      entityId: entity.id,
    });

    const updated = (await w.harness.behavior.callRpc("bootstrap", {
      action: "get",
    })) as { state: BootstrapState };
    expect(updated.state.preview?.isStale).toBe(true);

    // Apply is safely rejected
    await expect(
      w.harness.behavior.callRpc("bootstrap", {
        action: "apply",
        runId: preview.startedAt,
        overrides: [],
      }),
    ).rejects.toThrow(/catalog or classifications changed/);
  });

  it("catalog reparenting or renaming marks preview stale and prevents apply", async () => {
    const { w } = await setup();

    // Create two entities in the catalog
    const { entity: parent } = (await w.harness.behavior.callRpc(
      "catalogCreate",
      {
        name: "ParentScope",
        description: "Parent",
      },
    )) as { entity: { id: string } };

    const { entity: child } = (await w.harness.behavior.callRpc(
      "catalogCreate",
      {
        name: "ChildScope",
        description: "Child",
      },
    )) as { entity: { id: string } };

    const preview = await call(w, { action: "start" });
    expect(preview.status).toBe("preview");
    expect(preview.preview?.isStale).toBe(false);

    // Reparent child under parent
    await w.harness.behavior.callRpc("catalogReparent", {
      entityId: child.id,
      parentId: parent.id,
    });

    const updated = (await w.harness.behavior.callRpc("bootstrap", {
      action: "get",
    })) as { state: BootstrapState };
    expect(updated.state.preview?.isStale).toBe(true);

    // Apply is safely rejected
    await expect(
      w.harness.behavior.callRpc("bootstrap", {
        action: "apply",
        runId: preview.startedAt,
        overrides: [],
      }),
    ).rejects.toThrow(/catalog or classifications changed/);
  });

  it("repeated catalog and state reads do not bump revision or mark preview stale", async () => {
    const { w } = await setup();
    const preview = await call(w, { action: "start" });
    expect(preview.status).toBe("preview");
    expect(preview.preview?.isStale).toBe(false);

    // Repeated read queries to catalog and state
    for (let i = 0; i < 5; i++) {
      await w.harness.behavior.callRpc("catalog", null);
      await w.harness.behavior.callRpc("state", null);
    }

    const check = (await w.harness.behavior.callRpc("bootstrap", {
      action: "get",
    })) as { state: BootstrapState };
    expect(check.state.preview?.isStale).toBe(false);

    // Apply succeeds without stale error
    const applied = await call(w, {
      action: "apply",
      runId: preview.startedAt,
      overrides: [],
    });
    expect(applied.status).toBe("applied");
  });

  it("compact mode groups specific feature broadly, accurately labels unresolved and completed retained tasks, and filters grouping counts", async () => {
    let capturedCounts: Record<string, number> | null = null;
    let rootEntityId = "";
    let subEntityId = "";

    const world = await fakeWorld({
      settings: { debug: true },
      complete: async ({ prompt }) => {
        if (prompt.includes("Classify the most specific")) {
          if (prompt.includes("SubTask")) {
            return JSON.stringify({ subjectId: subEntityId, proposed: null });
          }
          return JSON.stringify({ subjectId: null, proposed: null });
        }
        if (prompt.includes("Choose active navigation")) {
          const snapshotText = prompt.split("Snapshot:\n")[1]!;
          const data = JSON.parse(snapshotText);
          capturedCounts = data.counts;
          return JSON.stringify({ activeEntityIds: [rootEntityId] });
        }
        if (prompt.includes("t_done")) {
          return JSON.stringify({
            recap: "Done work",
            state: "done",
            subject: "Platform",
          });
        }
        return JSON.stringify({
          recap: "Ongoing work",
          state: "in_progress",
          subject: null,
        });
      },
    });

    const secCore = world.addSection("Core");
    const secLegacy = world.addSection("Legacy");

    // Add threads
    world.addThread("t_sub", { title: "SubTask for Auth" });
    world.addThread("t_child", {
      parentThreadId: "t_sub",
      title: "Child Thread",
    });
    world.addThread("t_unresolved", {
      sectionId: secLegacy.id,
      title: "Mystery Thread",
    });
    world.addThread("t_done", {
      sectionId: secCore.id,
      title: "Done Task",
      latestAttentionAt: 5,
      status: "idle",
    });
    world.addThread("t_manual", { title: "Explicit Platform Thread" });

    // Seed analysis for t_done as completed (state: done)
    const db = world.bb.storage.database();
    db.prepare(
      "INSERT INTO ws_analysis (thread_id, revision, at, result) VALUES (?, ?, ?, ?)",
    ).run(
      "t_done",
      10,
      1,
      JSON.stringify({
        recap: "Done work",
        state: "done",
        needsYou: null,
        subject: null,
        title: null,
        goal: "Done task",
        drift: null,
        driftSectionId: null,
        revision: 10,
        at: 1,
      }),
    );

    await world.harness.behavior.callRpc("refresh", null);

    // Seed catalog
    const { entity: rootEnt } = (await world.harness.behavior.callRpc(
      "catalogCreate",
      {
        name: "Platform",
        description: "Platform core",
      },
    )) as { entity: { id: string } };
    rootEntityId = rootEnt.id;

    const { entity: subEnt } = (await world.harness.behavior.callRpc(
      "catalogCreate",
      {
        name: "Authentication",
        description: "Auth system",
        parentId: rootEntityId,
      },
    )) as { entity: { id: string } };
    subEntityId = subEnt.id;

    // Explicit manual assignment for t_manual
    await world.harness.behavior.callRpc("taskAssign", {
      threadId: "t_manual",
      entityId: rootEntityId,
    });

    const preview = await call(world, { action: "start" });
    expect(preview.status).toBe("preview");
    expect(preview.preview).toBeTruthy();

    // Verify grouping counts in compact mode:
    // Completed roots (t_done) and unresolved roots (t_unresolved) do NOT inflate counts!
    expect(capturedCounts).toBeTruthy();
    expect(capturedCounts![subEntityId]).toBe(1); // t_sub
    expect(capturedCounts![rootEntityId]).toBe(1); // t_manual
    expect(capturedCounts!["t_done"]).toBeUndefined();
    expect(capturedCounts!["t_unresolved"]).toBeUndefined();

    // Verify assignments and truthful reasons:
    const assignMap = new Map(
      preview.preview!.assignments.map((a) => [a.threadId, a]),
    );

    // 1. Specific feature grouped broadly:
    const subAssign = assignMap.get("t_sub")!;
    expect(subAssign.reason).toBe(
      "Classified as Platform: Authentication; grouped under Platform.",
    );

    // 2. Unresolved retained in home:
    const unresolvedAssign = assignMap.get("t_unresolved")!;
    expect(unresolvedAssign.reason).toBe(
      "Unresolved identity; retained in Legacy.",
    );

    // 3. Completed retained in home:
    const doneAssign = assignMap.get("t_done")!;
    expect(doneAssign.reason).toBe("Completed task; retained in Core.");

    // 4. Explicit manual assignment preserved:
    const manualAssign = assignMap.get("t_manual")!;
    expect(manualAssign.reason).toBe(
      "Manually assigned to Platform; grouped in Platform.",
    );

    // Verify snapshot identities
    expect(preview.preview!.identities).toBeTruthy();
    expect(preview.preview!.identities!["t_sub"]!.label).toBe(
      "Platform: Authentication",
    );
    expect(preview.preview!.identities!["t_unresolved"]!.status).toBe(
      "unresolved",
    );

    // Apply the proposal
    const applied = await call(world, {
      action: "apply",
      runId: preview.startedAt,
      overrides: [],
    });
    expect(applied.status).toBe("applied");

    // Verify placement changes only happened on Apply:
    const platformSec = world.sections.find((s) => s.name === "Platform")!;
    expect(platformSec).toBeTruthy();

    // t_sub moved to Platform
    expect(world.threads.get("t_sub")!.sectionId).toBe(platformSec.id);

    // Child thread follows root
    expect(world.threads.get("t_child")!.parentThreadId).toBe("t_sub");

    // t_unresolved stayed in Legacy
    expect(world.threads.get("t_unresolved")!.sectionId).toBe(secLegacy.id);

    // t_done stayed in Core
    expect(world.threads.get("t_done")!.sectionId).toBe(secCore.id);
  });
});
