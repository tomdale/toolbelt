import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

async function setup() {
  world = await fakeWorld();
  return world;
}

type Entry = {
  id: string;
  action: string;
  source: string;
  status: string;
  rationale: string;
  undoneBy: string | null;
};
const rpc = <T = unknown>(w: World, method: string, input: unknown) =>
  w.harness.behavior.callRpc(method, input) as Promise<T>;
const log = async (w: World, external = true) =>
  (await rpc<{ entries: Entry[] }>(w, "journal", { external })).entries;

describe("moving threads", () => {
  it("files a root, journals it, and records provenance", async () => {
    const w = await setup();
    const alpha = w.addSection("Alpha");
    w.addThread("t1");
    const { entry } = await rpc<{ entry: Entry }>(w, "moveThread", {
      threadId: "t1",
      sectionId: alpha.id,
    });
    expect(w.threads.get("t1")?.sectionId).toBe(alpha.id);
    expect(entry).toMatchObject({
      action: "move",
      source: "user",
      rationale: "Moved from Unfiled to Alpha",
    });
    const state = await rpc<{ placements: Record<string, { source: string }> }>(
      w,
      "state",
      null,
    );
    expect(state.placements.t1?.source).toBe("user");
  });

  it("refuses to move a child whose parent is visible", async () => {
    const w = await setup();
    const alpha = w.addSection("Alpha");
    w.addThread("parent");
    w.addThread("child", { parentThreadId: "parent" });
    await expect(
      rpc(w, "moveThread", { threadId: "child", sectionId: alpha.id }),
    ).rejects.toThrow(/follows its parent/);
  });

  it("treats a child of an archived parent as a root", async () => {
    const w = await setup();
    const alpha = w.addSection("Alpha");
    w.addThread("parent", { archivedAt: 5 });
    w.addThread("child", { parentThreadId: "parent" });
    await rpc(w, "moveThread", { threadId: "child", sectionId: alpha.id });
    expect(w.threads.get("child")?.sectionId).toBe(alpha.id);
  });

  it("undoes a move only while the thread is still where it was put", async () => {
    const w = await setup();
    const alpha = w.addSection("Alpha");
    const beta = w.addSection("Beta");
    w.addThread("t1");
    const { entry } = await rpc<{ entry: Entry }>(w, "moveThread", {
      threadId: "t1",
      sectionId: alpha.id,
    });
    const undone = await rpc<{ entry: Entry }>(w, "undo", {
      entryId: entry.id,
    });
    expect(undone.entry.action).toBe("undo");
    expect(w.threads.get("t1")?.sectionId).toBeNull();
    await expect(rpc(w, "undo", { entryId: entry.id })).rejects.toThrow(
      /Already undone/,
    );

    const again = await rpc<{ entry: Entry }>(w, "moveThread", {
      threadId: "t1",
      sectionId: alpha.id,
    });
    w.threads.set("t1", { ...w.threads.get("t1")!, sectionId: beta.id });
    await expect(rpc(w, "undo", { entryId: again.entry.id })).rejects.toThrow(
      /changed again/,
    );
    expect(w.threads.get("t1")?.sectionId).toBe(beta.id);
  });
});

describe("workstreams", () => {
  it("creates a workstream, optionally files a thread, and undoes only when empty", async () => {
    const w = await setup();
    w.addThread("t1");
    const created = await rpc<{ sectionId: string; entry: Entry }>(
      w,
      "createWorkstream",
      { name: "  BB   Recap ", threadId: "t1" },
    );
    expect(w.sections.find((s) => s.id === created.sectionId)?.name).toBe(
      "BB Recap",
    );
    expect(w.threads.get("t1")?.sectionId).toBe(created.sectionId);
    await expect(rpc(w, "undo", { entryId: created.entry.id })).rejects.toThrow(
      /still has threads/,
    );
    await rpc(w, "moveThread", { threadId: "t1", sectionId: null });
    await rpc(w, "undo", { entryId: created.entry.id });
    expect(w.sections.some((s) => s.id === created.sectionId)).toBe(false);
  });

  it("counts archived threads when deciding a workstream is empty", async () => {
    const w = await setup();
    const created = await rpc<{ sectionId: string; entry: Entry }>(
      w,
      "createWorkstream",
      { name: "Temp" },
    );
    w.addThread("old", { sectionId: created.sectionId, archivedAt: 1 });
    await expect(rpc(w, "undo", { entryId: created.entry.id })).rejects.toThrow(
      /still has threads/,
    );
  });

  it("rejects duplicate names and renames with undo", async () => {
    const w = await setup();
    w.addSection("Alpha");
    const beta = w.addSection("Beta");
    await expect(rpc(w, "createWorkstream", { name: "alpha" })).rejects.toThrow(
      /already exists/,
    );
    const { entry } = await rpc<{ entry: Entry }>(w, "renameWorkstream", {
      sectionId: beta.id,
      name: "Gamma",
    });
    expect(beta.name).toBe("Gamma");
    await rpc(w, "undo", { entryId: entry.id });
    expect(beta.name).toBe("Beta");
  });
});

