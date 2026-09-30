import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import type { RetrievalSnapshot } from "../../src/domain/understanding-debug.ts";
let world: Awaited<ReturnType<typeof fakeWorld>> | undefined;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = undefined;
});

describe("understanding developer APIs", () => {
  it("explores retrieval locally without model calls or stored decision snapshots", async () => {
    world = await fakeWorld();
    const report = await world.harness.behavior.callRpc(
      "understandingRetrieve",
      { query: "Recap", budget: 500 },
    );
    expect(report).toMatchObject({
      query: "Recap",
      budget: 500,
      context: "",
      usedChars: 0,
    });
    const overview = await world.harness.behavior.callRpc(
      "understandingOverview",
      { limit: 10 },
    );
    expect(overview).toMatchObject({
      counts: { accounts: 0, observations: 0 },
    });
    const snapshots = await world.harness.behavior.callRpc(
      "understandingRetrievals",
      {},
    );
    expect(snapshots).toEqual({ retrievals: [] });
    expect(world.completions).toHaveLength(0);
  });

  it("records the exact understanding supplied to analysis even with Debug mode off", async () => {
    world = await fakeWorld();
    world.addThread("t1");
    world.converse("t1", ["Improve recap cards"]);
    await world.harness.behavior.runCli(["analyze", "t1"]);
    const { retrievals } = (await world.harness.behavior.callRpc(
      "understandingRetrievals",
      { threadId: "t1" },
    )) as { retrievals: RetrievalSnapshot[] };
    expect(retrievals).toHaveLength(1);
    expect(retrievals[0]).toMatchObject({
      consumer: "analysis",
      threadId: "t1",
      traceId: null,
    });
    expect(retrievals[0]?.report.query).toContain("Improve recap cards");
    expect(retrievals[0]?.report.context).toBe("");
  });

  it("attaches actual snapshots to retained model calls and preserves explicit-choice short circuits", async () => {
    world = await fakeWorld({
      settings: { debug: true },
      complete: ({ prompt }) =>
        prompt.includes("Someone is starting new work")
          ? JSON.stringify({
              outcome: "new-thread",
              workstream: "Workstreams",
              title: "Improve recap cards",
              code: false,
              confidence: "high",
              reason: "scope",
            })
          : JSON.stringify({ recap: "r", state: "done" }),
    });
    const section = world.addSection("Workstreams");
    world.addThread("t1", { sectionId: section.id });
    await world.harness.behavior.callRpc("refresh", null);
    const route = (await world.harness.behavior.callRpc("route", {
      prompt: "Improve recap cards",
    })) as { traceId: string };
    const { retrievals } = (await world.harness.behavior.callRpc(
      "understandingRetrievals",
      { traceId: route.traceId },
    )) as { retrievals: RetrievalSnapshot[] };
    expect(retrievals).toHaveLength(1);
    expect(retrievals[0]?.consumer).toBe("route");
    const before = (await world.harness.behavior.callRpc(
      "understandingRetrievals",
      {},
    )) as { retrievals: RetrievalSnapshot[] };
    await world.harness.behavior.callRpc("route", {
      prompt: "Improve recap cards",
      workstreamId: section.id,
    });
    const after = (await world.harness.behavior.callRpc(
      "understandingRetrievals",
      {},
    )) as { retrievals: RetrievalSnapshot[] };
    expect(after.retrievals).toHaveLength(before.retrievals.length);
  });

  it("CLI retrieval is read-only, bounded and validates incompatible modes", async () => {
    world = await fakeWorld();
    const report = await world.harness.behavior.runCli([
      "understanding",
      "Recap",
      "--retrieve",
      "--budget",
      "500",
      "--json",
    ]);
    expect(report.exitCode).toBe(0);
    expect(JSON.parse(report.stdout)).toMatchObject({
      budget: 500,
      query: "Recap",
    });
    expect(world.completions).toHaveLength(0);
    const invalid = await world.harness.behavior.runCli([
      "understanding",
      "--budget",
      "500",
    ]);
    expect(invalid.exitCode).not.toBe(0);
    expect(
      await world.harness.behavior.callRpc("understandingRetrievals", {}),
    ).toEqual({ retrievals: [] });
  });
});
