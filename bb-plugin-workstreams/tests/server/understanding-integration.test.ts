import { afterEach, describe, expect, it, vi } from "vitest";
import { Understanding } from "../../src/server/understanding.ts";
import { fakeWorld } from "./fake-bb.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await world?.harness.lifecycle.dispose();
  world = undefined;
  vi.restoreAllMocks();
});

async function analyze(w: World, id: string) {
  await w.harness.behavior.runCli(["analyze", id]);
}

const context = "Recap is a Workstreams capability [evidence obs-1].";
const retrievalReport = (query: string) => ({
  query,
  terms: [],
  budget: 8000,
  usedChars: context.length,
  context,
  accountIds: [],
  observationIds: [],
  candidates: [],
});

describe("understanding integration", () => {
  it("defaults automatic collection off while allowing retained context in analysis", async () => {
    const observe = vi
      .spyOn(Understanding.prototype, "observe")
      .mockResolvedValue();
    vi.spyOn(Understanding.prototype, "retrieve").mockImplementation((query) =>
      retrievalReport(query),
    );
    world = await fakeWorld();
    world.addThread("t1");
    world.converse("t1", ["Improve recap cards"]);
    await analyze(world, "t1");
    expect(observe).not.toHaveBeenCalled();
    expect(
      world.completions.find((c) =>
        c.prompt.includes("You describe one agent thread"),
      )?.prompt,
    ).toContain(context);
  });

  it("queues collection alongside analysis and isolates extraction failure from triage", async () => {
    const observe = vi
      .spyOn(Understanding.prototype, "observe")
      .mockRejectedValue(new Error("extraction unavailable"));
    world = await fakeWorld({ settings: { understandingAutomatic: true } });
    world.addThread("t1");
    await world.harness.behavior.callRpc("refresh", null);
    await analyze(world, "t1");
    expect(observe).toHaveBeenCalledWith("t1");
    const state = (await world.harness.behavior.callRpc("state", null)) as {
      analysis: Record<string, { state: string }>;
    };
    expect(state.analysis.t1?.state).toBe("review");
  });

  it("does not make triage wait for an unresolved extraction call", async () => {
    let release!: () => void;
    vi.spyOn(Understanding.prototype, "observe").mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    world = await fakeWorld({ settings: { understandingAutomatic: true } });
    world.addThread("t1");
    const result = await world.harness.behavior.runCli(["analyze", "t1"]);
    expect(result.exitCode).toBe(0);
    expect(
      world.completions.some((c) =>
        c.prompt.includes("You describe one agent thread"),
      ),
    ).toBe(true);
    release();
  });

  it("manual observation works without enabling automatic collection and rejects hidden threads", async () => {
    const observe = vi
      .spyOn(Understanding.prototype, "observe")
      .mockResolvedValue();
    vi.spyOn(Understanding.prototype, "context").mockReturnValue(context);
    world = await fakeWorld();
    world.addThread("t1");
    const result = await world.harness.behavior.runCli([
      "understanding",
      "Recap",
      "--observe",
      "t1",
    ]);
    expect(result.stdout).toContain(context);
    expect(observe).toHaveBeenCalledExactlyOnceWith("t1");
    world.addThread("hidden", { visibility: "hidden" });
    const rejected = await world.harness.behavior.runCli([
      "understanding",
      "--observe",
      "hidden",
    ]);
    expect(rejected.exitCode).not.toBe(0);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("supplies routing context without overriding explicit destination choices", async () => {
    const retrieve = vi
      .spyOn(Understanding.prototype, "retrieve")
      .mockImplementation((query) => retrievalReport(query));
    world = await fakeWorld({
      complete: ({ prompt }) =>
        prompt.includes("Someone is starting new work")
          ? JSON.stringify({
              outcome: "new-thread",
              workstream: "Workstreams",
              title: "Improve recap cards",
              code: false,
              confidence: "high",
              reason: "Integrated capability",
            })
          : JSON.stringify({ recap: "r", state: "done", subject: null }),
    });
    const workstreams = world.addSection("Workstreams");
    const recap = world.addSection("Recap");
    world.addThread("t1", { sectionId: workstreams.id });
    await world.harness.behavior.callRpc("refresh", null);
    const routed = (await world.harness.behavior.callRpc("route", {
      prompt: "Improve recap card spacing",
    })) as { sectionId: string };
    expect(routed.sectionId).toBe(workstreams.id);
    expect(retrieve).toHaveBeenCalledWith("Improve recap card spacing");
    expect(
      world.completions.find((c) =>
        c.prompt.includes("Someone is starting new work"),
      )?.prompt,
    ).toContain(context);
    const count = world.completions.length;
    const explicit = (await world.harness.behavior.callRpc("route", {
      prompt: "Improve recap card spacing",
      workstreamId: recap.id,
    })) as { sectionId: string };
    expect(explicit.sectionId).toBe(recap.id);
    expect(world.completions).toHaveLength(count);
  });

  it("catch-up skips current and backed-off threads", async () => {
    const observe = vi
      .spyOn(Understanding.prototype, "observe")
      .mockResolvedValue();
    vi.spyOn(Understanding.prototype, "needsObservation").mockImplementation(
      (id) => id === "pending",
    );
    world = await fakeWorld({ settings: { understandingAutomatic: true } });
    world.addThread("current");
    world.addThread("failed");
    world.addThread("pending");
    await world.harness.behavior.callRpc("refresh", null);
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    // The interval created before fake timers is real, so reload installs it
    // under the controlled clock while preserving host storage and settings.
    const { default: plugin } = await import("../../src/server/index.ts");
    await world.harness.lifecycle.reload(plugin);
    await vi.advanceTimersByTimeAsync(10_000);
    observe.mockClear();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(observe).toHaveBeenCalledWith("pending");
    expect(observe.mock.calls.every(([id]) => id === "pending")).toBe(true);
  });

  it("forgets evidence when the source thread is deleted", async () => {
    const forget = vi.spyOn(Understanding.prototype, "forget");
    world = await fakeWorld();
    const thread = world.addThread("t1");
    await world.harness.behavior.emitThreadEvent("thread.deleted", { thread });
    expect(forget).toHaveBeenCalledWith("t1");
  });
});
