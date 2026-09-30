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
  traceIds: string[];
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
        drift:
          subject === "Workstreams" ||
          subject === "Dockyard" ||
          subject === "Recap Eval"
            ? { workstream: null, newName: subject, confidence: "high" }
            : null,
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
  settings: Record<string, string | boolean> = {},
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
  it("does not move filed work on stale drift evidence", async () => {
    const w = (world = await fakeWorld({
      complete: ({ prompt }) =>
        JSON.stringify({
          recap: "Switched product.",
          state: "in_progress",
          subject: "BB & plugins",
          drift: prompt.includes('Title: "Thread specific"')
            ? { workstream: "BB & plugins", newName: null, confidence: "high" }
            : null,
        }),
    }));
    const specific = w.addSection("Workstreams");
    const broad = w.addSection("BB & plugins");
    w.addThread("specific", { sectionId: specific.id });
    w.addThread("broad", { sectionId: broad.id });
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    const thread = w.threads.get("specific")!;
    w.threads.set("specific", {
      ...thread,
      latestAttentionAt: thread.latestAttentionAt + 1,
    });
    await evolve(w);
    expect(w.threads.get("specific")?.sectionId).toBe(specific.id);
    expect(await proposals(w)).toEqual([]);
  });

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

  it("does not file an Unsorted root from subject alone", async () => {
    const w = await setup();
    const recap = w.addSection("BB Recap");
    w.addThread("r0", { sectionId: recap.id, title: "Old [BB Recap]" });
    w.addThread("loose", { title: "Fix prompt [BB Recap]" });
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    await evolve(w);
    expect(w.threads.get("loose")?.sectionId).toBeNull();
    expect(await proposals(w)).toEqual([]);
  });

  it("files a visible fork with the thread it was forked from", async () => {
    const w = await setup();
    const recap = w.addSection("BB Recap");
    w.addThread("r0", { sectionId: recap.id, title: "Old work" });
    w.addThread("fork", { sourceThreadId: "r0", title: "Old work (fork)" });
    await rpc(w, "refresh", null);
    await rpc(w, "bootstrap", { action: "skip" });
    await evolve(w);
    expect(w.threads.get("fork")?.sectionId).toBe(recap.id);
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

  it("creates and files a new workstream for a high-confidence new assignment", async () => {
    const w = await setup({}, { loose: "new: Computer" });
    w.addThread("loose", { title: "Integrate Computer [Computer]" });
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    await evolve(w);
    const computer = w.sections.find((s) => s.name === "Computer");
    expect(computer).toBeDefined();
    expect(w.threads.get("loose")?.sectionId).toBe(computer?.id);
    expect((await log(w)).some((e) => e.action === "create-workstream")).toBe(
      true,
    );
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

describe("debug traces", () => {
  it("ties a spin-out to the analyses that named the shared subject", async () => {
    const w = await setup({ debug: true });
    seed(w);
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    await evolve(w);
    const [applied] = await proposals(w);
    const state = await rpc<{
      analysis: Record<string, { traceId: string | null }>;
    }>(w, "state", null);
    const expected = ["w1", "w2"].map((id) => state.analysis[id]!.traceId);
    expect([...applied!.traceIds].sort()).toEqual([...expected].sort());
    const { entries } = await rpc<{
      entries: { id: string; traceIds: string[] }[];
    }>(w, "journal", {});
    const entry = entries.find((e) => e.id === applied!.entryId)!;
    expect([...entry.traceIds].sort()).toEqual([...expected].sort());
  });

  it("records the assignment call that files an Unsorted thread", async () => {
    const w = await setup({ debug: true }, { loose: "Alpha" });
    w.addSection("Alpha");
    w.addThread("a1", {
      sectionId: w.sections[0]!.id,
      title: "Alpha work [Alpha]",
    });
    w.addThread("loose", { title: "Something [Other]" });
    await analyzeAll(w);
    await rpc(w, "bootstrap", { action: "skip" });
    await evolve(w);
    const filing = (await proposals(w)).find((p) =>
      p.threadIds.includes("loose"),
    );
    expect(filing?.status).toBe("applied");
    const { traces } = await rpc<{ traces: { id: string; kind: string }[] }>(
      w,
      "traces",
      { ids: filing!.traceIds },
    );
    expect(traces.map((t) => t.kind).sort()).toEqual([
      "analysis",
      "file-unsorted",
    ]);
  });
});
