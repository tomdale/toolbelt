import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/server/db.ts";
import { Understanding } from "../../src/server/understanding.ts";
import { Inference } from "../../src/server/model.ts";
import { TraceStore } from "../../src/server/trace.ts";
import type { NewTrace } from "../../src/domain/trace.ts";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});
async function setup() {
  let now = 10_000;
  const host = createFakePluginHost({ pluginId: "understanding-debug-test" });
  hosts.push(host);
  const db = openDatabase(host.bb);
  const traces = new TraceStore(db, () => now);
  const inference = new Inference({
    traces,
    debug: async () => false,
    log: () => {},
    complete: async () => ({
      text: "{}",
      usage: { input: 0, output: 0, cost: 0 },
    }),
  });
  const memory = new Understanding({
    sdk: () => host.bb.sdk,
    db,
    inference,
    model: async () => "unused",
    onChange: () => {},
    log: () => {},
    now: () => now,
  });
  host.bb.onDispose(() => memory.dispose());
  const insertObservation = (
    id: string,
    threadId: string,
    observation: string,
    quote = observation,
  ) =>
    db
      .prepare(
        "INSERT INTO ws_understanding_observation (id,thread_id,entry_id,speaker,quote,observation,epistemic,created_at,source_at,terms,trace_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        threadId,
        `${id}-entry`,
        "user",
        quote,
        observation,
        "explicit",
        now,
        now,
        JSON.stringify(["recap"]),
        null,
      );
  const insertAccount = (
    id: string,
    name: string,
    evidenceIds: string[],
    narrative = "Recap is integrated into Workstreams.",
  ) => {
    db.prepare(
      "INSERT INTO ws_understanding_account (id,name,narrative,questions,evidence_ids,updated_at,trace_id) VALUES (?,?,?,?,?,?,?)",
    ).run(id, name, narrative, "[]", JSON.stringify(evidenceIds), now, null);
    for (const evidenceId of evidenceIds)
      db.prepare(
        "INSERT INTO ws_understanding_account_observation VALUES (?,?)",
      ).run(id, evidenceId);
  };
  return {
    host,
    db,
    memory,
    traces,
    inference,
    insertObservation,
    insertAccount,
    advance: (n: number) => {
      now += n;
    },
  };
}

