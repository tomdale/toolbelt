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
  goal: null,
};
const QUICK = { goal: "Alpha parser tabs", subjectId: null, proposed: null };
const isQuick = (prompt: string) =>
  prompt.includes("You name one new agent thread");

async function setup(debug: boolean, complete?: FakeCompletion) {
  world = await fakeWorld({
    settings: { debug },
    complete:
      complete ??
      (({ prompt }) =>
        isQuick(prompt)
          ? JSON.stringify(QUICK)
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
      kind: "full-analysis",
      status: "ok",
      label: "Alpha parser",
      summary: "review · no topic",
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
    expect(full.parsed).toMatchObject({ status: { recap: ANALYSIS.recap } });
    expect(full.outcome).toMatchObject({
      storedForRevision: expect.any(Number),
    });
    expect(full.links).toContainEqual({ kind: "thread", ref: "t1" });
    // The stored input is redacted like the prompt.
    expect(JSON.stringify(full.input)).not.toContain("sk-abcdefghijklmnop");
    expect(JSON.stringify(full.input)).toContain("[redacted]");
  });

  it("records a response that fails to parse and stores no analysis", async () => {
    const w = await setup(true, () => "not json at all");
    await analyze(w, "t1").catch(() => null);
    const [summary] = await traces(w);
    expect(summary).toMatchObject({ kind: "full-analysis", status: "invalid" });
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

  it("records a composer preview's Quick analysis", async () => {
    const w = await setup(true);
    const preview = await rpc<{ traceId: string | null; goal: string | null }>(
      w,
      "preview",
      { prompt: "Fix the Alpha parser's handling of nested blocks" },
    );
    expect(preview.goal).toBe("Alpha parser tabs");
    const full = (await trace(w, preview.traceId!))!;
    expect(full).toMatchObject({
      kind: "quick-analysis",
      status: "ok",
      summary: "goal “Alpha parser tabs” · no topic",
    });
  });

  it("links an applied title to the analysis that suggested it", async () => {
    const w = await setup(true, () =>
      JSON.stringify({ ...ANALYSIS, goal: "Nested block parsing" }),
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
    expect(list.stdout).toContain("full-analysis");
    const [summary] = await traces(w);
    const shown = await w.harness.behavior.runCli(["trace", summary!.id]);
    expect(shown.stdout).toContain("Full analysis: Alpha parser");
    expect(shown.stdout).toContain("── Reasoning ──");
    expect(shown.stdout).toContain("── Prompt ──");
  });
});

describe("composer previews", () => {
  const prompt = "Fix the Alpha parser so it handles tab characters";
  /** Route calls wait until the test answers them or the call is aborted. */
  const pending = () => {
    const calls: {
      prompt: string;
      signal?: AbortSignal;
      answer: () => void;
    }[] = [];
    const complete: FakeCompletion = (call) =>
      isQuick(call.prompt)
        ? new Promise((resolve, reject) => {
            call.signal?.addEventListener("abort", () =>
              reject(call.signal!.reason),
            );
            calls.push({
              prompt: call.prompt,
              signal: call.signal,
              answer: () => resolve(JSON.stringify(QUICK)),
            });
          })
        : JSON.stringify(ANALYSIS);
    return { calls, complete };
  };
  const started = async (calls: unknown[], n: number) => {
    for (let i = 0; i < 100 && calls.length < n; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(n);
  };

  it("aborts the model call of a draft's older preview and does not trace it", async () => {
    const { calls, complete } = pending();
    const w = await setup(true, complete);
    const first = rpc(w, "preview", { prompt, draftKey: "draft-1" });
    const firstSettled = first.then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    await started(calls, 1);
    const second = rpc<{ goal: string | null }>(w, "preview", {
      prompt: `${prompt} and spaces`,
      draftKey: "draft-1",
    });
    await started(calls, 2);
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(await firstSettled).toContain("the draft changed");
    calls[1]!.answer();
    expect((await second).goal).toBe("Alpha parser tabs");
    const routes = (await traces(w)).filter((t) => t.kind === "quick-analysis");
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ status: "ok" });
  });

  it("aborts a draft's preview on cancel, and leaves other drafts alone", async () => {
    const { calls, complete } = pending();
    const w = await setup(true, complete);
    const mine = rpc(w, "preview", { prompt, draftKey: "mine" }).catch(
      () => "aborted",
    );
    const other = rpc<{ goal: string | null }>(w, "preview", {
      prompt,
      draftKey: "other",
    });
    await started(calls, 2);
    expect(await rpc(w, "previewCancel", { draftKey: "mine" })).toEqual({
      canceled: true,
    });
    expect(await mine).toBe("aborted");
    expect(await rpc(w, "previewCancel", { draftKey: "mine" })).toEqual({
      canceled: false,
    });
    calls[1]!.answer();
    expect((await other).goal).toBe("Alpha parser tabs");
  });
});