describe("reconciler", () => {
  it("records a baseline silently, then journals changes made elsewhere", async () => {
    const w = await setup();
    expect(await log(w)).toEqual([]);

    const alpha = w.addSection("Alpha");
    w.addThread("root");
    w.addThread("kid", { parentThreadId: "root" });
    await rpc(w, "refresh", null);
    const created = await log(w);
    expect(created.map((e) => [e.action, e.source])).toEqual([
      ["create-workstream", "external"],
    ]);

    // Moves made in the built-in sidebar, the CLI, or by agents.
    w.threads.set("root", { ...w.threads.get("root")!, sectionId: alpha.id });
    w.threads.set("kid", { ...w.threads.get("kid")!, sectionId: alpha.id });
    alpha.name = "Alpha Two";
    expect((await rpc<{ changed: boolean }>(w, "refresh", null)).changed).toBe(
      true,
    );
    const entries = await log(w);
    expect(
      entries
        .slice(0, 2)
        .map((e) => e.rationale)
        .sort(),
    ).toEqual([
      "Moved from Unfiled to Alpha Two outside Workstreams",
      "Renamed Alpha to Alpha Two outside Workstreams",
    ]);
    // Only the root's move is recorded; the child's section doesn't group it.
    expect(entries.filter((e) => e.action === "move")).toHaveLength(1);
    // Hidden from the default Activity view.
    expect(await log(w, false)).toEqual([]);
  });

  it("does not re-record Workstreams' own changes", async () => {
    const w = await setup();
    const alpha = w.addSection("Alpha");
    w.addThread("t1");
    await rpc(w, "refresh", null);
    await rpc(w, "moveThread", { threadId: "t1", sectionId: alpha.id });
    expect((await rpc<{ changed: boolean }>(w, "refresh", null)).changed).toBe(
      false,
    );
    expect((await log(w)).map((e) => e.source)).toEqual(["user", "external"]);
  });

  it("journals deleted sections and forgets them", async () => {
    const w = await setup();
    const alpha = w.addSection("Alpha");
    await rpc(w, "refresh", null);
    w.sections.splice(w.sections.indexOf(alpha), 1);
    await rpc(w, "refresh", null);
    expect((await log(w))[0]).toMatchObject({
      action: "delete-workstream",
      rationale: "Deleted Alpha outside Workstreams",
    });
    const state = await rpc<{ workstreams: Record<string, unknown> }>(
      w,
      "state",
      null,
    );
    expect(state.workstreams[alpha.id]).toBeUndefined();
  });
});

describe("cli", () => {
  it("lists, shows, files, and logs", async () => {
    const w = await setup();
    const alpha = w.addSection("Alpha");
    w.addThread("root", { title: "Root task", sectionId: alpha.id });
    w.addThread("kid", { title: "Kid task", parentThreadId: "root" });
    w.addThread("loose", { title: "Loose task" });
    const cli = (argv: string[]) => w.harness.behavior.runCli(argv);

    const list = await cli(["list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toMatch(/Alpha\s+2 threads/);
    expect(list.stdout).toMatch(/Unfiled\s+1 thread /);

    const show = await cli(["show", "alpha"]);
    expect(show.stdout).toContain("Root task");
    expect(show.stdout).toMatch(/\n {2}Kid task/);

    expect((await cli(["show", "unfiled"])).stdout).toContain("Loose task");
    expect((await cli(["show", "unsorted"])).stdout).toContain("Loose task");

    const filed = await cli(["file", "loose", "Alpha"]);
    expect(filed.stdout).toBe("Moved from Unfiled to Alpha");
    const missing = await cli(["file", "loose", "Nope"]);
    expect(missing.exitCode).not.toBe(0);

    const logged = await cli(["log"]);
    expect(logged.stdout).toContain("Moved from Unfiled to Alpha");
  });

  it("prioritizes a workstream and lists it first", async () => {
    const w = await setup();
    w.addSection("Alpha");
    const beta = w.addSection("Beta");
    w.addThread("a", { title: "A task", sectionId: w.sections[0]!.id });
    w.addThread("b", { title: "B task", sectionId: beta.id });
    const cli = (argv: string[]) => w.harness.behavior.runCli(argv);

    expect((await cli(["prioritize", "beta"])).stdout).toBe(
      "Prioritized Beta.",
    );
    const state = await rpc<{ order: { prioritized: string[] } }>(
      w,
      "state",
      null,
    );
    expect(state.order.prioritized).toEqual([beta.id]);
    const list = (await cli(["list"])).stdout.split("\n");
    expect(list[0]).toMatch(/^Beta\s.* · prioritized/);
    expect(list[1]).not.toContain("prioritized");

    await cli(["prioritize", "Beta", "--off"]);
    expect((await cli(["list"])).stdout).not.toContain("prioritized");
  });
});

describe("sidebar order", () => {
  it("stores workstream and per-group thread order and returns it in state", async () => {
    const w = await setup();
    const empty = await rpc<{ order: unknown }>(w, "state", null);
    expect(empty.order).toEqual({
      workstreams: [],
      threads: {},
      prioritized: [],
    });
    await rpc(w, "reorder", { kind: "workstreams", ids: ["sec_b", "sec_a"] });
    await rpc(w, "reorder", {
      kind: "threads",
      groupId: "unsorted",
      ids: ["t2", "t1"],
    });
    await rpc(w, "reorder", {
      kind: "prioritized",
      ids: ["sec_a", "sec_a"],
    });
    const { order } = await rpc<{ order: unknown }>(w, "state", null);
    expect(order).toEqual({
      workstreams: ["sec_b", "sec_a"],
      threads: { unsorted: ["t2", "t1"] },
      prioritized: ["sec_a"],
    });
    await rpc(w, "reorder", { kind: "threads", groupId: "unsorted", ids: [] });
    const cleared = await rpc<{ order: { threads: unknown } }>(
      w,
      "state",
      null,
    );
    expect(cleared.order.threads).toEqual({});
  });
});
