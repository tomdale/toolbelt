import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

type Proposal = {
  id: string;
  kind: string;
  status: string;
  text: string;
  threadIds: string[];
  entryId: string | null;
  targetSectionId: string | null;
};
type Entry = { id: string; action: string; status: string; source: string };

/**
 * A fake model: analysis answers with the subject encoded in the thread's
 * title ("… [Subject]"); assignment answers from `assign`.
 */
function model(assign: Record<string, string> = {}) {
  return ({ prompt }: { prompt: string }) => {
    if (prompt.includes("You describe one agent thread")) {
      const subject = /Title: ".*\[(.+?)\]"/.exec(prompt)?.[1] ?? null;
      return JSON.stringify({
        recap: "Working.",
        state: "in_progress",
        subject,
      });
    }
    if (prompt.includes("File each thread under")) {
      const ids = [...prompt.matchAll(/id "([^"]+)"/g)].map((m) => m[1]!);
      return JSON.stringify({
        items: ids.map((id) => ({
          id,
          workstream: assign[id] ?? "unsure",
          confidence: "high",
        })),
      });
    }
    if (prompt.includes("You are tidying"))
      return JSON.stringify({ descriptions: {}, changes: [] });
    return JSON.stringify({ descriptions: {} });
  };
}

async function setup(
  settings: Record<string, string> = {},
  assign: Record<string, string> = {},
) {
  world = await fakeWorld({ complete: model(assign), settings });
  return world;
}

const rpc = <T = unknown>(w: World, method: string, input: unknown) =>
  w.harness.behavior.callRpc(method, input) as Promise<T>;
const proposals = async (w: World) =>
  (await rpc<{ proposals: Proposal[] }>(w, "state", null)).proposals;
const log = async (w: World) =>
  (await rpc<{ entries: Entry[] }>(w, "journal", { external: true })).entries;
const analyzeAll = async (w: World) => {
  await rpc(w, "refresh", null);
  for (const id of w.threads.keys())
    await w.harness.behavior.runCli(["analyze", id]);
};
/** One reconcile-and-evolve pass, as the 60-second loop runs it. */
const evolve = (w: World) => rpc(w, "refresh", null);

/** A workstream with a core subject plus a secondary one on two roots. */
function seed(w: World) {
  const plugins = w.addSection("BB & plugins");
  for (const id of ["c1", "c2", "c3", "c4"])
    w.addThread(id, { sectionId: plugins.id, title: `Core ${id} [BB]` });
  w.addThread("w1", { sectionId: plugins.id, title: "Rows [Workstreams]" });
  w.addThread("w2", { sectionId: plugins.id, title: "Page [Workstreams]" });
  return plugins;
}

describe("before organizing", () => {
  it("changes nothing until the bootstrap is applied or skipped", async () => {
    const w = await setup();
    const plugins = seed(w);
    await analyzeAll(w);
    await evolve(w);
    expect(await proposals(w)).toEqual([]);
    expect(w.threads.get("w1")?.sectionId).toBe(plugins.id);
  });
});