describe("Understanding debug backend", () => {
  it("returns bounded SQL-filtered pages, global counts, stable hasMore and nullable retired accounts", async () => {
    const w = await setup();
    for (let i = 0; i < 4; i++) {
      w.insertObservation(
        `o${i}`,
        `t${i}`,
        i % 2 ? "Travel plans" : "Recap capability",
      );
      w.insertAccount(`a${i}`, i % 2 ? "Travel" : "Recap", [`o${i}`]);
    }
    for (let i = 0; i < 3; i++)
      w.db
        .prepare(
          "INSERT INTO ws_understanding_progress (thread_id,status,updated_at,dirty,backlog) VALUES (?,?,?,?,?)",
        )
        .run(`p${i}`, "idle", i, 0, 0);
    const page = w.memory.debugOverview({
      query: "Recap",
      offset: 0,
      limit: 1,
    });
    expect(page.accounts).toHaveLength(1);
    expect(page.observations).toHaveLength(1);
    expect(page.counts).toMatchObject({
      accounts: 4,
      observations: 4,
      threads: 3,
    });
    expect(page.hasMoreAccounts).toBe(true);
    expect(page.hasMoreObservations).toBe(true);
    expect(page.hasMoreProgress).toBe(true);
    expect(
      w.memory.debugOverview({ query: "Recap", offset: 1, limit: 1 })
        .accounts[0]?.id,
    ).not.toBe(page.accounts[0]?.id);
    expect(w.memory.accountDetail("gone").account).toBeNull();
  });

  it("uses one deterministic retrieval report for exact context with atomic grounding and explicit dispositions", async () => {
    const w = await setup();
    w.insertObservation(
      "ground",
      "thread",
      "Recap capability supports Workstreams.",
    );
    w.insertObservation("extra", "thread", "Recap unrelated extra evidence.");
    w.insertAccount("account", "Recap", ["ground"]);
    const report = w.memory.retrieve("Recap", { budget: 1500, limit: 2 });
    expect(report.context).toBe(w.memory.context("Recap"));
    expect(report.usedChars).toBe(report.context.length);
    expect(report.accountIds).toEqual(["account"]);
    expect(report.candidates.find((c) => c.id === "account")?.disposition).toBe(
      "included",
    );
    expect(report.candidates.find((c) => c.id === "ground")?.disposition).toBe(
      "covered",
    );
    expect(
      report.candidates.some(
        (c) => c.kind === "observation" && c.id === "extra",
      ),
    ).toBe(true);
    expect(report.candidates.every((c) => c.matchedTerms.length > 0)).toBe(
      true,
    );
    expect(report.candidates.length).toBeLessThanOrEqual(100);
    const tiny = w.memory.retrieve("Recap", { budget: 1 });
    expect(tiny.accountIds).toEqual([]);
    expect(tiny.candidates.find((c) => c.kind === "account")?.disposition).toBe(
      "budget",
    );
    w.db
      .prepare("DELETE FROM ws_understanding_observation WHERE id='ground'")
      .run();
    expect(
      w.memory.retrieve("Recap").candidates.find((c) => c.id === "account")
        ?.disposition,
    ).toBe("missing-evidence");
  });

  it("retains supplied citations beyond the candidate cap for lineage and forget", async () => {
    const w = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `z-citation-${i}`;
      ids.push(id);
      w.insertObservation(
        id,
        `source-${i}`,
        "Recap citation supports Workstreams.",
      );
      w.insertAccount(`account-00${i}`, `Recap ${i}`, [id]);
    }
    for (let i = 4; i < 80; i++)
      w.insertAccount(`account-${i}`, `Recap ${i}`, [`missing-${i}`]);
    for (let i = 0; i < 100; i++)
      w.insertObservation(
        `a-decoy-${i}`,
        `decoy-${i}`,
        "Recap standalone evidence.",
      );
    const report = w.memory.retrieve("Recap", { budget: 8000, limit: 100 });
    expect(report.accountIds).toHaveLength(4);
    expect(report.observationIds).toEqual(expect.arrayContaining(ids));
    expect(report.candidates.length).toBe(100);
    expect(
      report.candidates.some((candidate) => candidate.id === ids.at(-1)),
    ).toBe(false);
    const snapshotId = w.memory.recordRetrieval(
      report,
      "route",
      "consumer-thread",
    );
    expect(
      w.memory.observationDetail(ids.at(-1)!).retrievals.map((r) => r.id),
    ).toContain(snapshotId);
    w.memory.forget("source-3");
    expect(w.memory.retrievals({ threadId: "consumer-thread" })).toHaveLength(
      0,
    );
  });

  it("redacts query before matching and refuses late attachment after disposal", async () => {
    const w = await setup();
    w.insertObservation(
      "safe",
      "thread",
      "Recap capability supports Workstreams.",
    );
    const report = w.memory.retrieve(
      "Authorization: Bearer abcdefghijklmnop Recap",
      { budget: 8000 },
    );
    expect(report.query).not.toContain("abcdefghijklmnop");
    expect(report).toMatchObject(
      w.memory.retrieve(report.query, { budget: 8000 }),
    );
    const id = w.memory.recordRetrieval(report, "analysis", "thread");
    w.memory.dispose();
    w.memory.attachRetrieval(id, "late-trace");
    expect(w.memory.retrievals({ threadId: "thread" })[0]).toMatchObject({
      id,
      traceId: null,
    });
  });

  it("purges consumer traces and replay descendants when their supplied source is forgotten", async () => {
    const w = await setup();
    w.insertObservation("source", "thread", "Private source quote.");
    const report = w.memory.retrieve("Private");
    const snapshotId = w.memory.recordRetrieval(
      report,
      "route",
      "consumer-thread",
    );
    const trace = (
      prompt: string,
      replayOf: string | null = null,
    ): NewTrace => ({
      at: 10_000,
      kind: "route",
      status: "ok",
      label: "route",
      model: "test",
      durationMs: 1,
      replayOf,
      provider: "test",
      thinking: "off",
      system: "",
      prompt,
      input: {},
      response: "{}",
      reasoning: null,
      stopReason: null,
      parsed: {},
      outcome: null,
      usage: null,
      error: null,
      summary: null,
    });
    const traceId = w.traces.add(trace(report.context), [
      { kind: "thread", ref: "consumer-thread" },
      { kind: "retrieval", ref: snapshotId },
    ]);
    w.memory.attachRetrieval(snapshotId, traceId);
    const replay = w.traces.add(trace("replay", traceId));
    for (let i = 0; i < 1000; i++)
      w.memory.recordRetrieval(
        w.memory.retrieve("no-match"),
        "analysis",
        `filler-${i}`,
      );
    expect(w.memory.retrievals({ threadId: "consumer-thread" })).toHaveLength(
      0,
    );
    const lateTrace = w.traces.add(trace(report.context));
    w.memory.attachRetrieval(snapshotId, lateTrace);
    expect(w.traces.get(lateTrace)).toBeNull();
    w.memory.forget("thread");
    expect(w.traces.get(traceId)).toBeNull();
    expect(w.traces.get(replay)).toBeNull();
    expect(
      JSON.stringify(w.db.prepare("SELECT data FROM ws_trace").all()),
    ).not.toContain("Private source quote");
  });

  it("persists consumer snapshots, attaches traces, exposes lineage, and purges forgotten-source data", async () => {
    const w = await setup();
    w.insertObservation(
      "source",
      "thread",
      "Recap capability supports Workstreams.",
    );
    w.insertAccount("belief", "Recap", ["source"]);
    const report = w.memory.retrieve("Recap");
    const id = w.memory.recordRetrieval(report, "analysis", "thread");
    expect(w.memory.retrievals({ threadId: "thread" })[0]).toMatchObject({
      id,
      consumer: "analysis",
      traceId: null,
    });
    w.memory.attachRetrieval(id, "trace-1");
    expect(w.memory.retrievals({ traceId: "trace-1" })).toHaveLength(1);
    expect(w.memory.observationDetail("source").retrievals).toHaveLength(1);
    w.memory.forget("thread");
    expect(w.memory.retrievals()).toHaveLength(0);
    expect(
      w.db
        .prepare(
          "SELECT count(*) AS n FROM ws_trace_link WHERE kind='retrieval'",
        )
        .get(),
    ).toMatchObject({ n: 0 });
    const detail = w.memory.accountDetail("belief");
    expect(detail.account).toBeNull();
    expect(detail.revisions.at(-1)).toMatchObject({
      action: "retired",
      before: null,
      after: null,
      reason: expect.stringContaining("forgotten"),
    });
    const serialized = JSON.stringify(
      w.db
        .prepare("SELECT before,after,reason FROM ws_understanding_revision")
        .all(),
    );
    expect(serialized).not.toContain("Recap capability");
    expect(serialized).not.toContain("Workstreams");
  });

  it("records retrievals with stable bounded limits and independent filters", async () => {
    const w = await setup();
    const report = w.memory.retrieve("none");
    const ids = Array.from({ length: 4 }, (_, i) =>
      w.memory.recordRetrieval(
        report,
        i % 2 ? "route" : "analysis",
        `t${i % 2}`,
      ),
    );
    const firstPage = w.memory.retrievals({ limit: 2 });
    expect(firstPage).toHaveLength(2);
    expect(w.memory.retrievals({ threadId: "t0" })).toHaveLength(2);
    const nextPage = w.memory.retrievals({
      limit: 2,
      before: { at: firstPage[1]!.at, id: firstPage[1]!.id },
    });
    expect(nextPage).toHaveLength(2);
    expect(
      nextPage.some((snapshot) =>
        firstPage.some((first) => first.id === snapshot.id),
      ),
    ).toBe(false);
    expect([...firstPage, ...nextPage].map((snapshot) => snapshot.at)).toEqual([
      10_000, 10_000, 10_000, 10_000,
    ]);
    w.memory.attachRetrieval(ids[0]!, "trace");
    expect(w.memory.retrievals({ traceId: "trace" })[0]?.id).toBe(ids[0]);
    expect(w.memory.retrievalCursor(ids[0]!)).toEqual({
      at: 10_000,
      id: ids[0],
    });
    expect(w.memory.retrievalCursor("missing")).toBeUndefined();
  });
});
