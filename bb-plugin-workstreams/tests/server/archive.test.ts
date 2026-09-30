import { afterEach, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";

const worlds: Awaited<ReturnType<typeof fakeWorld>>[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.harness.lifecycle.dispose();
});
async function world(state = "done") {
  const w = await fakeWorld({
    complete: () =>
      JSON.stringify({
        recap: "Finished.",
        state,
        needsYou: null,
        subject: "Alpha",
        drift: null,
      }),
  });
  worlds.push(w);
  w.addThread("t1", { status: "idle", latestAttentionAt: 500 });
  w.converse("t1", ["Answer my question"], "Answered completely.");
  await w.harness.behavior.callRpc("refresh", null);
  await w.harness.behavior.runCli(["analyze", "t1"]);
  return w;
}
const suggestions = async (w: Awaited<ReturnType<typeof world>>) =>
  await w.harness.behavior
    .callRpc("archiveStatus", { threadId: "t1" })
    .then((value) => {
      const { revision } = value as { revision: number | null };
      return revision === null ? {} : { t1: revision };
    });

it("proposes a finished thread, but never archives without a click", async () => {
  const w = await world();
  expect(await suggestions(w)).toEqual({ t1: 500 });
  expect(w.threads.get("t1")!.archivedAt).toBeNull();
  await w.harness.behavior.callRpc("archiveSuggestion", {
    threadId: "t1",
    revision: 500,
    action: "archive",
  });
  expect(w.threads.get("t1")!.archivedAt).not.toBeNull();
  expect(await suggestions(w)).toEqual({});
});

it("persists dismissal for that turn and permits a later finished turn", async () => {
  const w = await world();
  await w.harness.behavior.callRpc("archiveSuggestion", {
    threadId: "t1",
    revision: 500,
    action: "dismiss",
  });
  expect(await suggestions(w)).toEqual({});
  // Reclassification at the same revision must not resurrect a dismissal.
  await w.harness.behavior.runCli(["analyze", "t1"]);
  expect(await suggestions(w)).toEqual({});
  w.threads.set("t1", { ...w.threads.get("t1")!, latestAttentionAt: 600 });
  await w.harness.behavior.runCli(["analyze", "t1"]);
  expect(await suggestions(w)).toEqual({ t1: 600 });
  expect(w.threads.get("t1")!.archivedAt).toBeNull();
});

it.each(["review", "needs_decision", "blocked", "in_progress"])(
  "does not propose %s work",
  async (state) => {
    expect(await suggestions(await world(state))).toEqual({});
  },
);

it.each([
  { status: "active" },
  { latestAttentionAt: 600 },
  { queuedWork: "waiting" },
  { queuedWork: "failed" },
  { hasPendingInteraction: true },
  { runtime: { displayStatus: "starting" } },
  { activity: { activeBackgroundAgentCount: 1 } },
])("rejects a suggestion when live work changes: %j", async (patch) => {
  const w = await world();
  w.threads.set("t1", { ...w.threads.get("t1")!, ...patch } as never);
  expect(await suggestions(w)).toEqual({});
  await expect(
    w.harness.behavior.callRpc("archiveSuggestion", {
      threadId: "t1",
      revision: 500,
      action: "archive",
    }),
  ).rejects.toThrow(/work|current/);
  expect(w.threads.get("t1")!.archivedAt).toBeNull();
});

it.each([
  { goal: { status: "paused" }, pendingTodos: null },
  { goal: { status: "active" }, pendingTodos: null },
  { goal: null, pendingTodos: { items: [{ status: "pending" }] } },
  { goal: null, pendingTodos: { items: [{ status: "in_progress" }] } },
])("blocks unfinished structured work: %j", async (timeline) => {
  const w = await world();
  w.harness.inspection.sdk.stub("threads.timeline", async () => timeline);
  expect(await suggestions(w)).toEqual({});
});

it("does not archive children or lifecycle dependents with unfinished work", async () => {
  const w = await world();
  w.addThread("child", { parentThreadId: "t1", status: "idle" });
  expect(await suggestions(w)).toEqual({});
  w.threads.delete("child");
  w.addThread("worker", {
    visibility: "hidden",
    lifecycleOwnerThreadId: "t1",
    status: "active",
  });
  expect(await suggestions(w)).toEqual({});
});

it("suppresses suggestions when outstanding work cannot be read", async () => {
  const w = await world();
  w.harness.inspection.sdk.stub("threads.timeline", async () => {
    throw new Error("offline");
  });
  expect(await suggestions(w)).toEqual({});
  await expect(
    w.harness.behavior.callRpc("state", null),
  ).resolves.toBeDefined();
});

it("requires completion evidence for idle hidden lifecycle dependents", async () => {
  const w = await world();
  w.addThread("hidden", {
    visibility: "hidden",
    lifecycleOwnerThreadId: "t1",
    status: "idle",
  });
  expect(await suggestions(w)).toEqual({});
});

it("rejects work introduced during archive validation", async () => {
  const w = await world();
  let reads = 0;
  w.harness.inspection.sdk.stub("threads.timeline", async () => {
    if (++reads === 1)
      w.addThread("new-child", { parentThreadId: "t1", status: "active" });
    return { goal: null, pendingTodos: null };
  });
  await expect(
    w.harness.behavior.callRpc("archiveSuggestion", {
      threadId: "t1",
      revision: 500,
      action: "archive",
    }),
  ).rejects.toThrow(/current/);
  expect(w.threads.get("t1")!.archivedAt).toBeNull();
});

it("accepts completed structured tasks and goals", async () => {
  const w = await world();
  w.harness.inspection.sdk.stub("threads.timeline", async () => ({
    goal: { status: "complete" },
    pendingTodos: { items: [{ status: "completed" }] },
  }));
  expect(await suggestions(w)).toEqual({ t1: 500 });
});
