import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/server/db.ts";
import { Understanding } from "../../src/server/understanding.ts";
import { Inference } from "../../src/server/model.ts";
import { TraceStore } from "../../src/server/trace.ts";
import type {
  ExtractionInput,
  SynthesisInput,
} from "../../src/domain/understanding.ts";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});
const row = (
  threadId: string,
  id: string,
  text: string,
  seq = 1,
  role = "user",
) => ({
  kind: "conversation",
  threadId,
  id,
  text,
  sourceSeqStart: seq,
  createdAt: seq * 1000,
  role,
  initiator: role === "user" ? "user" : undefined,
});
const parseBlock = <T>(prompt: string, name: string): T =>
  JSON.parse(prompt.split(`<${name}>\n`)[1]!.split(`\n</${name}>`)[0]!);
const extractAnswer = (input: ExtractionInput) => ({
  observations: input.entries.map((e) => ({
    entryId: e.id,
    speaker: e.speaker,
    quote: e.text,
    observation: e.text.slice(0, 500),
    epistemic: e.speaker === "user" ? "explicit" : "reported_outcome",
    terms: e.text.includes("Recap") ? ["Recap", "Workstreams"] : ["Other"],
  })),
});
async function setup(answer?: (prompt: string) => Promise<string> | string) {
  const transcripts = new Map<string, unknown[]>();
  const revisions = new Map<string, number>();
  let clock = 1_000_000;
  const host = createFakePluginHost({
    pluginId: "understanding-test",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            status: "idle",
            archivedAt: null,
            visibility: "visible",
            latestAttentionAt: revisions.get(threadId) ?? 1,
          }),
        timeline: async ({ threadId }: { threadId: string }) => ({
          rows: transcripts.get(threadId) ?? [],
          timelinePage: { hasOlderRows: false, olderCursor: null },
        }),
      },
    } as never,
  });
  hosts.push(host);
  const db = openDatabase(host.bb);
  const prompts: string[] = [];
  const traces = new TraceStore(db, () => clock);
  const inference = new Inference({
    traces,
    debug: async () => true,
    log: () => {},
    complete: async (prompt) => {
      prompts.push(prompt);
      if (answer)
        return {
          text: await answer(prompt),
          usage: { input: 1, output: 1, cost: 0 },
        };
      if (prompt.includes("<entries>"))
        return {
          text: JSON.stringify(
            extractAnswer({ entries: parseBlock(prompt, "entries") }),
          ),
          usage: { input: 1, output: 1, cost: 0 },
        };
      const observations = parseBlock<SynthesisInput["observations"]>(
        prompt,
        "evidence",
      );
      return {
        text: JSON.stringify({
          accounts: [
            {
              name: observations.some((o) => o.terms.includes("Recap"))
                ? "Recap"
                : "Other",
              narrative: observations
                .map((o) => o.observation)
                .join("; ")
                .slice(0, 1300),
              questions: ["Is the old package independently published?"],
              evidenceIds: observations.map((o) => o.id).slice(0, 30),
            },
          ],
        }),
        usage: { input: 1, output: 1, cost: 0 },
      };
    },
  });
  const memory = new Understanding({
    sdk: () => host.bb.sdk,
    db,
    inference,
    model: async () => "test",
    onChange: () => {},
    log: () => {},
    now: () => clock,
  });
  host.bb.onDispose(() => memory.dispose());
  return {
    host,
    db,
    memory,
    traces,
    inference,
    transcripts,
    revisions,
    prompts,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("incremental understanding", () => {
  it("accumulates nested conversational evidence across turns and threads, preserving dates and prior accounts", async () => {
    const w = await setup();
    w.transcripts.set("old", [
      {
        kind: "turn",
        children: [row("old", "z", "Recap was a separate product.", 1)],
      },
    ]);
    await w.memory.observe("old");
    w.transcripts.set("new", [
      row("new", "a", "Recap is integrated into Workstreams.", 2),
    ]);
    await w.memory.observe("new");
    expect(w.memory.inspect("Recap").observations).toHaveLength(2);
    expect(w.memory.context("Recap")).toContain("separate product");
    expect(w.memory.context("Recap")).toContain("integrated into Workstreams");
    const last = w.prompts.filter((p) => p.includes("<evidence>")).at(-1)!;
    expect(
      parseBlock<SynthesisInput["observations"]>(last, "evidence"),
    ).toHaveLength(2);
    expect(
      parseBlock<SynthesisInput["previous"]>(last, "previous-accounts"),
    ).toHaveLength(1);
    expect(w.memory.inspect().observations[0]?.sourceAt).toBe(2000);
    w.transcripts
      .get("new")!
      .push(row("new", "b", "Recap card code lives in Workstreams.", 3));
    w.revisions.set("new", 2);
    await w.memory.observe("new");
    expect(w.memory.inspect("Recap").observations).toHaveLength(3);
    const extracts = w.prompts.filter((p) => p.includes("<entries>"));
    expect(
      parseBlock<ExtractionInput["entries"]>(extracts.at(-1)!, "entries"),
    ).toHaveLength(1);
    const calls = w.prompts.length;
    await w.memory.observe("new");
    expect(w.prompts).toHaveLength(calls);
    expect(w.memory.needsObservation("new", 2)).toBe(false);
  });

  it("splits long entries without losing later text and ignores delegated/system messages", async () => {
    const w = await setup((prompt) =>
      prompt.includes("<entries>") ? '{"observations":[]}' : '{"accounts":[]}',
    );
    const text = "a".repeat(5000) + " meaningful ending";
    w.transcripts.set("t", [
      row("t", "message", text),
      row("other", "child", "Do not collect me"),
      { ...row("t", "system", "Agent says done"), initiator: "system" },
    ]);
    await w.memory.observe("t");
    const entries = parseBlock<ExtractionInput["entries"]>(
      w.prompts[0]!,
      "entries",
    );
    expect(entries.map((e) => e.text).join("")).toBe(text);
    expect(entries.map((e) => e.id)).toEqual(["message#0", "message#4000"]);
    expect(w.memory.inspect().progress[0]?.cursor).toBe("message#4000");
    expect(w.memory.needsObservation("t", 1)).toBe(false);
  });

  it("preserves a successful chunk cursor when later extraction fails, and backs off catch-up", async () => {
    let calls = 0;
    const w = await setup((prompt) => {
      if (!prompt.includes("<entries>")) return '{"accounts":[]}';
      calls++;
      if (calls === 2) throw new Error("temporary failure");
      return '{"observations":[]}';
    });
    w.transcripts.set(
      "t",
      Array.from({ length: 10 }, (_, i) =>
        row("t", `${i}`, `Statement ${i}`, i),
      ),
    );
    await expect(w.memory.observe("t")).rejects.toThrow("temporary failure");
    expect(w.memory.inspect().progress[0]).toMatchObject({
      cursor: "7#0",
      backlog: 2,
      status: "failed",
    });
    expect(w.memory.needsObservation("t", 1)).toBe(false);
    w.advance(600_001);
    expect(w.memory.needsObservation("t", 1)).toBe(true);
    await w.memory.observe("t");
    expect(
      parseBlock<ExtractionInput["entries"]>(w.prompts.at(-1)!, "entries").map(
        (e) => e.id,
      ),
    ).toEqual(["8#0", "9#0"]);
  });

  it("retains dirty evidence after synthesis failure and retries without re-extracting", async () => {
    let syntheses = 0;
    const w = await setup((prompt) => {
      if (prompt.includes("<entries>"))
        return JSON.stringify(
          extractAnswer({ entries: parseBlock(prompt, "entries") }),
        );
      if (++syntheses === 1) throw new Error("reconcile failed");
      return '{"accounts":[]}';
    });
    w.transcripts.set("t", [
      row("t", "e", "Recap integrated into Workstreams."),
    ]);
    await expect(w.memory.observe("t")).rejects.toThrow("reconcile failed");
    expect(w.memory.inspect().progress[0]?.dirty).toBe(1);
    await w.memory.observe("t");
    expect(w.prompts.filter((p) => p.includes("<entries>"))).toHaveLength(1);
    expect(w.memory.inspect().progress[0]?.dirty).toBe(0);
  });

  it("rejects fabricated quotes without advancing the batch cursor", async () => {
    const w = await setup(() =>
      JSON.stringify({
        observations: [
          {
            entryId: "e#0",
            speaker: "user",
            quote: "invented",
            observation: "bad",
            epistemic: "explicit",
          },
        ],
      }),
    );
    w.transcripts.set("t", [row("t", "e", "actual")]);
    await expect(w.memory.observe("t")).rejects.toThrow("unsupported source");
    expect(w.memory.inspect().observations).toHaveLength(0);
    expect(w.memory.inspect().progress[0]?.cursor).toBeNull();
  });

  it("processes bounded backlog in order without repeatedly scanning current threads", async () => {
    const w = await setup(() => '{"observations":[]}');
    w.transcripts.set(
      "t",
      Array.from({ length: 30 }, (_, i) =>
        row("t", `opaque-${30 - i}`, `Statement ${i}`, i),
      ),
    );
    await w.memory.observe("t");
    expect(w.memory.inspect().progress[0]).toMatchObject({
      backlog: 6,
      completedRevision: null,
    });
    expect(w.memory.needsObservation("t", 1)).toBe(true);
    await w.memory.observe("t");
    expect(w.memory.inspect().progress[0]).toMatchObject({
      backlog: 0,
      completedRevision: 1,
    });
    expect(w.memory.needsObservation("t", 1)).toBe(false);
  });

  it("invalidates whole accounts when any supporting source is deleted", async () => {
    const w = await setup();
    w.transcripts.set("old", [row("old", "e", "Recap separate product.")]);
    await w.memory.observe("old");
    w.transcripts.set("new", [
      row("new", "e", "Recap integrated into Workstreams."),
    ]);
    await w.memory.observe("new");
    expect(w.memory.inspect("Recap").accounts).toHaveLength(1);
    w.memory.forget("old");
    expect(w.memory.inspect("Recap").accounts).toHaveLength(0);
    expect(w.memory.inspect("Recap").observations).toHaveLength(1);
    expect(w.memory.inspect().progress.every((p) => p.threadId !== "old")).toBe(
      true,
    );
    expect(
      w.db
        .prepare(
          "SELECT count(*) AS n FROM ws_trace WHERE kind IN ('understanding-extract','understanding-synthesis')",
        )
        .get(),
    ).toMatchObject({ n: 1 });
    expect(
      w.db
        .prepare(
          "SELECT count(*) AS n FROM ws_trace_link WHERE kind='observation'",
        )
        .get(),
    ).toMatchObject({ n: 1 });
    expect(
      w.traces.list({ link: { kind: "thread", ref: "old" } }),
    ).toHaveLength(0);
    expect(w.traces.list({ kind: "understanding-synthesis" })).toHaveLength(0);
    expect(
      JSON.stringify(w.db.prepare("SELECT data FROM ws_trace").all()),
    ).not.toContain("Recap separate product.");
    expect(
      JSON.stringify(w.db.prepare("SELECT data FROM ws_trace").all()),
    ).not.toContain("Recap separate.");
  });

  it("does not resurrect another thread's deleted evidence through in-flight synthesis", async () => {
    let release!: () => void;
    let signalReady!: () => void;
    const ready = new Promise<void>((r) => {
      signalReady = r;
    });
    let pause = false;
    const w = await setup(async (prompt) => {
      if (prompt.includes("<entries>"))
        return JSON.stringify(
          extractAnswer({ entries: parseBlock(prompt, "entries") }),
        );
      const evidence = parseBlock<SynthesisInput["observations"]>(
        prompt,
        "evidence",
      );
      if (pause) {
        signalReady();
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return JSON.stringify({
        accounts: [
          {
            name: "Recap",
            narrative: "Combined account",
            questions: [],
            evidenceIds: evidence.map((o) => o.id),
          },
        ],
      });
    });
    w.transcripts.set("old", [row("old", "e", "Recap separate.")]);
    await w.memory.observe("old");
    w.transcripts.set("new", [row("new", "e", "Recap integrated.")]);
    pause = true;
    const run = w.memory.observe("new");
    await ready;
    w.memory.forget("old");
    release();
    await run;
    expect(w.memory.inspect("Recap").accounts).toHaveLength(0);
    expect(w.memory.inspect().progress[0]?.dirty).toBe(1);
    expect(w.traces.list({ kind: "understanding-synthesis" })).toHaveLength(0);
  });

  it("deletion and disposal prevent queued or in-flight source writes", async () => {
    let release!: () => void;
    let signalReady!: () => void;
    const ready = new Promise<void>((r) => {
      signalReady = r;
    });
    const w = await setup(async (prompt) => {
      signalReady();
      await new Promise<void>((r) => {
        release = r;
      });
      return JSON.stringify(
        extractAnswer({ entries: parseBlock(prompt, "entries") }),
      );
    });
    w.transcripts.set("t", [row("t", "e", "Recap integrated.")]);
    w.transcripts.set("queued", [row("queued", "e", "Other work.")]);
    const run = w.memory.observe("t");
    const duplicate = w.memory.observe("t");
    expect(duplicate).toBe(run);
    const queued = w.memory.observe("queued");
    await ready;
    w.memory.forget("t");
    w.memory.dispose();
    release();
    await Promise.all([run, queued]);
    expect(w.memory.inspect().observations).toHaveLength(0);
    expect(w.memory.inspect().progress).toHaveLength(0);
    expect(w.prompts).toHaveLength(1);
  });

  it("retains old relevant evidence outside the newest unrelated observations and redacts trace inputs", async () => {
    const w = await setup();
    w.transcripts.set("t", [
      row(
        "t",
        "e",
        "Recap belongs to Workstreams. Authorization: Bearer abcdefghijklmnop",
      ),
    ]);
    await w.memory.observe("t");
    for (let i = 0; i < 100; i++)
      w.db
        .prepare(
          "INSERT INTO ws_understanding_observation (id,thread_id,entry_id,speaker,quote,observation,epistemic,created_at,source_at,terms) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          `noise${i}`,
          "noise",
          `${i}`,
          "user",
          "Unrelated travel",
          "Travel holiday",
          "explicit",
          2_000_000 + i,
          2_000_000 + i,
          '["Travel"]',
        );
    const context = w.memory.context("Recap");
    expect(context).toContain("Workstreams");
    expect(context).not.toContain("Travel holiday");
    expect(context.length).toBeLessThanOrEqual(8000);
    expect(w.prompts[0]).not.toContain("abcdefghijklmnop");
    expect(
      JSON.stringify(w.db.prepare("SELECT data FROM ws_trace").all()),
    ).not.toContain("abcdefghijklmnop");
  });

  it("retires fully reconciled obsolete accounts while preserving unrelated ones", async () => {
    let empty = false;
    const w = await setup((prompt) => {
      if (prompt.includes("<entries>"))
        return JSON.stringify(
          extractAnswer({ entries: parseBlock(prompt, "entries") }),
        );
      if (empty) return '{"accounts":[]}';
      const evidence = parseBlock<SynthesisInput["observations"]>(
        prompt,
        "evidence",
      );
      return JSON.stringify({
        accounts: [
          {
            name: "Recap",
            narrative: "Earlier interpretation",
            questions: [],
            evidenceIds: evidence.map((o) => o.id),
          },
        ],
      });
    });
    w.transcripts.set("t", [row("t", "e", "Recap standalone.")]);
    await w.memory.observe("t");
    w.db
      .prepare(
        "INSERT INTO ws_understanding_account (id,name,narrative,questions,evidence_ids,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run("unrelated", "Travel", "Travel plans", "[]", "[]", 1);
    empty = true;
    w.transcripts
      .get("t")!
      .push(row("t", "new", "Recap ownership is unresolved.", 2));
    w.revisions.set("t", 2);
    await w.memory.observe("t");
    expect(w.memory.inspect("Recap").accounts).toHaveLength(0);
    expect(w.memory.inspect("Travel").accounts).toHaveLength(1);
  });

  it("never emits an account whose grounding was dropped by the context budget", async () => {
    const w = await setup();
    w.transcripts.set("t", [row("t", "e", "Recap " + "x".repeat(3500))]);
    await w.memory.observe("t");
    const evidence = w.memory.inspect("Recap").observations[0]!;
    const id = w.memory.inspect("Recap").accounts[0]!.id;
    const extra = { ...evidence, id: "extra", entryId: "extra" };
    w.db
      .prepare(
        "INSERT INTO ws_understanding_observation (id,thread_id,entry_id,speaker,quote,observation,epistemic,created_at,source_at,terms) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        extra.id,
        "t",
        extra.entryId,
        "user",
        extra.quote,
        extra.observation,
        "explicit",
        1,
        1,
        '["Recap"]',
      );
    w.db
      .prepare(
        "UPDATE ws_understanding_account SET narrative=?,evidence_ids=? WHERE id=?",
      )
      .run(
        "ACCOUNT_ONLY_" + "n".repeat(1300),
        JSON.stringify([evidence.id, extra.id]),
        id,
      );
    const context = w.memory.context("Recap");
    expect(context).not.toContain("ACCOUNT_ONLY_");
    expect(context).toContain("Quote:");
    expect(context.length).toBeLessThanOrEqual(8000);
  });

  it("versions account creation, semantic revisions, and retirements without duplicate no-op history", async () => {
    const w = await setup((prompt) => {
      if (prompt.includes("<entries>"))
        return JSON.stringify(
          extractAnswer({ entries: parseBlock(prompt, "entries") }),
        );
      const observations = parseBlock<SynthesisInput["observations"]>(
        prompt,
        "evidence",
      );
      return JSON.stringify({
        accounts: [
          {
            name: "Recap",
            narrative: "Stable interpretation",
            questions: [],
            evidenceIds: observations.map((o) => o.id),
          },
        ],
      });
    });
    w.transcripts.set("one", [
      row("one", "a", "Recap capability belongs to Workstreams."),
    ]);
    await w.memory.observe("one");
    const id = w.memory.inspect("Recap").accounts[0]!.id;
    expect(w.memory.accountDetail(id).revisions.map((r) => r.action)).toEqual([
      "created",
    ]);
    w.transcripts.set("two", [
      row("two", "b", "Recap capability belongs to Workstreams too."),
    ]);
    await w.memory.observe("two");
    expect(w.memory.accountDetail(id).revisions.map((r) => r.action)).toEqual([
      "revised",
      "created",
    ]);
    w.db
      .prepare(
        "UPDATE ws_understanding_progress SET dirty=1 WHERE thread_id='two'",
      )
      .run();
    await w.memory.observe("two");
    expect(w.memory.accountDetail(id).revisions.map((r) => r.action)).toEqual([
      "revised",
      "created",
    ]);
    const revisionsBeforeRetire = w.memory.accountDetail(id).revisions.length;
    w.db
      .prepare(
        "UPDATE ws_understanding_observation SET thread_id='one' WHERE thread_id='two'",
      )
      .run();
    w.memory.forget("one");
    expect(w.memory.accountDetail(id).account).toBeNull();
    expect(w.memory.accountDetail(id).revisions).toHaveLength(
      revisionsBeforeRetire + 1,
    );
    expect(w.memory.accountDetail(id).revisions[0]).toMatchObject({
      action: "retired",
      traceId: null,
    });
  });

  it("refuses incomplete pagination rather than skipping historical evidence", async () => {
    const w = await setup();
    w.host.harness.inspection.sdk.stub("threads.timeline", async () => ({
      rows: [],
      timelinePage: {
        hasOlderRows: true,
        olderCursor: { anchorId: "same", anchorSeq: 1 },
      },
    }));
    await expect(w.memory.observe("t")).rejects.toThrow("bounded scan");
    expect(w.memory.inspect().progress[0]?.cursor).toBeNull();
    expect(w.prompts).toHaveLength(0);
  });
});
