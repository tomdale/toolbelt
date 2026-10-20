import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
let world: Awaited<ReturnType<typeof fakeWorld>> | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await world?.harness.lifecycle.dispose();
});
const id = (text: string) =>
  `r:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
const response = (
  title: string,
  summary: string,
  change: string,
  evidence: string,
) =>
  JSON.stringify({
    recap: "Working",
    state: "in_progress",
    goal: title,
    identity: { title, summary, change, evidenceIds: [id(evidence)] },
  });

describe("thread identity trajectories", () => {
  it("redacts opening credentials before persisting a provisional objective", async () => {
    world = await fakeWorld({
      complete: () =>
        JSON.stringify({
          recap: "Working",
          state: "in_progress",
          goal: "Release pipeline audit",
        }),
    });
    const w = world;
    const credential = "sk-" + "x".repeat(24);
    w.addThread("t", { status: "idle" });
    w.converse("t", [`Audit the pipeline using ${credential}`]);
    await w.harness.behavior.runCli(["analyze", "t"]);
    const state = (await w.harness.behavior.callRpc("state", null)) as {
      analysis: Record<string, { objective: { summary: string } }>;
    };
    expect(state.analysis.t!.objective.summary).toContain("[redacted]");
    expect(JSON.stringify(state.analysis)).not.toContain(credential);
  });
  it("reads a continuation reference supplied after the opening request", async () => {
    world = await fakeWorld();
    const w = world;
    w.addThread("source");
    w.converse("source", ["Audit the billing pipeline architecture"]);
    w.addThread("t", { status: "idle" });
    w.converse("t", [
      "Discuss the release pipeline",
      "Change direction: continue from @thread:source",
    ]);
    await w.harness.behavior.runCli(["analyze", "t"]);
    expect(w.completions.at(-1)?.prompt).toContain(
      "Audit the billing pipeline architecture",
    );
  });
  it("keeps a durable goal across many subtasks and accepts a supported user pivot", async () => {
    const opening =
      "Audit the release pipeline and propose reliability improvements";
    const pivot = "Change direction: implement the billing workflow instead";
    let phase = 0;
    world = await fakeWorld({
      complete: () =>
        phase === 0
          ? response("Release pipeline audit", opening, "refine", opening)
          : phase === 1
            ? response(
                "Run schema verification",
                "Only verify the schema",
                "keep",
                opening,
              )
            : response(
                "Implement billing workflow",
                "Implement the billing workflow",
                "pivot",
                pivot,
              ),
    });
    const w = world;
    w.addThread("t", { title: null, status: "idle", latestAttentionAt: 10 });
    w.converse("t", [opening]);
    await w.harness.behavior.runCli(["analyze", "t"]);
    await vi.waitFor(() =>
      expect(w.threads.get("t")?.title).toBe("Release pipeline audit"),
    );
    phase = 1;
    w.converse("t", [
      opening,
      ...Array.from({ length: 15 }, (_, i) => `Verify procedural step ${i}`),
    ]);
    w.threads.set("t", { ...w.threads.get("t")!, latestAttentionAt: 20 });
    await w.harness.behavior.runCli(["analyze", "t"]);
    expect(w.completions.at(-1)?.prompt).toContain("Durable objective:");
    expect(w.threads.get("t")?.title).toBe("Release pipeline audit");
    phase = 2;
    w.converse("t", [opening, pivot]);
    w.threads.set("t", { ...w.threads.get("t")!, latestAttentionAt: 30 });
    await w.harness.behavior.runCli(["analyze", "t"]);
    await vi.waitFor(() =>
      expect(w.threads.get("t")?.title).toBe("Implement billing workflow"),
    );
  });
  it("treats a bare continuation as status-only", async () => {
    world = await fakeWorld({
      complete: () =>
        JSON.stringify({
          recap: "Working",
          state: "in_progress",
          goal: "Build release pipeline",
        }),
    });
    const w = world;
    w.addThread("t", { status: "idle", latestAttentionAt: 10 });
    w.converse("t", ["Build the release pipeline"]);
    await w.harness.behavior.runCli(["analyze", "t"]);
    w.converse("t", ["Build the release pipeline", "continue"]);
    w.threads.set("t", { ...w.threads.get("t")!, latestAttentionAt: 20 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await w.harness.behavior.emitThreadEvent("thread.idle", {
      thread: w.threads.get("t")!,
      lastAssistantText: "Still working",
    });
    await vi.advanceTimersByTimeAsync(6000);
    const last = w.completions
      .filter((c) => c.prompt.includes("You describe one agent thread"))
      .at(-1)!;
    expect(last.prompt).not.toContain("- goal:");
  });
  it("includes bounded opening intent from an explicit continuation thread", async () => {
    world = await fakeWorld();
    const w = world;
    w.addThread("source");
    w.converse("source", ["Audit the release pipeline architecture"]);
    w.addThread("t", { status: "idle" });
    w.converse("t", ["Continue from @thread:source and review my changes"]);
    await w.harness.behavior.runCli(["analyze", "t"]);
    expect(w.completions.at(-1)?.prompt).toContain(
      "Audit the release pipeline architecture",
    );
    expect(w.completions.at(-1)?.prompt).toContain(
      "Referenced continuation context",
    );
  });
});
