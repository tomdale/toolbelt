import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld, type FakeCompletion } from "./fake-bb.ts";
import { TopicStore } from "../../src/server/topics.ts";
import { openDatabase } from "../../src/server/db.ts";
import { RECAP_TOOL } from "../../src/domain/recap.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await world?.harness.lifecycle.dispose();
  world = null;
});

async function setup(complete?: FakeCompletion) {
  world = await fakeWorld({
    complete: (call) => {
      if (complete) return complete(call);
      return JSON.stringify({
        recap: "Fixed the bug; tests pass.",
        state: "review",
        needsYou: null,
      });
    },
  });
  return world;
}

type Analysis = {
  recap: string;
  goal: string | null;
  state: string;
  revision: number;
  reported?: boolean;
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
const analyses = (w: World) =>
  w.completions.filter((c) =>
    c.prompt.includes("You describe one agent thread"),
  );

describe("idle analysis", () => {
  it("supplies preceding substantive requests when the latest follow-ups are procedural", async () => {
    const w = await setup();
    w.addThread("t1", { status: "idle", latestAttentionAt: 10 });
    w.converse("t1", [
      "Monitor the deployment",
      "Investigate recurring scheduler schema errors",
      "Explain the schema migration",
      "Where is the code?",
      "Remove change-specific README details",
    ]);
    await w.harness.behavior.callRpc("refresh", null);
    await w.harness.behavior.runCli(["analyze", "t1"]);
    const prompt = analyses(w).at(-1)!.prompt;
    expect(prompt).toContain("Investigate recurring scheduler schema errors");
    expect(prompt).toContain("Explain the schema migration");
    expect(
      prompt.indexOf("Investigate recurring scheduler schema errors"),
    ).toBeLessThan(prompt.indexOf("Remove change-specific README details"));
    expect(prompt).toContain("Later evidence takes precedence");
  });
  it("persists observed names across runs without altering manual topics and deletes them with the thread", async () => {
    let count = 0;
    const w = await setup(() =>
      JSON.stringify({
        recap: "Done",
        state: "done",
        goal: "Name experiment",
        names: {
          products: count++ === 0 ? ["Lumen"] : ["Lumen", "BB"],
          features: [{ name: "Cache", product: "Lumen" }],
        },
      }),
    );
    w.addThread("t1", { status: "idle", latestAttentionAt: 10 });
    w.converse("t1", ["Fix the Lumen cache"]);
    await w.harness.behavior.callRpc("refresh", null);
    const topics = new TopicStore(openDatabase(w.bb));
    topics.assign("t1", null, { provenance: "manual" });
    await w.harness.behavior.runCli(["analyze", "t1"]);
    await w.harness.behavior.runCli(["analyze", "t1"]);
    const observed = (await w.harness.behavior.callRpc("observedNames", {
      threadId: "t1",
    })) as {
      products: { name: string; runs: number }[];
      features: { name: string; product: string; runs: number }[];
    };
    expect(observed.products).toMatchObject([
      { name: "BB", runs: 1 },
      { name: "Lumen", runs: 2 },
    ]);
    expect(observed.features).toMatchObject([
      { name: "Cache", product: "Lumen", runs: 2 },
    ]);
    expect(topics.list()).toHaveLength(0);
    expect(topics.assignment("t1").provenance).toBe("manual");
    expect(
      await w.harness.behavior.callRpc("observedNames", { threadId: "other" }),
    ).toEqual({ products: [], features: [] });
    await w.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: w.threads.get("t1")!,
    });
    expect(
      await w.harness.behavior.callRpc("observedNames", { threadId: "t1" }),
    ).toEqual({ products: [], features: [] });
  });
  it("analyzes a thread a few seconds after its turn completes", async () => {
    const w = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    w.addThread("t1", { latestAttentionAt: 500 });
    w.converse("t1", ["Fix the bug"]);
    await w.harness.behavior.callRpc("refresh", null);
    await idle(w, "t1", "Fixed; tests pass.");
    await settle(1_000);
    expect(analyses(w)).toHaveLength(0);
    await settle(5_000);
    expect(analyses(w)).toHaveLength(1);
    expect(analyses(w)[0]!.prompt).toContain("Fixed; tests pass.");
    expect(analyses(w)[0]!.model).toBe("openai/gpt-6-sol-fast");
    const { analysis } = await state(w);
    expect(analysis.t1).toMatchObject({
      state: "review",
      revision: 500,
      goal: "Thread t1",
    });
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
    expect(analyses(w)).toHaveLength(0);
  });

  it("settles a root's goal and topic after a new request", async () => {
    let topicId = "";
    const w = await setup(() =>
      JSON.stringify({
        recap: "Building the viewer.",
        state: "in_progress",
        goal: "Markdown viewer themes",
        subjectId: topicId,
        proposed: null,
      }),
    );
    const corpus = new TopicStore(openDatabase(w.bb));
    topicId = corpus.create("Viewer", "Markdown viewer").id;
    w.addThread("t1", { latestAttentionAt: 10, status: "idle" });
    w.converse("t1", ["Add themes to the markdown viewer"]);
    await w.harness.behavior.callRpc("refresh", null);
    await w.harness.behavior.runCli(["analyze", "t1"]);
    expect(analyses(w).at(-1)!.prompt).toContain("[" + topicId + "]");
    expect(corpus.assignment("t1")).toMatchObject({
      entityId: topicId,
      provenance: "full",
    });
    expect((await state(w)).analysis.t1?.goal).toBe("Markdown viewer themes");
  });

  it("asks nothing when the agent reported a turn with no new request", async () => {
    const w = await setup(() =>
      JSON.stringify({
        recap: "Working.",
        state: "in_progress",
        goal: "Markdown viewer themes",
      }),
    );
    w.addThread("t1", { latestAttentionAt: 10, status: "idle" });
    w.converse("t1", ["Add themes to the markdown viewer"]);
    await w.harness.behavior.callRpc("refresh", null);
    await w.harness.behavior.runCli(["analyze", "t1"]);
    const asked = analyses(w).length;

    // The agent reports a later turn that you sent nothing new for.
    await w.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "t1", parentThreadId: null },
      }),
    );
    w.threads.set("t1", { ...w.threads.get("t1")!, latestAttentionAt: 20 });
    w.turn("t1");
    await w.harness.behavior.callAgentTool(
      RECAP_TOOL,
      { state: "complete", goal: "Shipped themes", latest: ["Added themes"] },
      { threadId: "t1" },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await idle(w, "t1");
    await settle(6_000);
    expect(analyses(w)).toHaveLength(asked);
    const { analysis } = await state(w);
    expect(analysis.t1).toMatchObject({
      revision: 20,
      state: "done",
      reported: true,
      goal: "Markdown viewer themes",
    });
  });

  it("asks only for status after a turn with no new request and no report", async () => {
    const w = await setup(() =>
      JSON.stringify({
        recap: "Waiting on CI.",
        state: "blocked",
        goal: "Markdown viewer themes",
      }),
    );
    w.addThread("t1", { latestAttentionAt: 10, status: "idle" });
    w.converse("t1", ["Add themes to the markdown viewer"]);
    await w.harness.behavior.callRpc("refresh", null);
    await w.harness.behavior.runCli(["analyze", "t1"]);
    w.threads.set("t1", { ...w.threads.get("t1")!, latestAttentionAt: 20 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await idle(w, "t1");
    await settle(6_000);
    const last = analyses(w).at(-1)!.prompt;
    expect(last).not.toContain('"goal"');
    expect(last).not.toContain('"subjectId"');
    expect((await state(w)).analysis.t1).toMatchObject({
      revision: 20,
      state: "blocked",
    });
  });

  it("never asks for the topic of a thread whose topic you set", async () => {
    const w = await setup();
    const corpus = new TopicStore(openDatabase(w.bb));
    const mine = corpus.create("Mine", "");
    w.addThread("t1", { latestAttentionAt: 10, status: "idle" });
    corpus.assign("t1", mine.id, { provenance: "manual" });
    await w.harness.behavior.callRpc("refresh", null);
    await w.harness.behavior.runCli(["analyze", "t1"]);
    expect(analyses(w).at(-1)!.prompt).not.toContain('"subjectId"');
    expect(corpus.assignment("t1").provenance).toBe("manual");
  });

  it("gives a delegate a status and goal, never a topic of its own", async () => {
    const w = await setup();
    w.addThread("parent", { status: "idle" });
    w.addThread("child", { parentThreadId: "parent", status: "idle" });
    await w.harness.behavior.callRpc("refresh", null);
    await w.harness.behavior.runCli(["analyze", "child"]);
    expect(analyses(w).at(-1)!.prompt).not.toContain('"subjectId"');
    for (const c of w.completions) expect(c.prompt).not.toContain("proj_");
  });

  it("uses the previous durable goal as input and carries it forward when omitted", async () => {
    let previous: string | null = null;
    const w = await setup(({ prompt }) => {
      const match = prompt.match(
        /Previous title candidate \(context, not authority\): "([^"]+)"/,
      );
      previous = match?.[1] ?? null;
      return JSON.stringify({
        recap: "Still making progress",
        state: "in_progress",
        goal: "Make onboarding easier to complete",
      });
    });
    w.addThread("t1", { latestAttentionAt: 10 });
    await w.harness.behavior.callRpc("refresh", null);
    await w.harness.behavior.runCli(["analyze", "t1"]);
    expect((await state(w)).analysis.t1?.goal).toBe(
      "Make onboarding easier to complete",
    );
    expect(previous).toBeNull();

    const w2 = await setup(() =>
      JSON.stringify({ recap: "Side question answered", state: "done" }),
    );
    w2.addThread("t2", { latestAttentionAt: 10 });
    await w2.harness.behavior.callRpc("refresh", null);
    // Seed a prior result to model an existing durable goal. Results stored
    // before goals became titles also carry the title that was inferred then.
    w2.bb.storage
      .database()
      .prepare(
        "INSERT INTO ws_analysis (thread_id, revision, at, result) VALUES (?, ?, ?, ?)",
      )
      .run(
        "t2",
        9,
        1,
        JSON.stringify({
          recap: "prior",
          state: "in_progress",
          needsYou: null,
          subject: null,
          title: "Legacy inferred title",
          goal: "Make onboarding easier to complete",
          drift: null,
          driftSectionId: null,
          revision: 9,
          at: 1,
          model: "test",
        }),
      );
    await w2.harness.behavior.runCli(["analyze", "t2"]);
    expect(w2.completions.at(-1)?.prompt).toContain(
      'Previous title candidate (context, not authority): "Make onboarding easier to complete"',
    );
    expect(w2.completions.at(-1)?.prompt).not.toContain("Legacy inferred");
    expect((await state(w2)).analysis.t2?.goal).toBe(
      "Make onboarding easier to complete",
    );
  });

  it("reads a result stored when a thread also had an inferred title", async () => {
    const w = await setup();
    w.addThread("t1", { latestAttentionAt: 10 });
    await w.harness.behavior.callRpc("refresh", null);
    const legacy = {
      recap: "Fixed the parser.",
      state: "review",
      needsYou: null,
      subject: "Alpha",
      title: "Legacy inferred title",
      goal: "Make onboarding easier to complete",
      drift: null,
      driftSectionId: null,
      revision: 10,
      at: 1,
      model: "test",
    };
    w.bb.storage
      .database()
      .prepare(
        "INSERT INTO ws_analysis (thread_id, revision, at, result) VALUES ('t1', 10, 1, ?)",
      )
      .run(JSON.stringify(legacy));
    const { analysis } = await state(w);
    expect(analysis.t1).toMatchObject({
      recap: "Fixed the parser.",
      state: "review",
      goal: "Make onboarding easier to complete",
    });
    // The inferred title is not sent to clients.
    expect(analysis.t1).not.toHaveProperty("title");
    // The result is current and the thread has a topic, so nothing is
    // analyzed again.
    new TopicStore(openDatabase(w.bb)).assign("t1", null, {
      provenance: "manual",
    });
    await expect(w.harness.behavior.runCli(["analyze"])).resolves.toMatchObject(
      {
        stdout: expect.stringContaining("Queued 0 threads"),
      },
    );
  });

  it("prints the goal, which is the thread's title, when asked to analyze one thread", async () => {
    const w = await setup(() =>
      JSON.stringify({
        recap: "Working.",
        state: "in_progress",
        goal: "Make onboarding easier to complete",
      }),
    );
    w.addThread("t1", { latestAttentionAt: 10 });
    await w.harness.behavior.callRpc("refresh", null);
    const { stdout } = await w.harness.behavior.runCli(["analyze", "t1"]);
    expect(stdout).toContain("Goal: Make onboarding easier to complete");
  });

  it("never writes a goal carried over from before the cap as a title", async () => {
    // Older results kept goals of up to 80 characters; a title stays short.
    const legacy =
      "Make onboarding easier to complete for people who are new here";
    expect(legacy.length).toBeGreaterThan(60);
    const w = await setup(() =>
      JSON.stringify({ recap: "Working.", state: "in_progress", goal: null }),
    );
    w.addThread("t1", { title: null, latestAttentionAt: 10 });
    await w.harness.behavior.callRpc("refresh", null);
    w.bb.storage
      .database()
      .prepare(
        "INSERT INTO ws_analysis (thread_id, revision, at, result) VALUES (?, ?, ?, ?)",
      )
      .run(
        "t1",
        9,
        1,
        JSON.stringify({
          recap: "prior",
          state: "in_progress",
          needsYou: null,
          subject: null,
          goal: legacy,
          drift: null,
          driftSectionId: null,
          revision: 9,
          at: 1,
          model: "test",
        }),
      );
    await w.harness.behavior.runCli(["analyze", "t1"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await state(w)).analysis.t1?.goal).toBe(legacy);
    expect(w.threads.get("t1")?.title).toBeNull();
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
      return JSON.stringify({
        recap: "ok",
        state: "done",
        goal: "A lasting objective",
      });
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
    await vi.waitFor(() => expect(analyses(w)).toHaveLength(1));
    const again = await w.harness.behavior.runCli(["analyze"]);
    expect(again.stdout).toContain("Queued 0 threads");
  });

  it("purges results for deleted threads", async () => {
    const w = await setup();
    w.addThread("t1");
    await w.harness.behavior.callRpc("refresh", null);
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

  it("runs again when a turn completes while its run is in flight", async () => {
    const release: (() => void)[] = [];
    const w = await setup(async ({ prompt }) => {
      if (!prompt.includes("You describe one agent thread")) {
        return JSON.stringify({ subjectId: null, proposed: null });
      }
      await new Promise<void>((resolve) => release.push(resolve));
      return JSON.stringify({
        recap: prompt.includes("second") ? "second" : "first",
        state: "done",
      });
    });
    w.addThread("t1", { latestAttentionAt: 1 });
    w.converse("t1", ["go"], "first");
    await w.harness.behavior.callRpc("refresh", null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await idle(w, "t1", "first");
    await settle(6_000);
    expect(release).toHaveLength(1);
    // The next turn finishes while the first run is still waiting on the model.
    w.threads.set("t1", { ...w.threads.get("t1")!, latestAttentionAt: 2 });
    await idle(w, "t1", "second");
    await settle(6_000);
    release.shift()!();
    await settle(100);
    expect(release).toHaveLength(1);
    release.shift()!();
    await settle(100);
    expect((await state(w)).analysis.t1).toMatchObject({
      recap: "second",
      revision: 2,
    });
  });

  it("backs off after a failure and retries once the thread has a new turn", async () => {
    let fail = true;
    const w = await setup(() =>
      fail ? "not json" : JSON.stringify({ recap: "ok", state: "done" }),
    );
    w.addThread("t1", { latestAttentionAt: 10 });
    await w.harness.behavior.callRpc("refresh", null);
    const queue = async () =>
      (await w.harness.behavior.runCli(["analyze"])).stdout;
    expect(await queue()).toContain("Queued 1 thread");
    await vi.waitFor(() => expect(analyses(w)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(await queue()).toContain("Queued 0 threads");
    fail = false;
    w.threads.set("t1", { ...w.threads.get("t1")!, latestAttentionAt: 11 });
    await w.harness.behavior.callRpc("refresh", null);
    expect(await queue()).toContain("Queued 1 thread");
    await vi.waitFor(async () =>
      expect((await state(w)).analysis.t1?.revision).toBe(11),
    );
  });

  it("doesn't write back a thread deleted while its run was in flight", async () => {
    const release: (() => void)[] = [];
    const w = await setup(async ({ prompt }) => {
      if (!prompt.includes("You describe one agent thread")) {
        return JSON.stringify({ subjectId: null, proposed: null });
      }
      await new Promise<void>((resolve) => release.push(resolve));
      return JSON.stringify({ recap: "late", state: "done" });
    });
    w.addThread("t1");
    await w.harness.behavior.callRpc("refresh", null);
    const run = w.harness.behavior.runCli(["analyze", "t1"]);
    await vi.waitFor(() => expect(release).toHaveLength(1));
    await w.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "t1" }),
    });
    release.shift()!();
    await run;
    const row = w.bb.storage
      .database()
      .prepare("SELECT 1 FROM ws_analysis WHERE thread_id = 't1'")
      .get();
    expect(row).toBeUndefined();
  });
});
