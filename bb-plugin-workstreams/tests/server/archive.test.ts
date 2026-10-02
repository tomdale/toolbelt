import { afterEach, expect, it } from "vitest";
import {
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { RECAP_TOOL } from "../../src/domain/recap.ts";
import { fakeWorld } from "./fake-bb.ts";

const worlds: Awaited<ReturnType<typeof fakeWorld>>[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.harness.lifecycle.dispose();
});
type World = Awaited<ReturnType<typeof fakeWorld>>;

/** Reports `state` from the thread's agent for its latest turn. */
async function report(w: World, threadId: string, state = "complete") {
  await w.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: threadId, parentThreadId: null },
    }),
  );
  w.turn(threadId);
  await w.harness.behavior.callAgentTool(
    RECAP_TOOL,
    {
      state,
      goal: "Answering a question",
      latest: state === "waiting" ? [] : ["Answered it"],
      ...(state === "review" ? { review: "Read the answer" } : {}),
      ...(state === "waiting"
        ? { task: "Workers are running", timeout: 60 }
        : {}),
    },
    { threadId },
  );
}

async function world(state = "complete") {
  const w = await fakeWorld();
  worlds.push(w);
  w.addThread("t1", { status: "idle", latestAttentionAt: 500 });
  await w.harness.behavior.callRpc("refresh", null);
  await report(w, "t1", state);
  return w;
}
const recapId = async (w: World) =>
  (
    (await w.harness.behavior.callRpc("recap_get", { threadId: "t1" })) as {
      recap: { id: string };
    }
  ).recap.id;
const suggestions = async (w: World) => {
  const { recapId: id } = (await w.harness.behavior.callRpc("archiveStatus", {
    threadId: "t1",
  })) as { recapId: string | null };
  return id === null ? {} : { t1: id };
};
const archive = async (w: World, id?: string) =>
  w.harness.behavior.callRpc("archive", {
    threadId: "t1",
    recapId: id ?? (await recapId(w)),
  });

it("offers Archive on a complete recap, but never archives without a click", async () => {
  const w = await world();
  expect(await suggestions(w)).toEqual({ t1: await recapId(w) });
  expect(w.threads.get("t1")!.archivedAt).toBeNull();
  await archive(w);
  expect(w.threads.get("t1")!.archivedAt).not.toBeNull();
});

it("never offers or accepts Archive while waiting, even when BB is idle", async () => {
  const w = await world("waiting");
  expect(await suggestions(w)).toEqual({});
  await expect(archive(w)).rejects.toThrow(/work|current/);
  expect(w.threads.get("t1")!.archivedAt).toBeNull();
});

it("lets the user accept a reviewed result by archiving", async () => {
  const w = await world("review");
  expect(await suggestions(w)).toEqual({ t1: await recapId(w) });
  await archive(w);
  expect(w.threads.get("t1")!.archivedAt).not.toBeNull();
});

it("offers nothing without a recap for the latest turn, or for a stale one", async () => {
  const w = await world();
  const id = await recapId(w);
  await w.harness.inspection.registrations.hooks["message.dispatch"]!(
    makeMessageDispatchHookContext({ thread: w.threads.get("t1")! }),
  );
  expect(await suggestions(w)).toEqual({});
  await expect(archive(w, id)).rejects.toThrow(/current/);
  expect(w.threads.get("t1")!.archivedAt).toBeNull();
});

it.each([
  { status: "active" },
  { queuedWork: "waiting" },
  { queuedWork: "failed" },
  { hasPendingInteraction: true },
  { runtime: { displayStatus: "starting" } },
  { activity: { activeBackgroundAgentCount: 1 } },
])("rejects a suggestion when live work changes: %j", async (patch) => {
  const w = await world();
  w.threads.set("t1", { ...w.threads.get("t1")!, ...patch } as never);
  expect(await suggestions(w)).toEqual({});
  await expect(archive(w)).rejects.toThrow(/work|current/);
  expect(w.threads.get("t1")!.archivedAt).toBeNull();
});

it.each([
  { goal: { status: "paused" }, pendingTodos: null },
  { goal: { status: "active" }, pendingTodos: null },
  { goal: null, pendingTodos: { items: [{ status: "pending" }] } },
  { goal: null, pendingTodos: { items: [{ status: "in_progress" }] } },
])("blocks unfinished structured work: %j", async (timeline) => {
  const w = await world("review");
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

it("accepts children that their agents reported complete", async () => {
  const w = await world();
  w.addThread("child", { parentThreadId: "t1", status: "idle" });
  expect(await suggestions(w)).toEqual({});
  await report(w, "child");
  expect(await suggestions(w)).toEqual({ t1: await recapId(w) });
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
  await expect(archive(w)).rejects.toThrow(/current/);
  expect(w.threads.get("t1")!.archivedAt).toBeNull();
});

it("accepts completed structured tasks and goals", async () => {
  const w = await world();
  w.harness.inspection.sdk.stub("threads.timeline", async () => ({
    goal: { status: "complete" },
    pendingTodos: { items: [{ status: "completed" }] },
  }));
  expect(await suggestions(w)).toEqual({ t1: await recapId(w) });
});
