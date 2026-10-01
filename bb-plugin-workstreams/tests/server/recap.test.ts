import { afterEach, describe, expect, it } from "vitest";
import {
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeQueueEntry,
} from "@get-bb/plugin-sdk/testing";
import { RECAP_TOOL } from "../../src/domain/recap.ts";
import { fakeWorld } from "./fake-bb.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.harness.lifecycle.dispose();
});

const RECAP = {
  state: "complete",
  goal: "Porting handoffs into Workstreams",
  latest: ["Moved the recap tool into Workstreams."],
};

async function world(
  prefs: Record<string, unknown> = {},
  createdAt = Date.now() + 1_000,
) {
  const w = await fakeWorld();
  worlds.push(w);
  w.addThread("t1", { status: "idle", queuedMessageCount: 0, createdAt });
  if (Object.keys(prefs).length)
    await w.harness.behavior.callRpc("setRecapPrefs", { patch: prefs });
  const configure = (origin?: { kind: "fork"; pluginId: string }) =>
    w.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "t1", parentThreadId: null },
        ...(origin ? { origin } : {}),
      }),
    );
  await configure();
  const thread = () => w.threads.get("t1")!;
  const hook = () =>
    w.harness.inspection.registrations.hooks["message.dispatch"]!;
  /** The user sends a fresh message. */
  const dispatch = () =>
    hook()(makeMessageDispatchHookContext({ thread: thread() }));
  const idle = () =>
    w.harness.behavior.emitThreadEvent("thread.idle", {
      thread: thread(),
      lastAssistantText: "Done.",
    });
  const report = (input: Record<string, unknown> = RECAP) =>
    w.harness.behavior.callAgentTool(RECAP_TOOL, input, { threadId: "t1" });
  const card = () =>
    w.harness.behavior.callRpc("recap_get", { threadId: "t1" }) as Promise<{
      recap: { id: string; state: string; latest: string[] } | null;
      capped: boolean;
      corrections: number;
    }>;
  const corrections = () =>
    w.sent.filter(
      (send) =>
        (send.pluginSubmission as { data?: { recapCorrection?: unknown } })
          ?.data?.recapCorrection,
    );
  return {
    w,
    thread,
    hook,
    dispatch,
    idle,
    report,
    card,
    corrections,
    configure,
  };
}

