import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeQueueEntry,
} from "@get-bb/plugin-sdk/testing";
import { RECAP_TOOL } from "../../src/domain/recap.ts";
import { fakeWorld } from "./fake-bb.ts";
import plugin from "../../src/server/index.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.harness.lifecycle.dispose();
  vi.useRealTimers();
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
      dismissed: boolean;
      waitingCancelled: boolean;
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

describe("waiting status checks", () => {
  const waiting = {
    state: "waiting",
    goal: "Waiting for tests",
    tasks: ["Test worker"],
    timeout: 10,
  };
  const nudges = (s: Awaited<ReturnType<typeof world>>) =>
    s.w.sent.filter(
      (send) =>
        (send.pluginSubmission as { data?: { waitingRecapId?: string } })?.data
          ?.waitingRecapId,
    );

  it("cancels durably without dismissing the card or rescheduling on idle", async () => {
    const s = await world();
    vi.useFakeTimers();
    s.w.turn("t1");
    await s.report(waiting);
    const { recap } = await s.card();
    await s.w.harness.behavior.callRpc("recap_cancel_waiting", {
      threadId: "t1",
      recapId: recap!.id,
    });
    expect(await s.card()).toMatchObject({
      recap: { id: recap!.id },
      dismissed: false,
      waitingCancelled: true,
    });
    await s.idle();
    const replacement = await s.w.harness.lifecycle.reload(plugin);
    await vi.advanceTimersByTimeAsync(20000);
    expect(nudges(s)).toHaveLength(0);
    expect(
      await replacement.harness.behavior.callRpc("recap_get", {
        threadId: "t1",
      }),
    ).toMatchObject({
      recap: { id: recap!.id },
      dismissed: false,
      waitingCancelled: true,
    });
  });

  it("keeps dismissal independent of cancellation and rejects stale cancel IDs", async () => {
    const s = await world();
    vi.useFakeTimers();
    s.w.turn("t1");
    await s.report(waiting);
    const old = (await s.card()).recap!;
    await s.w.harness.behavior.callRpc("recap_dismiss", {
      threadId: "t1",
      recapId: old.id,
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(nudges(s)).toHaveLength(1);
    await s.report(waiting);
    const current = (await s.card()).recap!;
    await expect(
      s.w.harness.behavior.callRpc("recap_cancel_waiting", {
        threadId: "t1",
        recapId: old.id,
      }),
    ).rejects.toThrow("no longer current");
    expect(await s.card()).toMatchObject({
      recap: { id: current.id },
      dismissed: false,
      waitingCancelled: false,
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(nudges(s)).toHaveLength(2);
    await s.report(RECAP);
    await expect(
      s.w.harness.behavior.callRpc("recap_cancel_waiting", {
        threadId: "t1",
        recapId: (await s.card()).recap!.id,
      }),
    ).rejects.toThrow("no longer current");
  });

  it("cancels while an expired check awaits the thread lookup", async () => {
    const s = await world();
    vi.useFakeTimers();
    s.w.turn("t1");
    await s.report(waiting);
    const { recap } = await s.card();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    s.w.harness.sdk.stub("threads.get", async () => {
      entered();
      await gate;
      return s.thread();
    });
    vi.advanceTimersByTime(10000);
    await lookup;
    await s.w.harness.behavior.callRpc("recap_cancel_waiting", {
      threadId: "t1",
      recapId: recap!.id,
    });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(nudges(s)).toHaveLength(0);
    expect(await s.card()).toMatchObject({
      recap: { id: recap!.id },
      dismissed: false,
      waitingCancelled: true,
    });
  });

  it.each([false, true])(
    "rejects an already submitted check after cancellation (queued: %s)",
    async (queued) => {
      const s = await world();
      vi.useFakeTimers();
      s.w.turn("t1");
      await s.report(waiting);
      await vi.advanceTimersByTimeAsync(10000);
      const send = nudges(s)[0]!;
      const { recap } = await s.card();
      // Pause the dispatch's turn lookup so cancellation wins before its final guard.
      const events = await s.w.bb.sdk.threads.events.list({
        threadId: "t1",
        types: ["turn/started"],
        order: "desc",
        limit: "1",
      });
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lookup = new Promise<void>((resolve) => {
        entered = resolve;
      });
      s.w.harness.sdk.stub("threads.events.list", async () => {
        entered();
        await gate;
        return events;
      });
      const dispatch = s.hook()(
        makeMessageDispatchHookContext({
          thread: s.thread(),
          ...(queued
            ? {
                input: { text: `[Workstreams waiting ${recap!.id}]` },
                queuedMessages: [makeQueueEntry({ id: "q1" })],
              }
            : { experimental_submission: send.pluginSubmission as never }),
        }),
      );
      await lookup;
      await s.w.harness.behavior.callRpc("recap_cancel_waiting", {
        threadId: "t1",
        recapId: recap!.id,
      });
      release();
      expect((await dispatch).action).toBe("reject");
      expect(await s.card()).toMatchObject({
        recap: { id: recap!.id },
        dismissed: false,
        waitingCancelled: true,
      });
    },
  );

  it("nudges once at the deadline and accepts its dispatch", async () => {
    const s = await world();
    vi.useFakeTimers();
    s.w.turn("t1");
    await s.report(waiting);
    await s.idle();
    await vi.advanceTimersByTimeAsync(9999);
    expect(nudges(s)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(nudges(s)).toHaveLength(1);
    await s.idle();
    await vi.advanceTimersByTimeAsync(10000);
    expect(nudges(s)).toHaveLength(1);
    const send = nudges(s)[0]!;
    const result = await s.hook()(
      makeMessageDispatchHookContext({
        thread: s.thread(),
        experimental_submission: send.pluginSubmission as never,
      }),
    );
    expect(result.action).toBe("proceed");
    expect((await s.card()).recap).toBeNull();
  });

  it.each(["input", "turn", "archived", "hidden", "queued", "active"])(
    "suppresses a stale check after %s",
    async (change) => {
      const s = await world();
      vi.useFakeTimers();
      s.w.turn("t1");
      await s.report(waiting);
      if (change === "input") await s.dispatch();
      if (change === "turn") s.w.turn("t1");
      if (change === "archived")
        s.w.threads.set("t1", { ...s.thread(), archivedAt: Date.now() });
      if (change === "hidden")
        s.w.threads.set("t1", { ...s.thread(), visibility: "hidden" });
      if (change === "queued")
        s.w.threads.set("t1", { ...s.thread(), queuedMessageCount: 1 });
      if (change === "active")
        s.w.threads.set("t1", { ...s.thread(), status: "active" });
      await vi.advanceTimersByTimeAsync(10000);
      expect(nudges(s)).toHaveLength(0);
    },
  );

  it("recovers a pending deadline on reload without duplicating a sent check", async () => {
    const s = await world();
    vi.useFakeTimers();
    s.w.turn("t1");
    await s.report(waiting);
    await vi.advanceTimersByTimeAsync(5000);
    const replacement = await s.w.harness.lifecycle.reload(plugin);
    await vi.advanceTimersByTimeAsync(4999);
    expect(nudges(s)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(nudges(s)).toHaveLength(1);
    await replacement.harness.lifecycle.reload(plugin);
    await vi.advanceTimersByTimeAsync(10000);
    expect(nudges(s)).toHaveLength(1);
  });

  it("rejects a check whose submission races a newer turn", async () => {
    const s = await world();
    vi.useFakeTimers();
    s.w.turn("t1");
    await s.report(waiting);
    await vi.advanceTimersByTimeAsync(10000);
    s.w.turn("t1");
    const send = nudges(s)[0]!;
    const result = await s.hook()(
      makeMessageDispatchHookContext({
        thread: s.thread(),
        experimental_submission: send.pluginSubmission as never,
      }),
    );
    expect(result.action).toBe("reject");
  });

  it("rejects a check whose submission races fresh input", async () => {
    const s = await world();
    vi.useFakeTimers();
    s.w.turn("t1");
    await s.report(waiting);
    await vi.advanceTimersByTimeAsync(10000);
    await s.dispatch();
    const send = nudges(s)[0]!;
    const result = await s.hook()(
      makeMessageDispatchHookContext({
        thread: s.thread(),
        experimental_submission: send.pluginSubmission as never,
      }),
    );
    expect(result.action).toBe("reject");
  });
});

describe("agent recaps", () => {
  it("does not send recap corrections while a recovered question awaits an answer", async () => {
    const s = await world();
    s.w.bb.storage
      .database()
      .prepare(
        "INSERT INTO ws_question (id, thread_id, payload, status) VALUES (?, ?, ?, 'pending')",
      )
      .run("question", "t1", "{}");
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(0);
  });
  it("rejects incomplete state-specific input before recording a recap", async () => {
    const s = await world();
    s.w.turn("t1");
    await expect(
      s.report({ state: "complete", goal: "Done" }),
    ).rejects.toThrow();
    await expect(s.report({ ...RECAP, state: "review" })).rejects.toThrow();
    await expect(
      s.report({ state: "continuing", goal: "Working" }),
    ).rejects.toThrow();
    expect((await s.card()).recap).toBeNull();
    await s.report();
    expect((await s.card()).recap?.state).toBe("complete");
  });

  it.each([null, []])(
    "records complete recaps with empty unused fields: %j",
    async (empty) => {
      const s = await world();
      s.w.turn("t1");
      const output = await s.report({
        ...RECAP,
        tasks: empty,
        review: empty,
        links: [],
      });
      await s.idle();
      expect(s.corrections()).toHaveLength(0);
      expect((await s.card()).recap).toMatchObject({
        state: "complete",
        tasks: [],
        review: [],
        links: [],
      });
      expect(output).toContain("**Complete**");
      expect(output).not.toContain("**Review:**");
      expect(output).not.toContain("**Next:**");
    },
  );

  it("stops a live failing-tool loop and suppresses mandatory recap corrections", async () => {
    const s = await world({ corrections: 0 });
    s.w.turn("t1");
    s.w.threads.set("t1", { ...s.thread(), status: "active" });
    let completed = false;
    const events = [
      {
        seq: 1,
        type: "turn/started",
        scope: { kind: "turn", turnId: "t1-t1" },
        data: {},
      },
      ...Array.from({ length: 5 }, (_, i) => ({
        seq: i + 2,
        type: "item/completed",
        scope: { kind: "turn", turnId: "t1-t1" },
        data: {
          item: {
            type: "toolCall",
            tool: RECAP_TOOL,
            status: "failed",
            result: "Invalid arguments: next",
            arguments: { next: ["Verify"] },
          },
        },
      })),
    ];
    s.w.harness.inspection.sdk.stub(
      "threads.events.list",
      async ({ types, afterSeq, order, limit }) => {
        if (completed)
          return [
            {
              seq: 7,
              type: "turn/completed",
              scope: { kind: "turn", turnId: "t1-t1" },
              data: { status: "completed" },
            },
          ];
        let rows = events.filter(
          (e) =>
            (!types || (types as readonly string[]).includes(e.type)) &&
            e.seq > Number(afterSeq ?? 0),
        );
        if (order === "desc") rows = [...rows].reverse();
        return rows.slice(0, Number(limit ?? 100));
      },
    );
    await s.w.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: s.thread(),
      sequence: 6,
    });
    expect(s.w.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
    completed = true;
    s.w.threads.set("t1", { ...s.thread(), status: "idle" });
    expect((await s.card()).capped).toBe(true);
    await s.configure();
    await s.idle();
    expect(s.corrections()).toHaveLength(0);
    expect((await s.card()).capped).toBe(true);
    await s.dispatch();
    await s.configure();
    expect((await s.card()).capped).toBe(false);
  });
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

  it("accepts continuing work without a reminder and clears it on fresh input", async () => {
    const s = await world();
    s.w.turn("t1");
    const output = await s.report({
      ...RECAP,
      state: "waiting",
      latest: [],
      tasks: ["Workers are running"],
      timeout: 60,
    });
    await s.idle();
    expect(s.corrections()).toHaveLength(0);
    expect((await s.card()).recap).toMatchObject({
      state: "waiting",
      tasks: ["Workers are running"],
      review: [],
    });
    expect(output).toContain("**Waiting**");
    await s.dispatch();
    expect((await s.card()).recap).toBeNull();
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
          pluginId: "workstreams",
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
    expect(await s.card()).toMatchObject({
      recap: { id: recap!.id },
      dismissed: true,
      waitingCancelled: false,
    });
    await s.w.harness.behavior.callRpc("recap_restore", {
      threadId: "t1",
      recapId: recap!.id,
    });
    expect(await s.card()).toMatchObject({
      recap: { id: recap!.id },
      dismissed: false,
      waitingCancelled: false,
    });
    await s.w.harness.behavior.callRpc("recap_dismiss", {
      threadId: "t1",
      recapId: recap!.id,
    });
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
    const recapTools = (config: { tools: { name: string }[] }) =>
      config.tools.filter((tool) => tool.name === "WorkstreamsRecap");
    expect(recapTools(side)).toEqual([]);
    s.w.turn("t1");
    await s.idle();
    expect(s.corrections()).toHaveLength(0);

    const off = await world({ required: false });
    expect(recapTools(await off.configure())).toEqual([]);
    off.w.turn("t1");
    await off.idle();
    expect(off.corrections()).toHaveLength(0);
  });
});

describe("next actions", () => {
  it("sends a chosen action as the user's message, queued behind any turn", async () => {
    const s = await world();
    s.w.turn("t1");
    await s.report({ ...RECAP, next: ["Run the full test suite"] });
    const { recap } = await s.card();
    await s.w.harness.behavior.callRpc("recap_send", {
      threadId: "t1",
      recapId: recap!.id,
      action: "Run the full test suite",
    });
    const send = s.w.sent.at(-1)!;
    expect(send.threadId).toBe("t1");
    expect(send.mode).toBe("queue-if-active");
    expect(send.input).toEqual([
      { type: "text", text: "Run the full test suite", mentions: [] },
    ]);
    // The dispatch clears the recap like any fresh user input.
    s.hook()(makeMessageDispatchHookContext({ thread: s.thread() }));
    expect((await s.card()).recap).toBeNull();
  });

  it("rejects a stale recap and an action it no longer offers", async () => {
    const s = await world();
    s.w.turn("t1");
    await s.report({ ...RECAP, next: ["Run the full test suite"] });
    const { recap } = await s.card();
    await expect(
      s.w.harness.behavior.callRpc("recap_send", {
        threadId: "t1",
        recapId: recap!.id,
        action: "Ship it",
      }),
    ).rejects.toThrow();
    await expect(
      s.w.harness.behavior.callRpc("recap_send", {
        threadId: "t1",
        recapId: "stale",
        action: "Run the full test suite",
      }),
    ).rejects.toThrow();
    expect(s.w.sent).toHaveLength(0);
  });
});
