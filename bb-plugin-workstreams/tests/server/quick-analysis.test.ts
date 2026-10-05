import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld, type FakeCompletion } from "./fake-bb.ts";
import { TopicStore } from "../../src/server/topics.ts";
import { openDatabase } from "../../src/server/db.ts";

/*
 * Quick analysis's title: a new thread named from its first request while
 * its first turn runs. These threads already have a topic, so Quick analysis
 * is asked only for the title; starting-topic.test.ts covers the topic.
 */

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await world?.harness.lifecycle.dispose();
  world = null;
});

const REQUEST =
  "Fix the stale build cache in the monorepo, it keeps serving old output";
const isOpening = (prompt: string) =>
  prompt.includes("You name one new agent thread from its opening request");
/** Gives a thread a topic, so Quick analysis has only its title to settle. */
const topicked = (w: World, id: string) =>
  new TopicStore(openDatabase(w.bb)).assign(id, null, {
    provenance: "manual",
  });
const openingCalls = (w: World) =>
  w.completions.filter((call) => isOpening(call.prompt));

type Entry = {
  id: string;
  action: string;
  source: string;
  rationale: string;
  threads: { id: string; name: string }[];
  undo: { kind: string; from: string | null; to: string } | null;
  traceIds: string[];
};
const rpc = <T = unknown>(w: World, method: string, input: unknown) =>
  w.harness.behavior.callRpc(method, input) as Promise<T>;
const retitles = async (w: World) =>
  (await rpc<{ entries: Entry[] }>(w, "journal", {})).entries.filter(
    (e) => e.action === "retitle",
  );
const titleRecord = (w: World, id: string) =>
  w.bb.storage
    .database()
    .prepare("SELECT * FROM ws_title WHERE thread_id = ?")
    .get(id) as
    | {
        observed: string | null;
        written: string | null;
        locked: number;
        provisional: number;
        retitled_at: number | null;
      }
    | undefined;

/** A model answer the test releases when it chooses. */
function gate() {
  let release!: (answer: string) => void;
  const answer = new Promise<string>((resolve) => (release = resolve));
  return { answer, release };
}

const opening = (goal: string | null) => JSON.stringify({ goal });
const analysis = (goal: string | null) =>
  JSON.stringify({ recap: "Working.", state: "in_progress", goal });

/** Answers each kind of call from its own queue; the last answer repeats. */
function models(answers: {
  opening?: (string | null)[];
  analysis?: (string | null)[];
}): FakeCompletion {
  const calls = { opening: 0, analysis: 0 };
  return ({ prompt }) => {
    const kind = isOpening(prompt) ? "opening" : "analysis";
    const list = answers[kind] ?? [null];
    const goal = list[Math.min(calls[kind]++, list.length - 1)] ?? null;
    return kind === "opening" ? opening(goal) : analysis(goal);
  };
}

async function setup(
  complete: FakeCompletion,
  settings?: Record<string, string | boolean>,
) {
  world = await fakeWorld({ complete, settings });
  return world;
}

/** A thread whose first turn is starting, as BB shows it before any title. */
function newThread(w: World, id = "t1", overrides = {}) {
  topicked(w, id);
  return w.addThread(id, {
    title: null,
    titleFallback: "Fix the stale build cache in the monorepo, it keeps serv…",
    status: "starting",
    latestAttentionAt: 100,
    updatedAt: 100,
    createdAt: Date.now(),
    ...overrides,
  });
}

/** BB admits the thread's first message: it has an origin. */
const firstMessage = (
  w: World,
  id = "t1",
  text = REQUEST,
  overrides: Record<string, unknown> = {},
) =>
  w.harness.registrations.hooks["message.dispatch"]!(
    makeMessageDispatchHookContext({
      thread: w.threads.get(id)!,
      input: { blocks: [], text },
      origin: "app",
      ...overrides,
    }),
  );

const flush = async (ticks = 60) => {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
};
const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};
/** The thread's first turn ends: BB moves its attention and the thread idles. */
async function finishTurn(w: World, id: string, at: number) {
  const thread = {
    ...w.threads.get(id)!,
    status: "idle" as const,
    latestAttentionAt: at,
    updatedAt: at,
  };
  w.threads.set(id, thread);
  await w.harness.behavior.emitThreadEvent("thread.idle", {
    thread,
    lastAssistantText: "Fixed it.",
  });
}