describe("agent recaps", () => {
  it("shows the agent's recap for its turn and asks for nothing more", async () => {
    const s = await world();
    s.w.turn("t1");
    await s.report({
      ...RECAP,
      latest: ["Moved the recap tool into Workstreams."],
    });
    await s.idle();
    expect(s.corrections()).toHaveLength(0);
    expect(await s.card()).toMatchObject({
      recap: {
        state: "complete",
        // The closing period is dropped.
        latest: ["Moved the recap tool into Workstreams"],
      },
    });
    const state = (await s.w.harness.behavior.callRpc("state", null)) as {
      recaps: Record<string, unknown>;
    };
    expect(state.recaps.t1).toMatchObject({ state: "complete" });
  });

  it("requires review steps for review, and real link locations", async () => {
    const s = await world();
    s.w.turn("t1");
    await expect(s.report({ ...RECAP, state: "review" })).rejects.toThrow();
    await expect(
      s.report({
        ...RECAP,
        links: [{ title: "Report", location: "javascript:alert(1)" }],
      }),
    ).rejects.toThrow();
    await expect(
      s.report({
        ...RECAP,
        links: [{ title: "Report", location: "/tmp/report.md" }],
      }),
    ).rejects.toThrow("Links are review targets");
    await expect(s.report({ ...RECAP, latest: [] })).rejects.toThrow();
    await expect(
      s.report({ ...RECAP, state: "review", review: [] }),
    ).rejects.toThrow();
    const output = await s.report({
      ...RECAP,
      state: "review",
      review: ["Read the report.", "Check that each finding has evidence"],
      links: [{ title: "Report", location: "/tmp/report.md" }],
    });
    expect((await s.card()).recap).toMatchObject({
      state: "review",
      review: ["Read the report", "Check that each finding has evidence"],
    });
    // The call's output is the recap the timeline row keeps.
    expect(output).toBe(
      [
        "**Ready for review** · Porting handoffs into Workstreams",
        "- Moved the recap tool into Workstreams",
        "",
        "**Review:**",
        "- Read the report",
        "- Check that each finding has evidence",
        "",
        "[Report](/tmp/report.md)",
      ].join("\n"),
    );
    // A single step may come as a string, and reads as one line.
    const single = await s.report({
      ...RECAP,
      state: "review",
      review: "Open the sidebar",
    });
    expect((await s.card()).recap).toMatchObject({
      review: ["Open the sidebar"],
    });
    expect(single).toContain("**Review:** Open the sidebar");
    // A list sent as a JSON-encoded string still reads as steps.
    await s.report({
      ...RECAP,
      state: "review",
      review: JSON.stringify(["Open the sidebar", "Check the mark"]),
    });
    expect((await s.card()).recap).toMatchObject({
      review: ["Open the sidebar", "Check the mark"],
    });
    await expect(
      s.report({ ...RECAP, state: "review", review: "x".repeat(161) }),
    ).rejects.toThrow();
  });

  it("asks for a missing recap, caps the reminders, and resets on fresh input", async () => {
    const s = await world({ corrections: 2 });
    s.w.turn("t1");
    await s.idle();
    await s.idle();
    expect(s.corrections()).toHaveLength(1);
    expect(s.corrections()[0]).toMatchObject({
      input: [{ visibility: "agent-only" }],
    });
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(2);
    expect((await s.card()).capped).toBe(false);
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(2);
    expect(await s.card()).toMatchObject({ capped: true, corrections: 2 });
    await s.dispatch();
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(3);
  });

  it("reminds an older thread only once its agent has used the tool", async () => {
    // Created before the tool existed: its live session may lack it.
    const s = await world({}, 1);
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(0);
    // A recap call proves this session has the tool.
    s.w.turn("t1");
    await s.report();
    await s.dispatch();
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(1);
  });

  it("dates a fork's session from the thread its fork chain started from", async () => {
    const s = await world();
    // Created before the tool existed; its fork carries on that session.
    s.w.addThread("old", { createdAt: 1 });
    s.w.addThread("mid", {
      createdAt: Date.now() + 1_000,
      originKind: "fork",
      sourceThreadId: "old",
    });
    s.w.threads.set("t1", {
      ...s.thread(),
      originKind: "fork",
      sourceThreadId: "mid",
    });
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(0);

    // A fork whose chain starts after the tool existed has it.
    s.w.threads.set("old", {
      ...s.w.threads.get("old")!,
      createdAt: Date.now() + 1_000,
    });
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(1);
  });

  it("doesn't remind a fork whose source can't be read", async () => {
    const s = await world();
    s.w.threads.set("t1", {
      ...s.thread(),
      originKind: "fork",
      sourceThreadId: "gone",
    });
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(0);
  });

  it("restarts the clock when recaps are turned back on", async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const s = await world();
    // Created after the first load, but before recaps come back on.
    await tick();
    s.w.threads.set("t1", { ...s.thread(), createdAt: Date.now() });
    await tick();
    await s.w.harness.behavior.callRpc("setRecapPrefs", {
      patch: { required: false },
    });
    await s.w.harness.behavior.callRpc("setRecapPrefs", {
      patch: { required: true },
    });
    await s.configure();
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(0);
  });

  it("counts an open question card, even one without a turn of its own", async () => {
    const s = await world();
    s.w.turn("t1");
    await s.w.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: s.thread(),
      interaction: {
        id: "i1",
        threadId: "t1",
        turnId: null,
        status: "pending",
        payload: { kind: "plugin" },
        origin: {
          kind: "plugin",
          pluginId: "toolbelt-ask-user-question",
          rendererId: "ask-user-question",
        },
      } as never,
    });
    await s.idle();
    expect(s.corrections()).toHaveLength(0);
    expect((await s.card()).recap).toBeNull();
  });

  it("proceeds with a current reminder and rejects one that fresh input overtook", async () => {
    const s = await world();
    s.w.turn("t1");
    await s.idle();
    const sent = s.corrections()[0]!;
    const reminder = () =>
      s.hook()(
        makeMessageDispatchHookContext({
          thread: s.thread(),
          experimental_submission: sent.pluginSubmission as never,
        }),
      );
    expect(await reminder()).toEqual({ action: "proceed" });
    await s.dispatch();
    expect(await reminder()).toMatchObject({ action: "reject" });
  });

  it("recognizes a queued reminder by its marker after its metadata is lost", async () => {
    const s = await world({ corrections: 1 });
    s.w.turn("t1");
    await s.idle();
    const text = (s.corrections()[0]!.input as { text: string }[])[0]!.text;
    const queued = makeMessageDispatchHookContext({
      thread: { ...s.thread(), queuedMessageCount: 1 },
      input: { text },
      queuedMessages: [makeQueueEntry({ id: "queued-reminder" })],
      experimental_submission: null,
    });
    expect(await s.hook()(queued)).toEqual({ action: "proceed" });
    s.w.turn("t1");
    await s.idle();
    expect(await s.card()).toMatchObject({ capped: true, corrections: 1 });
  });

  it("clears the recap on fresh input; dismissing hides only the card", async () => {
    const s = await world();
    s.w.turn("t1");
    await s.report();
    const { recap } = await s.card();
    await s.w.harness.behavior.callRpc("recap_dismiss", {
      threadId: "t1",
      recapId: recap!.id,
    });
    expect((await s.card()).recap).toBeNull();
    const state = (await s.w.harness.behavior.callRpc("state", null)) as {
      recaps: Record<string, unknown>;
    };
    expect(state.recaps.t1).toBeDefined();
    await s.dispatch();
    const after = (await s.w.harness.behavior.callRpc("state", null)) as {
      recaps: Record<string, unknown>;
    };
    expect(after.recaps.t1).toBeUndefined();
  });

  it.each(["failed", "interrupted"])(
    "doesn't remind after %s turns",
    async (status) => {
      const s = await world();
      s.w.turn("t1", status);
      await s.idle();
      expect(s.corrections()).toHaveLength(0);
    },
  );

  it.each([
    { visibility: "hidden" },
    { status: "active" },
    { queuedMessageCount: 1 },
  ])("doesn't remind a thread that is %j", async (patch) => {
    const s = await world();
    s.w.threads.set("t1", { ...s.thread(), ...patch } as never);
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(0);
  });

  it("leaves side chats, and every thread when recaps are off, without the tool or reminders", async () => {
    const s = await world();
    const side = await s.configure({ kind: "fork", pluginId: "side-chat" });
    expect(side.tools).toEqual([]);
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(0);

    const off = await world({ required: false });
    expect((await off.configure()).tools).toEqual([]);
    off.w.turn("t1");
    await off.idle();
    expect(off.corrections()).toHaveLength(0);
  });
});
