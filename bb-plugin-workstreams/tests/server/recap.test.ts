import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/server/db.ts";
import { RecapScheduler } from "../../src/server/recap.ts";
import { Inference } from "../../src/server/model.ts";
import { TraceStore } from "../../src/server/trace.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of cleanups.splice(0)) await dispose();
});
const deferred = () => {
  let resolve!: (text: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function setup(
  complete: () => Promise<string> | string = () =>
    "Goal: Fixing recap freshness\nLatest: Tests pass",
) {
  let thread = makeThreadResponse({
    id: "t",
    status: "idle",
    archivedAt: null,
    visibility: "visible",
    latestAttentionAt: 100,
    updatedAt: 100,
  });
  const timeline = vi.fn(async () => ({
    rows: [
      {
        kind: "conversation",
        threadId: "t",
        id: "u",
        role: "user",
        text: "Fix stale recaps.",
      },
      {
        kind: "conversation",
        threadId: "t",
        id: "a",
        role: "assistant",
        text: "Fixed.",
      },
    ],
    timelinePage: { hasOlderRows: false, olderCursor: null },
  }));
  const get = vi.fn(async () => thread);
  const host = createFakePluginHost({
    pluginId: "recap-tests",
    sdk: { threads: { get, timeline } } as never,
  });
  const db = openDatabase(host.bb);
  const model = vi.fn(complete);
  const inference = new Inference({
    traces: new TraceStore(db),
    debug: async () => false,
    complete: async () => ({
      text: await model(),
      usage: { input: 1, output: 1, cost: 0 },
    }),
  });
  const recaps = new RecapScheduler({
    sdk: () => host.bb.sdk,
    db,
    inference,
    model: async () => "test",
    prefs: () => ({ quietSeconds: 30, minTurns: 3 }),
    triage: () => undefined,
    onChange: () => {},
    log: () => {},
  });
  cleanups.push(async () => {
    recaps.dispose();
    await host.harness.lifecycle.dispose();
  });
  return {
    recaps,
    db,
    timeline,
    get,
    model,
    setThread: (patch: Partial<typeof thread>) => {
      thread = { ...thread, ...patch };
    },
  };
}

describe("recap revision freshness", () => {
  it("persists generation revision and reads freshness without any timeline scan", async () => {
    const w = setup();
    const recap = await w.recaps.generate("t", { onDemand: true });
    expect(recap).toMatchObject({ revision: 100, turns: 1 });
    w.timeline.mockClear();
    w.get.mockClear();
    expect(await w.recaps.getFresh("t")).toMatchObject({ revision: 100 });
    expect(w.timeline).not.toHaveBeenCalled();
    expect(w.get).toHaveBeenCalledTimes(1);
    w.setThread({ latestAttentionAt: 101 });
    expect(await w.recaps.getFresh("t")).toBeNull();
    expect(w.timeline).not.toHaveBeenCalled();
  });
  it("does not display a matching-revision recap for an active, archived, or hidden thread", async () => {
    const w = setup();
    await w.recaps.generate("t", { onDemand: true });
    w.setThread({ status: "active" });
    expect(await w.recaps.getFresh("t")).toBeNull();
    w.setThread({ status: "idle", archivedAt: 1 });
    expect(await w.recaps.getFresh("t")).toBeNull();
    w.setThread({ archivedAt: null, visibility: "hidden" });
    expect(await w.recaps.getFresh("t")).toBeNull();
  });
  it("treats old recaps without a revision as stale without fetching history", async () => {
    const w = setup();
    w.db
      .prepare(
        "INSERT INTO ws_recap(thread_id,summary,generated_at,turns,model)VALUES('t','old',1,99,'old')",
      )
      .run();
    expect(await w.recaps.getFresh("t")).toBeNull();
    expect(w.timeline).not.toHaveBeenCalled();
    expect(w.get).not.toHaveBeenCalled();
  });
  it("hides recap on turn start even if a retry has not advanced revision yet", async () => {
    const w = setup();
    await w.recaps.generate("t", { onDemand: true });
    w.recaps.onActive("t");
    expect(await w.recaps.getFresh("t")).toBeNull();
    expect(w.recaps.get("t")?.summary).toContain("freshness");
  });
  it("rejects changes during generation with the same user-turn count", async () => {
    const pending = deferred();
    const w = setup(() => pending.promise);
    const generation = w.recaps.generate("t", { onDemand: true });
    await vi.waitFor(() => expect(w.model).toHaveBeenCalled());
    w.setThread({ latestAttentionAt: 101 });
    pending.resolve("Latest: Old answer");
    expect(await generation).toBeNull();
    expect(w.recaps.get("t")).toBeNull();
  });
  it("rejects a thread that becomes active during generation", async () => {
    const pending = deferred();
    const w = setup(() => pending.promise);
    const generation = w.recaps.generate("t", { onDemand: true });
    await vi.waitFor(() => expect(w.model).toHaveBeenCalled());
    w.setThread({ status: "active" });
    pending.resolve("Latest: Old answer");
    expect(await generation).toBeNull();
    expect(w.recaps.get("t")).toBeNull();
  });
  it("does not let an aborted older call overwrite a newer on-demand recap", async () => {
    const pending = deferred();
    let calls = 0;
    const w = setup(() =>
      ++calls === 1 ? pending.promise : "Latest: New answer",
    );
    const old = w.recaps.generate("t", { onDemand: true });
    await vi.waitFor(() => expect(w.model).toHaveBeenCalledTimes(1));
    const newer = await w.recaps.generate("t", { onDemand: true });
    pending.resolve("Latest: Old answer");
    await old;
    expect(newer?.summary).toContain("New answer");
    expect(w.recaps.get("t")?.summary).toContain("New answer");
  });
  it("does not save after deletion or disposal even if the provider ignores abort", async () => {
    for (const operation of ["delete", "dispose"]) {
      const pending = deferred();
      const w = setup(() => pending.promise);
      const generation = w.recaps.generate("t", { onDemand: true });
      await vi.waitFor(() => expect(w.model).toHaveBeenCalled());
      if (operation === "delete") w.recaps.disposeThread("t");
      else w.recaps.dispose();
      pending.resolve("Latest: Old answer");
      await generation;
      expect(w.recaps.get("t")).toBeNull();
    }
  });
  it("rejects incomplete transcript pagination instead of labelling a partial scan fresh", async () => {
    const w = setup();
    w.timeline.mockImplementation(
      async () =>
        ({
          rows: [],
          timelinePage: { hasOlderRows: true, olderCursor: null },
        }) as never,
    );
    expect(await w.recaps.generate("t", { onDemand: true })).toBeNull();
    expect(w.model).not.toHaveBeenCalled();
  });
  it("preserves automatic minimum turns and permits unchanged on-demand regeneration", async () => {
    const w = setup();
    expect(await w.recaps.generate("t")).toBeNull();
    expect(w.model).not.toHaveBeenCalled();
    expect(await w.recaps.generate("t", { onDemand: true })).not.toBeNull();
    expect(await w.recaps.generate("t", { onDemand: true })).not.toBeNull();
    expect(w.model).toHaveBeenCalledTimes(2);
  });
});
