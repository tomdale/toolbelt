import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { WorkstreamService } from "../../src/server/service.ts";
import { Journal } from "../../src/server/journal.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

async function setup() {
  world = await fakeWorld({
    complete: () =>
      JSON.stringify({ recap: "r", state: "in_progress", subject: null }),
  });
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

describe("service: retired manual placement APIs", () => {
  it("rejects removed manual RPC endpoints", async () => {
    const w = await setup();
    await expect(
      rpc(w, "moveThread", { threadId: "t1", sectionId: "s1" }),
    ).rejects.toThrow(/no rpc method "moveThread"/);
    await expect(rpc(w, "createWorkstream", { name: "Test" })).rejects.toThrow(
      /no rpc method "createWorkstream"/,
    );
    await expect(
      rpc(w, "renameWorkstream", { sectionId: "s1", name: "Test" }),
    ).rejects.toThrow(/no rpc method "renameWorkstream"/);
    await expect(
      rpc(w, "editWorkstream", { sectionId: "s1", description: "D" }),
    ).rejects.toThrow(/no rpc method "editWorkstream"/);
  });
});

it("rechecks automatic titling after a queued write is released", async () => {
  const w = await setup();
  w.addThread("t1", {
    title: "Old focus",
    status: "idle",
    latestAttentionAt: 10,
  });
  let enabled = true;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const db = w.bb.storage.database();
  const service = new WorkstreamService(
    () => w.harness.sdk as never,
    db,
    new Journal(db),
    () => {},
    Date.now,
    () => enabled,
  );
  const hold = service.exclusive(() => blocked);
  const retitle = service.retitle("t1", "New focus", 10);
  enabled = false;
  release();
  await hold;
  expect(await retitle).toEqual({ entry: null, skipped: "disabled" });
  expect(w.threads.get("t1")?.title).toBe("Old focus");
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
    expect(entries.filter((e) => e.action === "move")).toHaveLength(1);
    expect(await log(w, false)).toEqual([]);
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
  it("lists, shows, and logs", async () => {
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

    const logged = await cli(["log"]);
    expect(logged.exitCode).toBe(0);
  });

  it("surfaces show truncation in human and JSON output", async () => {
    const w = await setup();
    const alpha = w.addSection("Alpha");
    for (let i = 1; i <= 205; i++) {
      w.addThread(`t${i}`, {
        title: `Task ${i}`,
        sectionId: alpha.id,
        latestAttentionAt: 1_000 + i,
      });
    }
    const cli = (argv: string[]) => w.harness.behavior.runCli(argv);

    const human = await cli(["show", "alpha"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("Alpha — 205 threads (showing first 200)");
    expect(human.stdout).toContain(
      "5 more threads omitted by the 200-row CLI limit.",
    );

    const parsed = JSON.parse((await cli(["show", "alpha", "--json"])).stdout);
    expect(parsed.count).toBe(205);
    expect(parsed.shown).toBe(200);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.rows).toHaveLength(200);
  });

  it("filters the activity log before limiting and reports truncation", async () => {
    const w = await setup();
    const now = Date.now();
    const times = [
      now,
      now - 60_000,
      now - 2 * 60_000,
      now - 3 * 60_000,
      now - 4 * 60_000,
      now - 5 * 60_000,
      now - 6 * 60_000,
      now - 3 * 60 * 60_000,
    ];
    let calls = 0;
    const journal = new Journal(
      w.bb.storage.database(),
      () => times[Math.floor(calls++ / 2)] ?? now - 4 * 60 * 60_000,
    );
    for (let i = 0; i < 8; i++) {
      journal.add({
        action: "move",
        source: "auto",
        rationale: `Entry ${i}`,
        threads: [],
        workstreams: [],
        undo: null,
      });
    }
    const cli = (argv: string[]) => w.harness.behavior.runCli(argv);

    const human = await cli(["log", "--since", "2h", "--limit", "5"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(
      "Showing 5 newest matching entries; older matching entries are omitted by --limit 5.",
    );
    expect(human.stdout).not.toContain("Entry 7");

    const parsed = JSON.parse(
      (await cli(["log", "--since", "2h", "--limit", "5", "--json"])).stdout,
    );
    expect(parsed.count).toBe(5);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.limit).toBe(5);
    expect(parsed.entries).toHaveLength(5);
    expect(
      parsed.entries.every(
        (entry: { at: number }) => entry.at >= now - 2 * 60 * 60_000,
      ),
    ).toBe(true);
  });

  it("adds JSON output for undo", async () => {
    const w = await setup();
    const now = Date.now();
    w.addThread("t1", {
      title: "Old focus",
      status: "idle",
      latestAttentionAt: now,
    });
    await rpc(w, "refresh", null);
    await w.bb.sdk.threads.update({ threadId: "t1", title: "New focus" });
    const entry = new Journal(w.bb.storage.database(), () => now).add({
      action: "retitle",
      source: "auto",
      rationale: "Retitled from Old focus",
      threads: [{ id: "t1", name: "New focus" }],
      workstreams: [],
      undo: {
        kind: "retitle",
        threadId: "t1",
        from: "Old focus",
        to: "New focus",
      },
    });
    const cli = (argv: string[]) => w.harness.behavior.runCli(argv);

    const result = await cli(["undo", entry.id, "--json"]);
    const parsed = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(parsed.entry.action).toBe("undo");
    expect(w.threads.get("t1")?.title).toBe("Old focus");
  });

  it("labels analyze catch-up errors as global stale state", async () => {
    const w = await fakeWorld({ complete: () => "not json at all" });
    world = w;
    w.addThread("t1", { title: "Alpha parser", status: "idle" });
    w.converse("t1", ["Fix the parser"]);
    await rpc(w, "refresh", null);
    await w.harness.behavior.runCli(["analyze", "t1"]).catch(() => null);
    const cli = (argv: string[]) => w.harness.behavior.runCli(argv);

    const human = await cli(["analyze"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("Most recent analyzer failure anywhere:");
    expect(human.stdout).not.toContain(" Last error: ");

    const parsed = JSON.parse((await cli(["analyze", "--json"])).stdout);
    expect(parsed.lastError).toBeTruthy();
    expect(parsed.lastErrorScope).toBe("global");
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

    const order = await rpc<{ order: unknown }>(w, "reorder", {
      kind: "workstreams",
      ids: ["b", "a"],
    });
    expect(order.order).toEqual({
      workstreams: ["b", "a"],
      threads: {},
      prioritized: [],
    });

    const threadOrder = await rpc<{ order: unknown }>(w, "reorder", {
      kind: "threads",
      groupId: "a",
      ids: ["t2", "t1"],
    });
    expect(threadOrder.order).toEqual({
      workstreams: ["b", "a"],
      threads: { a: ["t2", "t1"] },
      prioritized: [],
    });
  });
});