describe("auto-apply", () => {
  it("spins out a subject with an Undo banner, and undo snoozes it", async () => {
    const w = await setup();
    const plugins = seed(w);
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    await evolve(w);
    const [applied] = await proposals(w);
    expect(applied).toMatchObject({
      kind: "spin-out",
      status: "applied",
      text: "Moved from BB & plugins → Workstreams",
    });
    expect(applied!.threadIds.sort()).toEqual(["w1", "w2"]);
    const created = w.sections.find((s) => s.name === "Workstreams")!;
    expect(w.threads.get("w1")?.sectionId).toBe(created.id);
    expect(w.threads.get("c1")?.sectionId).toBe(plugins.id);
    const entry = (await log(w)).find((e) => e.id === applied!.entryId)!;
    expect(entry).toMatchObject({ action: "proposal", source: "proposal" });

    await rpc(w, "undo", { entryId: applied!.entryId });
    expect(w.threads.get("w1")?.sectionId).toBe(plugins.id);
    expect(w.sections.some((s) => s.name === "Workstreams")).toBe(false);
    // The banner goes with the undo, not on the next pass.
    expect(await proposals(w)).toEqual([]);
    await evolve(w);
    expect(await proposals(w)).toEqual([]);
    const snoozed = w.bb.storage
      .database()
      .prepare("SELECT evidence_count FROM ws_snooze WHERE key = ?")
      .get(`${plugins.id}:workstreams`) as
      { evidence_count: number } | undefined;
    expect(snoozed?.evidence_count).toBe(2);
  });

  it("journals what changed even when BB fails partway", async () => {
    const w = await setup();
    const plugins = seed(w);
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    w.harness.sdk.stub("threads.update", async (args: { threadId: string }) => {
      if (args.threadId === "w2") throw new Error("BB is down");
      const thread = w.threads.get(args.threadId)!;
      const next = { ...thread, ...(args as object) };
      w.threads.set(args.threadId, next as typeof thread);
      return next;
    });
    await evolve(w);
    const failed = (await log(w)).find((e) => e.status === "failed");
    expect(failed).toBeDefined();
    const moved = w.sections.find((s) => s.name === "Workstreams")!;
    expect(
      [w.threads.get("w1")?.sectionId, w.threads.get("w2")?.sectionId].filter(
        (id) => id === moved.id,
      ),
    ).toHaveLength(1);
    await rpc(w, "undo", { entryId: failed!.id });
    expect(w.threads.get("w1")?.sectionId).toBe(plugins.id);
    expect(w.threads.get("w2")?.sectionId).toBe(plugins.id);
    expect(w.sections.some((s) => s.name === "Workstreams")).toBe(false);
  });

  it("files an Unsorted root whose subject names a workstream", async () => {
    const w = await setup();
    const recap = w.addSection("BB Recap");
    w.addThread("r0", { sectionId: recap.id, title: "Old [BB Recap]" });
    w.addThread("loose", { title: "Fix prompt [BB Recap]" });
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    await evolve(w);
    expect(w.threads.get("loose")?.sectionId).toBe(recap.id);
    const [p] = await proposals(w);
    expect(p?.text).toBe("Moved from Unsorted → BB Recap");
    await rpc(w, "proposal", { id: p!.id, action: "acknowledge" });
    expect(await proposals(w)).toEqual([]);
  });

  it("files Unsorted roots the assignment model is sure about", async () => {
    const w = await setup({}, { loose: "BB Recap" });
    const recap = w.addSection("BB Recap");
    w.addThread("r0", { sectionId: recap.id, title: "Old [BB Recap]" });
    w.addThread("loose", { title: "Tune the summary prompt" });
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    await evolve(w);
    expect(w.threads.get("loose")?.sectionId).toBe(recap.id);
  });
});

describe("ask first", () => {
  it("holds a pending proposal until accepted, and dismiss snoozes it", async () => {
    const w = await setup({ evolution: "ask" });
    const plugins = seed(w);
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    await evolve(w);
    const [pending] = await proposals(w);
    expect(pending).toMatchObject({
      status: "pending",
      text: "This thread and 1 other look like Workstreams work. Spin out a Workstreams workstream?",
    });
    expect(w.threads.get("w1")?.sectionId).toBe(plugins.id);
    const entry = (await log(w)).find((e) => e.id === pending!.entryId);
    expect(entry).toMatchObject({ action: "proposal", status: "pending" });

    await rpc(w, "proposal", { id: pending!.id, action: "accept" });
    expect(w.threads.get("w1")?.sectionId).not.toBe(plugins.id);
    expect((await log(w)).find((e) => e.id === pending!.entryId)?.status).toBe(
      "applied",
    );
  });

  it("applies a proposal once when accepted twice at the same time", async () => {
    const w = await setup({ evolution: "ask" });
    seed(w);
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    await evolve(w);
    const [pending] = await proposals(w);
    const results = await Promise.allSettled([
      rpc(w, "proposal", { id: pending!.id, action: "accept" }),
      rpc(w, "proposal", { id: pending!.id, action: "accept" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(w.sections.filter((s) => s.name === "Workstreams")).toHaveLength(1);
    expect((await log(w)).filter((e) => e.action === "proposal")).toHaveLength(
      1,
    );
  });

  it("expires a pending proposal whose evidence is gone", async () => {
    const w = await setup({ evolution: "ask" });
    seed(w);
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    await evolve(w);
    const [pending] = await proposals(w);
    w.threads.set("w2", { ...w.threads.get("w2")!, archivedAt: 5 });
    await evolve(w);
    expect(await proposals(w)).toEqual([]);
    const entry = (await log(w)).find((e) => e.id === pending!.entryId);
    expect(entry?.status).toBe("dismissed");
  });

  it("dismissing snoozes the subject", async () => {
    const w = await setup({ evolution: "ask" });
    seed(w);
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    await evolve(w);
    const [pending] = await proposals(w);
    await rpc(w, "proposal", { id: pending!.id, action: "dismiss" });
    await evolve(w);
    expect(await proposals(w)).toEqual([]);
  });
});
