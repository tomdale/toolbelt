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
  reason: string;
  confidence: number;
};
type Entry = {
  id: string;
  action: string;
  status: string;
  source: string;
  rationale: string;
};

function model(
  options: {
    actions?: unknown[];
    assignments?: Record<string, string>;
    gate?: { promise: Promise<void>; release: () => void };
    failSupervision?: boolean;
  } = {},
) {
  return async ({ prompt }: { prompt: string }) => {
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
          workstream: options.assignments?.[id] ?? "unsure",
          confidence: "high",
        })),
      });
    }
    if (prompt.includes("You supervise a person's workstreams")) {
      if (options.failSupervision) throw new Error("temporary model outage");
      await options.gate?.promise;
      return JSON.stringify({
        groups: (options.actions ?? []).map((value) => {
          const action = value as {
            kind: string;
            sourceSectionId: string;
            targetSectionId: string | null;
            name: string | null;
            threadIds: string[];
            reason: string;
            confidence: number;
          };
          return {
            sourceSectionId: action.sourceSectionId,
            destination:
              action.kind === "spin-out"
                ? { kind: "new", name: action.name }
                : { kind: "existing", sectionId: action.targetSectionId },
            threadIds: action.threadIds,
            reason: action.reason,
            confidence: action.confidence,
          };
        }),
      });
    }
    if (prompt.includes("You are tidying"))
      return JSON.stringify({ descriptions: {}, changes: [] });
    return JSON.stringify({ descriptions: {} });
  };
}
async function setup(
  settings: Record<string, string | boolean> = {},
  options: Parameters<typeof model>[0] = {},
) {
  world = await fakeWorld({ complete: model(options), settings });
  return world;
}
const rpc = <T = unknown>(w: World, method: string, input: unknown) =>
  w.harness.behavior.callRpc(method, input) as Promise<T>;
const proposals = async (w: World) =>
  (await rpc<{ proposals: Proposal[] }>(w, "state", null)).proposals;
const log = async (w: World) =>
  (await rpc<{ entries: Entry[] }>(w, "journal", { external: true })).entries;
const evolve = (w: World) => rpc(w, "refresh", null);
async function ready(w: World) {
  await rpc(w, "refresh", null);
  for (const id of w.threads.keys())
    await w.harness.behavior.runCli(["analyze", id]);
  await rpc(w, "bootstrap", { action: "skip" });
}
function seed(w: World) {
  const platform = w.addSection("Platform");
  for (const id of ["c1", "c2"])
    w.addThread(id, {
      sectionId: platform.id,
      title: `Release automation ${id}`,
    });
  w.addThread("test1", {
    sectionId: platform.id,
    title: "Integration test harness",
  });
  w.addThread("test2", {
    sectionId: platform.id,
    title: "Test environment orchestration",
  });
  return platform;
}
const spinout = {
  kind: "spin-out",
  sourceSectionId: "sec_1",
  targetSectionId: null,
  name: "Release automation",
  threadIds: ["c1", "c2"],
  reason:
    "Both notebooks describe recurring build and release pipeline maintenance.",
  confidence: 0.92,
};