describe("naming a thread from its opening request", () => {
  it("titles it while its first turn is still running, without waiting on the model", async () => {
    const pending = gate();
    const w = await setup(({ prompt }) =>
      isOpening(prompt) ? pending.answer : analysis(null),
    );
    newThread(w);
    const decision = await firstMessage(w);
    // The turn is admitted at once; the title is still being inferred.
    expect(decision).toEqual({ action: "proceed" });
    await vi.waitFor(() => expect(openingCalls(w)).toHaveLength(1));
    expect(w.threads.get("t1")?.title).toBeNull();

    pending.release(opening("Fix stale build cache"));
    await vi.waitFor(() =>
      expect(w.threads.get("t1")?.title).toBe("Fix stale build cache"),
    );
    expect(w.threads.get("t1")?.status).toBe("starting");

    const [entry] = await retitles(w);
    expect(entry).toMatchObject({
      source: "auto",
      rationale: "Titled from the opening request",
      threads: [{ id: "t1", name: "Fix stale build cache" }],
      undo: { kind: "retitle", from: null, to: "Fix stale build cache" },
    });
    expect(titleRecord(w, "t1")).toMatchObject({
      written: "Fix stale build cache",
      locked: 0,
      provisional: 1,
    });
  });

  it("sends the model the opening request alone and one small call per thread", async () => {
    const w = await setup(models({ opening: ["Fix stale build cache"] }));
    newThread(w);
    await firstMessage(w);
    await vi.waitFor(() => expect(w.threads.get("t1")?.title).not.toBeNull());
    expect(openingCalls(w)).toHaveLength(1);
    const { prompt, model } = openingCalls(w)[0]!;
    expect(model).toBe("google/gemini-3.1-flash-lite");
    expect(prompt).toContain(REQUEST);
    expect(prompt).toContain('Return {"goal": string|null, "subjectId": string|null');
    expect(prompt).not.toContain("Last assistant");
    expect(prompt).not.toContain("Zebracorn");
    // BB re-runs the hook for a queued message, a retry, and a restart; the
    // thread is still named once.
    await firstMessage(w);
    await w.harness.behavior.emitThreadEvent("thread.active", {
      thread: w.threads.get("t1")!,
    });
    await flush();
    expect(openingCalls(w)).toHaveLength(1);
  });

  it("is replaced by the first analysis whatever the hour's cooldown says", async () => {
    const w = await setup(
      models({
        opening: ["Fix stale build cache"],
        analysis: ["Speed up the monorepo build", "Cache the monorepo build"],
      }),
    );
    newThread(w);
    await firstMessage(w);
    await vi.waitFor(() =>
      expect(w.threads.get("t1")?.title).toBe("Fix stale build cache"),
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await finishTurn(w, "t1", 200);
    await settle(6_000);
    // Seconds after the provisional title: no cooldown applies to it.
    expect(w.threads.get("t1")?.title).toBe("Speed up the monorepo build");
    expect((await retitles(w)).map((e) => e.rationale)).toEqual([
      "Retitled after the first turn from Fix stale build cache",
      "Titled from the opening request",
    ]);
    expect(titleRecord(w, "t1")).toMatchObject({
      written: "Speed up the monorepo build",
      provisional: 0,
    });

    // From then on it is an ordinary title: at most one change an hour.
    await finishTurn(w, "t1", 300);
    await settle(6_000);
    expect(w.threads.get("t1")?.title).toBe("Speed up the monorepo build");
  });

  it("settles when the first analysis agrees, so the cooldown applies from then on", async () => {
    const w = await setup(
      models({
        opening: ["Fix stale build cache"],
        analysis: ["Fix stale build cache", "Cache the monorepo build"],
      }),
    );
    newThread(w);
    await firstMessage(w);
    await vi.waitFor(() =>
      expect(w.threads.get("t1")?.title).toBe("Fix stale build cache"),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await finishTurn(w, "t1", 200);
    await settle(6_000);
    expect(titleRecord(w, "t1")).toMatchObject({ provisional: 0 });
    expect(await retitles(w)).toHaveLength(1);
    // Now an ordinary Workstreams title: a different goal waits out the hour.
    await finishTurn(w, "t1", 300);
    await settle(6_000);
    expect(w.threads.get("t1")?.title).toBe("Fix stale build cache");
    expect(await retitles(w)).toHaveLength(1);
  });

  it("leaves a title that appeared first alone, whoever wrote it", async () => {
    for (const rival of ["Build cache bug", "My own name"]) {
      const pending = gate();
      const w = await setup(({ prompt }) =>
        isOpening(prompt) ? pending.answer : analysis(null),
      );
      newThread(w);
      await w.harness.behavior.callRpc("refresh", null);
      await firstMessage(w);
      await vi.waitFor(() => expect(openingCalls(w)).toHaveLength(1));
      // BB's generator, the user, or an agent titles the thread meanwhile.
      w.threads.set("t1", { ...w.threads.get("t1")!, title: rival });
      pending.release(opening("Fix stale build cache"));
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(w.threads.get("t1")?.title).toBe(rival);
      expect(await retitles(w)).toEqual([]);
      await w.harness.lifecycle.dispose();
    }
  });

  it("never touches a locked title", async () => {
    const w = await setup(models({ opening: ["Fix stale build cache"] }));
    newThread(w);
    // The user undid an earlier automatic title: the thread stays as it is.
    w.bb.storage
      .database()
      .prepare(
        "INSERT INTO ws_title (thread_id, observed, written, locked, retitled_at, provisional) VALUES ('t1', NULL, NULL, 1, NULL, 0)",
      )
      .run();
    await firstMessage(w);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openingCalls(w)).toHaveLength(0);
    expect(w.threads.get("t1")?.title).toBeNull();
  });

  it("stays away once the user undoes it, even after the first analysis", async () => {
    const w = await setup(
      models({
        opening: ["Fix stale build cache"],
        analysis: ["Speed up the monorepo build"],
      }),
    );
    newThread(w);
    await firstMessage(w);
    await vi.waitFor(() =>
      expect(w.threads.get("t1")?.title).toBe("Fix stale build cache"),
    );
    const [entry] = await retitles(w);
    await rpc(w, "undo", { entryId: entry!.id });
    expect(w.threads.get("t1")?.title).toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await finishTurn(w, "t1", 200);
    await settle(6_000);
    expect(w.threads.get("t1")?.title).toBeNull();
    expect(titleRecord(w, "t1")).toMatchObject({ locked: 1, provisional: 0 });
  });

  it("makes no call when titles are turned off", async () => {
    const w = await setup(models({ opening: ["Fix stale build cache"] }), {
      autoTitle: false,
    });
    newThread(w);
    await firstMessage(w);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openingCalls(w)).toHaveLength(0);
    expect(w.threads.get("t1")?.title).toBeNull();
  });

  it("doesn't apply a title when the setting is turned off during the call", async () => {
    const pending = gate();
    const w = await setup(({ prompt }) =>
      isOpening(prompt) ? pending.answer : analysis(null),
    );
    newThread(w);
    await firstMessage(w);
    await vi.waitFor(() => expect(openingCalls(w)).toHaveLength(1));
    await rpc(w, "setPrefs", { patch: { threads: { autoTitle: false } } });
    pending.release(opening("Fix stale build cache"));
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.threads.get("t1")?.title).toBeNull();
    expect(await retitles(w)).toEqual([]);
  });

  it("falls back to the first analysis when the call fails or isn't usable", async () => {
    for (const bad of ["not json", '{"goal": "' + "word ".repeat(30) + '"}']) {
      const w = await setup(({ prompt }) =>
        isOpening(prompt) ? bad : analysis("Speed up the monorepo build"),
      );
      newThread(w);
      expect(await firstMessage(w)).toEqual({ action: "proceed" });
      await vi.waitFor(() => expect(openingCalls(w)).toHaveLength(1));
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(w.threads.get("t1")?.title).toBeNull();
      expect(await retitles(w)).toEqual([]);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await finishTurn(w, "t1", 200);
      await settle(6_000);
      expect(w.threads.get("t1")?.title).toBe("Speed up the monorepo build");
      expect((await retitles(w))[0]?.rationale).toBe(
        "Titled an untitled thread",
      );
      vi.useRealTimers();
      await w.harness.lifecycle.dispose();
    }
  });

  it("gives up on a model that doesn't answer in time, and traces the failure", async () => {
    let aborted = false;
    const w = await setup(
      ({ prompt, signal }) =>
        isOpening(prompt)
          ? new Promise<string>((_, reject) =>
              signal?.addEventListener("abort", () => {
                aborted = true;
                reject(signal.reason);
              }),
            )
          : analysis("Speed up the monorepo build"),
      { debug: true },
    );
    newThread(w);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(await firstMessage(w)).toEqual({ action: "proceed" });
    await settle(14_000);
    expect(aborted).toBe(false);
    await settle(1_500);
    expect(aborted).toBe(true);
    expect(w.threads.get("t1")?.title).toBeNull();
    const { traces } = await rpc<{
      traces: { kind: string; status: string; error: string | null }[];
    }>(w, "traces", { kind: "quick-analysis" });
    expect(traces).toMatchObject([
      {
        kind: "quick-analysis",
        status: "failed",
        error: "The model didn't answer within 15 seconds.",
      },
    ]);
    await finishTurn(w, "t1", 200);
    await settle(6_000);
    expect(w.threads.get("t1")?.title).toBe("Speed up the monorepo build");
  });

  it("doesn't apply a title once the turn it was inferred during has ended", async () => {
    const pending = gate();
    const w = await setup(({ prompt }) =>
      isOpening(prompt)
        ? pending.answer
        : analysis("Speed up the monorepo build"),
    );
    newThread(w);
    await firstMessage(w);
    await vi.waitFor(() => expect(openingCalls(w)).toHaveLength(1));
    // A quick turn: it finishes before the model answers.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await finishTurn(w, "t1", 200);
    pending.release(opening("Fix stale build cache"));
    await settle(6_000);
    // Its analysis named the thread; the stale opening goal did not.
    expect(w.threads.get("t1")?.title).toBe("Speed up the monorepo build");
    expect((await retitles(w)).map((e) => e.rationale)).toEqual([
      "Titled an untitled thread",
    ]);
  });

  it("makes no call when the request doesn't say what the work is", async () => {
    const w = await setup(models({ opening: [null] }));
    newThread(w);
    await firstMessage(w, "t1", "hi there");
    await vi.waitFor(() => expect(openingCalls(w)).toHaveLength(1));
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.threads.get("t1")?.title).toBeNull();
    expect(await retitles(w)).toEqual([]);
  });

  describe("skips what the analysis path skips", () => {
    const cases: [string, (w: World) => Promise<unknown>][] = [
      [
        "a hidden thread (workers and side chats)",
        async (w) => {
          newThread(w, "t1", {
            visibility: "hidden",
            title: "Workstreams worker",
          });
          return firstMessage(w);
        },
      ],
      [
        "an archived thread",
        async (w) => {
          newThread(w, "t1", { archivedAt: 5 });
          return firstMessage(w);
        },
      ],
      [
        "a thread that already has a title",
        async (w) => {
          newThread(w, "t1", { title: "Given at spawn" });
          return firstMessage(w);
        },
      ],
      [
        "a follow-up, steer, or retry (no origin)",
        async (w) => {
          newThread(w);
          return firstMessage(w, "t1", REQUEST, { origin: null });
        },
      ],
      [
        "a message that joins a running turn",
        async (w) => {
          newThread(w);
          return firstMessage(w, "t1", REQUEST, { attempt: "join-turn" });
        },
      ],
      [
        "a message BB wrote to a parent",
        async (w) => {
          newThread(w);
          return firstMessage(w, "t1", "[bb system] @thread:x completed: ok");
        },
      ],
      [
        "an empty request",
        async (w) => {
          newThread(w);
          return firstMessage(w, "t1", "   ");
        },
      ],
      [
        "a thread whose turn was already analyzed",
        async (w) => {
          newThread(w);
          w.bb.storage
            .database()
            .prepare(
              "INSERT INTO ws_analysis (thread_id, revision, at, result) VALUES ('t1', 1, 1, '{}')",
            )
            .run();
          return firstMessage(w);
        },
      ],
    ];
    for (const [name, arrange] of cases)
      it(`makes no call for ${name}`, async () => {
        const w = await setup(models({ opening: ["Fix stale build cache"] }));
        expect(await arrange(w)).toEqual({ action: "proceed" });
        await flush();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(openingCalls(w)).toHaveLength(0);
        expect(await retitles(w)).toEqual([]);
      });
  });

  it("never fails the turn it names", async () => {
    const w = await setup(models({ opening: ["Fix stale build cache"] }));
    newThread(w);
    // Even a context the naming can't make sense of is admitted.
    expect(await firstMessage(w, "t1", undefined as unknown as string)).toEqual(
      { action: "proceed" },
    );
    expect(openingCalls(w)).toHaveLength(0);
  });

  it("doesn't fail the turn when the model does", async () => {
    const w = await setup(() => {
      throw new Error("gateway down");
    });
    newThread(w);
    expect(await firstMessage(w)).toEqual({ action: "proceed" });
    await vi.waitFor(() => expect(openingCalls(w)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.threads.get("t1")?.title).toBeNull();
  });

  it("names a running thread whose dispatch it never saw, from its events", async () => {
    const w = await setup(models({ opening: ["Fix stale build cache"] }));
    newThread(w, "t1", { status: "active" });
    w.converse("t1", [REQUEST], null);
    await w.harness.behavior.emitThreadEvent("thread.active", {
      thread: w.threads.get("t1")!,
    });
    await vi.waitFor(() =>
      expect(w.threads.get("t1")?.title).toBe("Fix stale build cache"),
    );
    expect(openingCalls(w)).toHaveLength(1);
    expect(openingCalls(w)[0]!.prompt).toContain(REQUEST);
    expect((await retitles(w))[0]?.rationale).toBe(
      "Titled from the opening request",
    );
  });

  it("names the untitled threads found running after a reload", async () => {
    const w = await setup(models({ opening: ["Fix stale build cache"] }));
    newThread(w, "t1", { status: "active" });
    w.converse("t1", [REQUEST], null);
    // Already titled, idle, or hidden: not named.
    newThread(w, "t2", { status: "active", title: "Mine" });
    newThread(w, "t3", { status: "idle" });
    newThread(w, "t4", { status: "active", visibility: "hidden" });
    for (const id of ["t2", "t3", "t4"]) w.converse(id, [REQUEST], null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Any lifecycle event schedules a reconcile, which sweeps.
    await w.harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: w.threads.get("t1")!,
    });
    await settle(2_000);
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(w.threads.get("t1")?.title).toBe("Fix stale build cache"),
    );
    // The idle thread is analyzed, not named from its request.
    await flush();
    expect(w.completions.filter((call) => isOpening(call.prompt))).toHaveLength(
      1,
    );
    expect(w.threads.get("t2")?.title).toBe("Mine");
    expect(w.threads.get("t3")?.title).toBeNull();
  });

  it("runs at most four calls at once", async () => {
    const release: ((answer: string) => void)[] = [];
    let inFlight = 0;
    let peak = 0;
    const w = await setup(async ({ prompt }) => {
      if (!isOpening(prompt)) return analysis(null);
      inFlight++;
      peak = Math.max(peak, inFlight);
      const answer = await new Promise<string>((resolve) =>
        release.push(resolve),
      );
      inFlight--;
      return answer;
    });
    for (let i = 0; i < 6; i++) newThread(w, `t${i}`);
    for (let i = 0; i < 6; i++) await firstMessage(w, `t${i}`);
    await vi.waitFor(() => expect(release).toHaveLength(4));
    await flush();
    expect(peak).toBe(4);
    expect(openingCalls(w)).toHaveLength(4);
    for (const send of release.splice(0))
      send(opening("Fix stale build cache"));
    await vi.waitFor(() => expect(inFlight).toBe(0));
  });

  it("records the call on the trace, linked to the title it wrote", async () => {
    const w = await setup(models({ opening: ["Fix stale build cache"] }), {
      debug: true,
    });
    newThread(w);
    await firstMessage(w);
    await vi.waitFor(() =>
      expect(w.threads.get("t1")?.title).toBe("Fix stale build cache"),
    );
    const { traces } = await rpc<{
      traces: {
        id: string;
        kind: string;
        status: string;
        summary: string | null;
        label: string;
        threads: string[];
      }[];
    }>(w, "traces", {});
    const openingTraces = traces.filter((t) => t.kind === "quick-analysis");
    expect(openingTraces).toHaveLength(1);
    expect(openingTraces[0]).toMatchObject({
      kind: "quick-analysis",
      status: "ok",
      summary: "goal “Fix stale build cache” · no topic",
      threads: ["t1"],
    });
    // The label is the request's opening words, as BB shows them.
    expect(openingTraces[0]!.label.length).toBeLessThanOrEqual(60);
    expect(openingTraces[0]!.label).toMatch(
      /^Fix the stale build cache in the monorepo/,
    );
    const { trace } = await rpc<{
      trace: { outcome: unknown; links: { kind: string }[]; prompt: string };
    }>(w, "trace", { id: openingTraces[0]!.id });
    expect(trace.outcome).toMatchObject({ title: "applied" });
    expect(trace.links.map((l) => l.kind).sort()).toEqual(["entry", "thread"]);
    const [entry] = await retitles(w);
    expect(entry!.traceIds).toEqual([openingTraces[0]!.id]);
  });

  it("records why a title it inferred wasn't applied", async () => {
    const pending = gate();
    const w = await setup(
      ({ prompt }) => (isOpening(prompt) ? pending.answer : analysis(null)),
      { debug: true },
    );
    newThread(w);
    await firstMessage(w);
    await vi.waitFor(() => expect(openingCalls(w)).toHaveLength(1));
    w.threads.set("t1", { ...w.threads.get("t1")!, title: "Given elsewhere" });
    pending.release(opening("Fix stale build cache"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const { traces } = await rpc<{ traces: { id: string; kind: string }[] }>(
      w,
      "traces",
      {},
    );
    const openingTrace = traces.find((t) => t.kind === "quick-analysis");
    const { trace } = await rpc<{ trace: { outcome: unknown } }>(w, "trace", {
      id: openingTrace!.id,
    });
    expect(trace.outcome).toMatchObject({ title: "not applied: titled" });
  });
});
