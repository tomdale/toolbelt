import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeWorld } from "./fake-bb.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await world?.harness.lifecycle.dispose();
  world = null;
});

type Entry = {
  id: string;
  action: string;
  source: string;
  rationale: string;
  threads: { id: string; name: string }[];
};

/**
 * Every analysis infers the next goal in `goals`, which becomes the thread's
 * title. The last one repeats; null infers none.
 */
async function setup(
  goals: (string | null)[],
  settings?: Record<string, string | boolean>,
) {
  let call = 0;
  world = await fakeWorld({
    settings,
    complete: ({ prompt }) => {
      if (prompt.includes("Classify the most specific")) {
        return JSON.stringify({ subjectId: null, proposed: null });
      }
      return JSON.stringify({
        recap: "Working.",
        state: "in_progress",
        subject: "Alpha",
        goal: goals[Math.min(call++, goals.length - 1)] ?? null,
        drift: null,
      });
    },
  });
  return world;
}

const rpc = <T = unknown>(w: World, method: string, input: unknown) =>
  w.harness.behavior.callRpc(method, input) as Promise<T>;
const retitles = async (w: World) =>
  (await rpc<{ entries: Entry[] }>(w, "journal", {})).entries.filter(
    (e) => e.action === "retitle",
  );
const settle = async (ms = 6_000) => {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
/** Completes one turn for the thread and lets its analysis and retitle run. */
async function turn(w: World, id: string, at: number) {
  const thread = { ...w.threads.get(id)!, latestAttentionAt: at };
  w.threads.set(id, thread);
  await w.harness.behavior.emitThreadEvent("thread.idle", {
    thread,
    lastAssistantText: "Done.",
  });
  await settle();
}

describe("keeping thread titles current", () => {
  it("titles an untitled thread and journals it with undo", async () => {
    const w = await setup(["Fix stale build cache"]);
    w.addThread("t1", { title: null, titleFallback: "fix the cache thing…" });
    await rpc(w, "refresh", null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await turn(w, "t1", 100);
    // Analysis also starts an organizer pass, which may classify after it.
    const analysis = [...w.completions]
      .reverse()
      .find((c) => c.prompt.includes("You describe one agent thread"));
    expect(analysis!.prompt).toContain(
      'Title: none yet (BB shows the placeholder "fix the cache thing…")',
    );
    expect(w.threads.get("t1")?.title).toBe("Fix stale build cache");
    const [entry] = await retitles(w);
    expect(entry).toMatchObject({
      source: "auto",
      rationale: "Titled an untitled thread",
      threads: [{ id: "t1", name: "Fix stale build cache" }],
    });

    await rpc(w, "undo", { entryId: entry!.id });
    expect(w.threads.get("t1")?.title).toBeNull();
    // Undoing is a decision: later suggestions leave the thread alone.
    await turn(w, "t1", 200);
    expect(w.threads.get("t1")?.title).toBeNull();
  });

  it("retitles a thread whose focus moved, at most once an hour", async () => {
    // Before setup: the plugin captures Date.now when it loads.
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const w = await setup(["Markdown viewer themes", "Markdown viewer fonts"]);
    w.addThread("t1", { title: "Explain build caching" });
    await rpc(w, "refresh", null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await turn(w, "t1", 100);
    expect(w.threads.get("t1")?.title).toBe("Markdown viewer themes");
    const [entry] = await retitles(w);
    expect(entry?.rationale).toBe("Retitled from Explain build caching");

    now += 30 * 60_000;
    await turn(w, "t1", 200);
    expect(w.threads.get("t1")?.title).toBe("Markdown viewer themes");
    now += 31 * 60_000;
    await turn(w, "t1", 300);
    expect(w.threads.get("t1")?.title).toBe("Markdown viewer fonts");
    clock.mockRestore();
  });

  it("never overrides a title someone else changed", async () => {
    const w = await setup(["Markdown viewer themes"]);
    w.addThread("t1", { title: "Explain build caching" });
    await rpc(w, "refresh", null);
    // Renamed in BB's sidebar; the next reconcile observes it.
    w.threads.set("t1", { ...w.threads.get("t1")!, title: "My viewer" });
    await rpc(w, "refresh", null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await turn(w, "t1", 100);
    expect(w.threads.get("t1")?.title).toBe("My viewer");
    expect(await retitles(w)).toEqual([]);
  });

  it("notices a rename at retitle time even before a reconcile", async () => {
    // Before setup: the plugin captures Date.now when it loads.
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const w = await setup(["Markdown viewer themes", "Markdown viewer fonts"]);
    w.addThread("t1", { title: "Explain build caching" });
    await rpc(w, "refresh", null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await turn(w, "t1", 100);
    expect(w.threads.get("t1")?.title).toBe("Markdown viewer themes");
    w.threads.set("t1", { ...w.threads.get("t1")!, title: "My viewer" });
    now += 2 * 60 * 60_000;
    await turn(w, "t1", 200);
    expect(w.threads.get("t1")?.title).toBe("My viewer");
    clock.mockRestore();
  });

  it("keeps a title that already states the goal", async () => {
    const w = await setup(["Explain build caching"]);
    w.addThread("t1", { title: "Explain build caching" });
    await rpc(w, "refresh", null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await turn(w, "t1", 100);
    expect(w.threads.get("t1")?.title).toBe("Explain build caching");
    expect(await retitles(w)).toEqual([]);
    // The goal is still kept, as the context for the next analysis.
    const { analysis } = await rpc<{
      analysis: Record<string, { goal: string | null }>;
    }>(w, "state", null);
    expect(analysis.t1?.goal).toBe("Explain build caching");
  });

  it("does nothing when the goal is null or the setting is off", async () => {
    const kept = await setup([null]);
    kept.addThread("t1", { title: null });
    await rpc(kept, "refresh", null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await turn(kept, "t1", 100);
    expect(kept.threads.get("t1")?.title).toBeNull();
    vi.useRealTimers();
    await kept.harness.lifecycle.dispose();

    const off = await setup(["Fix stale build cache"], { autoTitle: false });
    off.addThread("t1", { title: null });
    await rpc(off, "refresh", null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await turn(off, "t1", 100);
    expect(off.threads.get("t1")?.title).toBeNull();
  });
});
