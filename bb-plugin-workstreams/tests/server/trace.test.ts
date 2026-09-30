import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld, type FakeCompletion } from "./fake-bb.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

type Summary = {
  id: string;
  kind: string;
  status: string;
  label: string;
  replayOf: string | null;
  error: string | null;
  summary: string | null;
  threads: string[];
};
type Trace = Summary & {
  prompt: string;
  system: string;
  response: string | null;
  reasoning: string | null;
  parsed: Record<string, unknown> | null;
  outcome: Record<string, unknown> | null;
  input: Record<string, unknown> | null;
  links: { kind: string; ref: string }[];
  replays: Summary[];
};

const ANALYSIS = {
  recap: "Fixed the parser; tests pass.",
  state: "review",
  needsYou: null,
  subject: "Alpha",
  drift: null,
  title: null,
};
const ROUTE = {
  outcome: "new-thread",
  workstream: "Alpha",
  title: "Fix the Alpha parser",
  code: true,
  confidence: "high",
  reason: "Alpha parser work",
};
const isRoute = (prompt: string) =>
  prompt.includes("Someone is starting new work");

async function setup(debug: boolean, complete?: FakeCompletion) {
  world = await fakeWorld({
    settings: { debug },
    complete:
      complete ??
      (({ prompt }) =>
        isRoute(prompt)
          ? JSON.stringify(ROUTE)
          : {
              text: JSON.stringify(ANALYSIS),
              reasoning: "**Weighing the state**\n\nThe tests pass.",
            }),
  });
  const w = world;
  const alpha = w.addSection("Alpha");
  w.addThread("t1", { sectionId: alpha.id, title: "Alpha parser" });
  w.converse("t1", ["Fix the parser, token sk-abcdefghijklmnopqrstuv"]);
  await rpc(w, "refresh", null);
  return w;
}

const rpc = <T = unknown>(w: World, method: string, input: unknown) =>
  w.harness.behavior.callRpc(method, input) as Promise<T>;
const traces = async (w: World, input: Record<string, unknown> = {}) =>
  (await rpc<{ traces: Summary[] }>(w, "traces", input)).traces;
const trace = async (w: World, id: string) =>
  (await rpc<{ trace: Trace | null }>(w, "trace", { id })).trace;
const analyze = (w: World, id: string) =>
  w.harness.behavior.runCli(["analyze", id, "--json"]);

describe("debug mode off", () => {
  it("records nothing and leaves results untraced", async () => {
    const w = await setup(false);
    await analyze(w, "t1");
    expect(await traces(w)).toEqual([]);
    const state = await rpc<{
      analysis: Record<string, { traceId: string | null }>;
    }>(w, "state", null);
    expect(state.analysis.t1?.traceId).toBeNull();
  });
});

