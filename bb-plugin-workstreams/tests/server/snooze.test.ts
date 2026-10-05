import { afterEach, expect, it } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld } from "./fake-bb.ts";

const worlds: Awaited<ReturnType<typeof fakeWorld>>[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.harness.lifecycle.dispose();
});
async function world() {
  const w = await fakeWorld();
  worlds.push(w);
  w.addThread("t1", { latestAttentionAt: 500 });
  w.addThread("t2", { latestAttentionAt: 700 });
  await w.harness.behavior.callRpc("refresh", null);
  return w;
}
type State = {
  snoozes: Record<string, { until: number | null; attentionAt: number }>;
};
const snoozes = async (w: Awaited<ReturnType<typeof world>>) =>
  ((await w.harness.behavior.callRpc("state", null)) as State).snoozes;

it("stores snoozes with the thread's attention at the time", async () => {
  const w = await world();
  const until = Date.now() + 60_000;
  await w.harness.behavior.callRpc("snooze", { threadId: "t1", until });
  await w.harness.behavior.callRpc("snooze", { threadId: "t2", until: null });
  expect(await snoozes(w)).toMatchObject({
    t1: { until, attentionAt: 500 },
    t2: { until: null, attentionAt: 700 },
  });
  expect(
    await w.harness.behavior.callRpc("unsnooze", { threadId: "t1" }),
  ).toEqual({ woke: true });
  expect(Object.keys(await snoozes(w))).toEqual(["t2"]);
});

it("refuses wake times in the past or over a year out", async () => {
  const w = await world();
  for (const until of [Date.now() - 1, Date.now() + 400 * 86_400_000])
    await expect(
      w.harness.behavior.callRpc("snooze", { threadId: "t1", until }),
    ).rejects.toThrow(/next year/);
});

it("wakes a snoozed thread when the user sends it a message", async () => {
  const w = await world();
  await w.harness.behavior.callRpc("snooze", { threadId: "t1", until: null });
  const hook = w.harness.registrations.hooks["message.dispatch"]!;
  await hook(
    makeMessageDispatchHookContext({
      thread: w.threads.get("t1")!,
      initiator: "agent",
      senderThreadId: "t2",
    }),
  );
  expect(Object.keys(await snoozes(w))).toEqual(["t1"]);
  await hook(
    makeMessageDispatchHookContext({
      thread: w.threads.get("t1")!,
      initiator: "user",
      senderThreadId: null,
    }),
  );
  expect(await snoozes(w)).toEqual({});
});

it("sweeps ended snoozes, marking timed ones unread", async () => {
  const w = await world();
  await w.harness.behavior.callRpc("snooze", {
    threadId: "t1",
    until: Date.now() + 30,
  });
  await w.harness.behavior.callRpc("snooze", { threadId: "t2", until: null });
  await new Promise((resolve) => setTimeout(resolve, 40));
  // t2 had new activity; t1's time came.
  w.threads.set("t2", { ...w.threads.get("t2")!, latestAttentionAt: 900 });
  await w.harness.behavior.callRpc("refresh", null);
  expect(await snoozes(w)).toEqual({});
  expect(w.markedUnread).toEqual(["t1"]);
});

it("clears a thread pin and snooze when the thread is archived", async () => {
  const w = await world();
  w.threads.set("t1", {
    ...w.threads.get("t1")!,
    pinnedAt: Date.now(),
  });
  await w.harness.behavior.callRpc("snooze", { threadId: "t1", until: null });
  await w.harness.behavior.emitThreadEvent("thread.archived", {
    thread: { ...w.threads.get("t1")!, archivedAt: Date.now() },
  } as never);
  expect(await snoozes(w)).toEqual({});
  expect(w.threads.get("t1")?.pinnedAt).toBeNull();

  const unarchived = { ...w.threads.get("t1")!, archivedAt: null };
  w.threads.set("t1", unarchived);
  await w.harness.behavior.emitThreadEvent("thread.unarchived", {
    thread: unarchived,
  });
  expect(w.threads.get("t1")?.pinnedAt).toBeNull();
});

it("stores Snooze settings, repairs bad values, and returns them in state", async () => {
  const w = await world();
  const state = async () =>
    (
      (await w.harness.behavior.callRpc("state", null)) as {
        snoozePrefs: unknown;
      }
    ).snoozePrefs;
  expect(await state()).toEqual({
    default: "tomorrow",
    quick: ["1h", "tomorrow", "next-week", "activity"],
    morningHour: 9,
  });
  const { prefs } = (await w.harness.behavior.callRpc("setSnoozePrefs", {
    patch: { default: "3h", quick: ["activity", "30m"], morningHour: 7 },
  })) as { prefs: unknown };
  expect(prefs).toEqual({
    default: "3h",
    quick: ["30m", "activity"],
    morningHour: 7,
  });
  await w.harness.behavior.callRpc("setSnoozePrefs", {
    patch: { morningHour: 11 },
  });
  expect(await state()).toEqual({
    default: "3h",
    quick: ["30m", "activity"],
    morningHour: 11,
  });
  await expect(
    w.harness.behavior.callRpc("setSnoozePrefs", {
      patch: { default: "someday" },
    }),
  ).rejects.toThrow();
});
