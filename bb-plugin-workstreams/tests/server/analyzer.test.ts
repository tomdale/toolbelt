import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { fakeWorld, type FakeCompletion } from "./fake-bb.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await world?.harness.lifecycle.dispose();
  world = null;
});

async function setup(complete?: FakeCompletion) {
  world = await fakeWorld({ complete });
  return world;
}

type Analysis = {
  recap: string;
  state: string;
  revision: number;
  driftSectionId: string | null;
};
const state = async (w: World) =>
  (await w.harness.behavior.callRpc("state", null)) as {
    analysis: Record<string, Analysis>;
  };
const idle = (w: World, id: string, lastAssistantText = "Done.") =>
  w.harness.behavior.emitThreadEvent("thread.idle", {
    thread: w.threads.get(id)!,
    lastAssistantText,
  });
const settle = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  // Let the queued run's awaits finish.
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("idle analysis", () => {
  it("analyzes a thread a few seconds after its turn completes", async () => {
    const w = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    w.addThread("t1", { latestAttentionAt: 500 });
    w.converse("t1", ["Fix the bug"]);
    await idle(w, "t1", "Fixed; tests pass.");
    await settle(1_000);
    expect(w.completions).toHaveLength(0);
    await settle(5_000);
    expect(w.completions).toHaveLength(1);
    expect(w.completions[0]!.prompt).toContain("Fixed; tests pass.");
    expect(w.completions[0]!.model).toBe("google/gemini-3.1-flash-lite");
    const { analysis } = await state(w);
    expect(analysis.t1).toMatchObject({ state: "review", revision: 500 });
  });

  it("drops a scheduled run when a new turn starts first", async () => {
    const w = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    w.addThread("t1");
    await idle(w, "t1");
    await w.harness.behavior.emitThreadEvent("thread.active", {
      thread: w.threads.get("t1")!,
    });
    await settle(10_000);
    expect(w.completions).toHaveLength(0);
  });

  it("never moves, renames, or files a thread", async () => {
    const w = await setup(() =>
      JSON.stringify({
        recap: "Now building a markdown viewer.",
        state: "in_progress",
        subject: "Markdown viewer",
        drift: { workstream: "Beta", newName: null, confidence: "high" },
      }),
    );
    const alpha = w.addSection("Alpha");
    const beta = w.addSection("Beta");
    w.addThread("t1", { sectionId: alpha.id });
    await w.harness.behavior.callRpc("refresh", null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await idle(w, "t1");
    await settle(6_000);
    const { analysis } = await state(w);
    expect(analysis.t1?.driftSectionId).toBe(beta.id);
    expect(w.threads.get("t1")?.sectionId).toBe(alpha.id);
    const paths = w.harness.inspection.sdk.calls.map((call) => call.path);
    expect(paths).toContain("threads.get");
    const mutations =
      /^(threads\.(update|send|spawn|archive)|threadSections\.(create|update|delete))$/;
    expect(paths.filter((p) => mutations.test(p))).toEqual([]);
  });

  it("offers drift targets only to task threads, never the project name", async () => {
    const w = await setup();
    const alpha = w.addSection("Alpha");
    w.addSection("Beta");
    w.addThread("parent", { sectionId: alpha.id, projectId: "proj_secret" });
    w.addThread("child", { parentThreadId: "parent" });
    await w.harness.behavior.callRpc("refresh", null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await idle(w, "parent");
    await idle(w, "child");
    await settle(6_000);
    const [parent, child] = [
      w.completions.find((c) => c.prompt.includes("Thread parent")),
      w.completions.find((c) => c.prompt.includes("Thread child")),
    ];
    expect(parent?.prompt).toContain('Other workstreams: ["Beta"]');
    expect(child?.prompt).toContain('Workstream: "Alpha"');
    expect(child?.prompt).toContain("- drift: null.");
    for (const c of w.completions) expect(c.prompt).not.toContain("proj_");
  });

  it("keeps at most four calls in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const w = await setup(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight--;
      return JSON.stringify({ recap: "ok", state: "done" });
    });
    for (let i = 0; i < 7; i++) w.addThread(`t${i}`, { latestAttentionAt: 10 });
    await w.harness.behavior.callRpc("refresh", null);
    await w.harness.behavior.runCli(["analyze"]);
    for (let i = 0; i < 50 && release.length < 4; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(peak).toBe(4);
    while (inFlight > 0 || release.length > 0) {
      release.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(Object.keys((await state(w)).analysis)).toHaveLength(7);
    expect(peak).toBe(4);
  });

  it("catches up only threads whose latest turn wasn't analyzed", async () => {
    const w = await setup();
    w.addThread("t1", { latestAttentionAt: 10 });
    w.addThread("busy", { latestAttentionAt: 10, status: "active" });
    await w.harness.behavior.callRpc("refresh", null);
    const first = await w.harness.behavior.runCli(["analyze"]);
    expect(first.stdout).toContain("Queued 1 thread");
    await vi.waitFor(() => expect(w.completions).toHaveLength(1));
    const again = await w.harness.behavior.runCli(["analyze"]);
    expect(again.stdout).toContain("Queued 0 threads");
  });

  it("purges results for deleted threads", async () => {
    const w = await setup();
    w.addThread("t1");
    await w.harness.behavior.runCli(["analyze", "t1"]);
    expect((await state(w)).analysis.t1).toBeDefined();
    await w.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "t1" }),
    });
    expect((await state(w)).analysis.t1).toBeUndefined();
  });

  it("reports a failed call without storing a result", async () => {
    const w = await setup(() => "not json");
    w.addThread("t1");
    const result = await w.harness.behavior.runCli(["analyze", "t1"]);
    expect(result.exitCode).not.toBe(0);
    expect((await state(w)).analysis.t1).toBeUndefined();
  });
});