// fakeWorld initial section IDs begin at sec_1; action construction keeps tests explicit about closed-set IDs.
describe("notebook-supervised Evolution", () => {
  it("makes no call before bootstrap is complete", async () => {
    const w = await setup({ evolution: "ask" }, { actions: [spinout] });
    seed(w);
    const before = w.completions.filter((call) =>
      call.prompt.includes("You supervise a person's workstreams"),
    ).length;
    await evolve(w);
    const after = w.completions.filter((call) =>
      call.prompt.includes("You supervise a person's workstreams"),
    ).length;
    expect(after).toBe(before);
  });

  it("asks, accepts through the journal, exposes rationale and supports Undo", async () => {
    const w = await setup(
      { evolution: "ask", debug: true },
      { actions: [spinout] },
    );
    const platform = seed(w);
    await ready(w);
    await evolve(w);
    const [pending] = await proposals(w);
    expect(pending).toMatchObject({
      status: "pending",
      reason: spinout.reason,
      confidence: 0.92,
      threadIds: ["c1", "c2"],
    });
    expect(pending!.traceIds.length).toBeGreaterThanOrEqual(1);
    expect(w.threads.get("c1")?.sectionId).toBe(platform.id);
    expect(
      (await log(w)).find((entry) => entry.id === pending!.entryId)?.status,
    ).toBe("pending");
    await rpc(w, "proposal", { id: pending!.id, action: "accept" });
    const effort = w.sections.find(
      (section) => section.name === "Release automation",
    )!;
    expect(w.threads.get("c1")?.sectionId).toBe(effort.id);
    const entry = (await log(w)).find((row) => row.id === pending!.entryId)!;
    expect(entry).toMatchObject({ status: "applied", action: "proposal" });
    expect(entry.rationale).toContain("recurring build and release");
    await rpc(w, "undo", { entryId: pending!.entryId });
    expect(w.threads.get("c1")?.sectionId).toBe(platform.id);
    await evolve(w);
    expect(
      (await proposals(w)).filter((proposal) => proposal.status === "pending"),
    ).toEqual([]);
  });

  it("does not let applied Undo notices consume all supervisor proposal slots", async () => {
    const w = await setup({ evolution: "ask" }, { actions: [spinout] });
    seed(w);
    await ready(w);
    for (let i = 0; i < 3; i++)
      w.bb.storage
        .database()
        .prepare(
          `INSERT INTO ws_proposal (id,key,kind,status,subject,source_section_id,target_section_id,new_name,thread_ids,evidence_count,entry_id,acknowledged,created_at,updated_at) VALUES (?,?,'move','applied','Old','old-source','old-target',NULL,'[]',0,NULL,0,?,?)`,
        )
        .run(`old-${i}`, `old-key-${i}`, Date.now(), Date.now());
    await evolve(w);
    expect(
      (await proposals(w)).some(
        (p) => p.status === "pending" && p.kind === "spin-out",
      ),
    ).toBe(true);
  });
  it("caches unchanged snapshots across ticks without recollecting", async () => {
    const w = await setup({ evolution: "ask" }, { actions: [spinout] });
    seed(w);
    await ready(w);
    await evolve(w);
    const count = () =>
      w.completions.filter((call) =>
        call.prompt.includes("You supervise a person's workstreams"),
      ).length;
    expect(count()).toBe(1);
    await evolve(w);
    expect(count()).toBe(1);
    expect(
      (await proposals(w)).filter((proposal) => proposal.status === "pending"),
    ).toHaveLength(1);
  });

  it("expires proposals deterministically when root revision or placement changes", async () => {
    const w = await setup({ evolution: "ask" }, { actions: [spinout] });
    seed(w);
    await ready(w);
    await evolve(w);
    const [pending] = await proposals(w);
    const current = w.threads.get("c1")!;
    w.threads.set("c1", {
      ...current,
      latestAttentionAt: current.latestAttentionAt + 1,
    });
    await evolve(w);
    expect(await proposals(w)).toEqual([]);
    expect(
      (await log(w)).find((entry) => entry.id === pending!.entryId)?.status,
    ).toBe("dismissed");
  });

  it("does not apply a model result if roots change during inference", async () => {
    let release!: () => void;
    const gate = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
    };
    const w = await setup({ evolution: "auto" }, { actions: [spinout], gate });
    seed(w);
    await ready(w);
    const tick = evolve(w);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const changed = w.threads.get("c1")!;
    w.threads.set("c1", {
      ...changed,
      latestAttentionAt: changed.latestAttentionAt + 2,
    });
    gate.release();
    await tick;
    expect(
      w.sections.some((section) => section.name === "Release automation"),
    ).toBe(false);
  });

  it("retains journaled partial apply behavior for a model-approved spin-out", async () => {
    const w = await setup({ evolution: "auto" }, { actions: [spinout] });
    seed(w);
    await ready(w);
    w.harness.sdk.stub("threads.update", async (args: { threadId: string }) => {
      if (args.threadId === "c2") throw new Error("BB is down");
      const thread = w.threads.get(args.threadId)!;
      const next = { ...thread, ...(args as object) };
      w.threads.set(args.threadId, next as typeof thread);
      return next;
    });
    await evolve(w);
    const rows = await proposals(w);
    expect(
      rows.some(
        (proposal) =>
          proposal.status === "partial" || proposal.status === "applied",
      ),
    ).toBe(true);
    expect(
      (await log(w)).some(
        (entry) => entry.status === "failed" || entry.status === "partial",
      ),
    ).toBe(true);
  });

  it("dismissal snoozes unchanged evidence, then allows reconsideration after notebook change", async () => {
    const w = await setup({ evolution: "ask" }, { actions: [spinout] });
    seed(w);
    await ready(w);
    await evolve(w);
    const [pending] = await proposals(w);
    expect(pending).toBeDefined();
    await rpc(w, "proposal", { id: pending!.id, action: "dismiss" });
    await evolve(w);
    expect(
      (await proposals(w)).filter((proposal) => proposal.status === "pending"),
    ).toEqual([]);
    const note = w.bb.storage
      .database()
      .prepare("SELECT * FROM ws_notebook WHERE thread_id='c1'")
      .get() as Record<string, unknown> | undefined;
    w.bb.storage
      .database()
      .prepare(
        "INSERT INTO ws_notebook(thread_id,title,text,updated_at,cursor,revision,error) VALUES('c1','Release automation c1','We maintain a recurring release pipeline.',9999999999,NULL,NULL,NULL) ON CONFLICT(thread_id) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at",
      )
      .run();
    expect(note).toBeUndefined();
    const db = w.bb.storage.database();
    const cached = db
      .prepare("SELECT value FROM ws_meta WHERE key='supervision_snapshot'")
      .get() as { value: string };
    const snapshot = JSON.parse(cached.value) as { at: number };
    snapshot.at = 0;
    db.prepare(
      "UPDATE ws_meta SET value=? WHERE key='supervision_snapshot'",
    ).run(JSON.stringify(snapshot));
    await evolve(w);
    expect(
      (await proposals(w)).some((proposal) => proposal.status === "pending"),
    ).toBe(true);
  });

  it("protects manually placed roots from model spin-out instructions", async () => {
    const w = await setup({ evolution: "ask" }, { actions: [spinout] });
    seed(w);
    await ready(w);
    const other = w.addSection("Other effort");
    await rpc(w, "moveThread", { threadId: "c2", sectionId: other.id });
    await evolve(w);
    expect(
      (await proposals(w)).some((proposal) =>
        proposal.threadIds.includes("c2"),
      ),
    ).toBe(false);
  });

  it("backs off a failed supervision call", async () => {
    const w = await setup({ evolution: "ask" }, { failSupervision: true });
    seed(w);
    await ready(w);
    const count = () =>
      w.completions.filter((call) =>
        call.prompt.includes("You supervise a person's workstreams"),
      ).length;
    const before = count();
    await evolve(w);
    const afterFailure = count();
    expect(afterFailure).toBe(before + 1);
    await evolve(w);
    expect(count()).toBe(afterFailure);
  });

  it("preserves subject alias, fork, and high-confidence assignment filing", async () => {
    const w = await setup({}, { assignments: { loose: "Summary cards" } });
    const recap = w.addSection("BB Recap");
    w.addThread("r0", { sectionId: recap.id, title: "Old [BB Recap]" });
    w.addThread("fork", { sourceThreadId: "r0", title: "Old work (fork)" });
    w.addThread("loose", { title: "Tune the summary prompt" });
    await ready(w);
    await w.harness.behavior.runCli([
      "edit",
      "BB Recap",
      "--alias",
      "Summary cards",
    ]);
    await evolve(w);
    expect(w.threads.get("fork")?.sectionId).toBe(recap.id);
    expect(w.threads.get("loose")?.sectionId).toBe(recap.id);
  });
});