describe("debug mode on", () => {
  it("records an analysis call with its prompt, reasoning, response, and result", async () => {
    const w = await setup(true);
    await analyze(w, "t1");
    const [summary] = await traces(w, {
      link: { kind: "thread", ref: "t1" },
    });
    expect(summary).toMatchObject({
      kind: "analysis",
      status: "ok",
      label: "Alpha parser",
      summary: "review · Alpha",
      threads: ["t1"],
    });
    const state = await rpc<{
      analysis: Record<string, { traceId: string | null }>;
    }>(w, "state", null);
    expect(state.analysis.t1?.traceId).toBe(summary!.id);

    const full = (await trace(w, summary!.id))!;
    expect(full.prompt).toBe(w.completions.at(-1)!.prompt);
    expect(full.system).toContain("Return only the requested JSON");
    expect(full.reasoning).toBe("**Weighing the state**\n\nThe tests pass.");
    expect(full.response).toBe(JSON.stringify(ANALYSIS));
    expect(full.parsed).toMatchObject({ recap: ANALYSIS.recap });
    expect(full.outcome).toMatchObject({ driftSectionId: null });
    expect(full.links).toContainEqual({ kind: "thread", ref: "t1" });
    // The stored input is redacted like the prompt.
    expect(JSON.stringify(full.input)).not.toContain("sk-abcdefghijklmnop");
    expect(JSON.stringify(full.input)).toContain("[redacted]");
  });

  it("records a response that fails to parse and stores no analysis", async () => {
    const w = await setup(true, () => "not json at all");
    await analyze(w, "t1").catch(() => null);
    const [summary] = await traces(w);
    expect(summary).toMatchObject({ kind: "analysis", status: "invalid" });
    // Labels are redacted like prompts.
    expect(summary!.label).toBe("Alpha parser");
    expect(summary!.error).toBeTruthy();
    expect((await trace(w, summary!.id))!.response).toBe("not json at all");
    const state = await rpc<{ analysis: Record<string, unknown> }>(
      w,
      "state",
      null,
    );
    expect(state.analysis.t1).toBeUndefined();
  });

  it("ties a routing call to the thread it started and the journal entry", async () => {
    const w = await setup(true);
    const decision = await rpc<{ id: string; traceId: string | null }>(
      w,
      "route",
      { prompt: "Fix the Alpha parser's handling of nested blocks" },
    );
    expect(decision.traceId).toBeTruthy();
    const { threadId } = await rpc<{ threadId: string }>(w, "routeExecute", {
      decisionId: decision.id,
      prompt: "Fix the Alpha parser's handling of nested blocks",
    });
    const full = (await trace(w, decision.traceId!))!;
    expect(full).toMatchObject({
      kind: "route",
      status: "ok",
      summary: "new thread in Alpha (high)",
    });
    expect(full.outcome).toMatchObject({
      decision: { outcome: "new-thread", workstream: "Alpha" },
    });
    expect(full.links).toContainEqual({ kind: "thread", ref: threadId });

    const { entries } = await rpc<{
      entries: { action: string; traceIds: string[] }[];
    }>(w, "journal", {});
    const route = entries.find((e) => e.action === "route")!;
    expect(route.traceIds).toEqual([decision.traceId]);
    expect(
      (await traces(w, { link: { kind: "thread", ref: threadId } })).map(
        (t) => t.id,
      ),
    ).toContain(decision.traceId);
  });

  it("keeps the routing call behind an unsure decision's chosen workstream", async () => {
    const w = await setup(true, ({ prompt }) =>
      isRoute(prompt)
        ? JSON.stringify({
            outcome: "unsure",
            candidates: [{ workstream: "Alpha" }],
            reason: "Two could fit",
          })
        : JSON.stringify(ANALYSIS),
    );
    const prompt = "Tidy up the parser and the renderer together";
    const unsure = await rpc<{
      id: string;
      traceId: string;
      candidates: { sectionId: string }[];
    }>(w, "route", { prompt });
    expect(unsure.traceId).toBeTruthy();
    const chosen = await rpc<{ outcome: string; traceId: string | null }>(
      w,
      "route",
      {
        prompt,
        workstreamId: unsure.candidates[0]!.sectionId,
        fromDecisionId: unsure.id,
      },
    );
    expect(chosen).toMatchObject({
      outcome: "new-thread",
      traceId: unsure.traceId,
    });
  });

  it("links an applied title to the analysis that suggested it", async () => {
    const w = await setup(true, () =>
      JSON.stringify({ ...ANALYSIS, title: "Nested block parsing" }),
    );
    w.threads.set("t1", { ...w.threads.get("t1")!, title: null });
    await analyze(w, "t1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { entries } = await rpc<{
      entries: { action: string; traceIds: string[] }[];
    }>(w, "journal", {});
    const retitle = entries.find((e) => e.action === "retitle")!;
    expect(retitle.traceIds).toHaveLength(1);
    // The retitle adds to the analysis outcome rather than replacing it.
    expect((await trace(w, retitle.traceIds[0]!))!.outcome).toMatchObject({
      title: "applied",
      driftSectionId: null,
      storedForRevision: expect.any(Number),
    });
  });

  it("replays a stored prompt without changing anything", async () => {
    const w = await setup(true);
    await analyze(w, "t1");
    const [original] = await traces(w);
    const before = await rpc(w, "state", null);
    const { trace: replay } = await rpc<{ trace: Trace }>(w, "traceReplay", {
      id: original!.id,
    });
    expect(replay).toMatchObject({
      replayOf: original!.id,
      status: "ok",
      reasoning: "**Weighing the state**\n\nThe tests pass.",
    });
    expect(replay.prompt).toBe((await trace(w, original!.id))!.prompt);
    expect((await trace(w, original!.id))!.replays.map((r) => r.id)).toEqual([
      replay.id,
    ]);
    // Replays stay out of lists and don't touch stored analysis.
    const listed = (await traces(w)).map((t) => t.id);
    expect(listed).toContain(original!.id);
    expect(listed).not.toContain(replay.id);
    expect(await rpc(w, "state", null)).toEqual(before);
  });

  it("clears every trace", async () => {
    const w = await setup(true);
    await analyze(w, "t1");
    const count = (await traces(w)).length;
    expect(count).toBeGreaterThan(0);
    expect(await rpc(w, "traceClear", null)).toEqual({ removed: count });
    expect(await traces(w)).toEqual([]);
  });

  it("prints traces from the CLI", async () => {
    const w = await setup(true);
    await analyze(w, "t1");
    const list = await w.harness.behavior.runCli(["trace", "--thread", "t1"]);
    expect(list.stdout).toContain("analysis");
    const [summary] = await traces(w);
    const shown = await w.harness.behavior.runCli(["trace", summary!.id]);
    expect(shown.stdout).toContain("Thread analysis: Alpha parser");
    expect(shown.stdout).toContain("── Reasoning ──");
    expect(shown.stdout).toContain("── Prompt ──");
  });
});
