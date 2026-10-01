import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, experimental_scanPublicSdkOnly, makeMessageDispatchHookContext, makeQueueEntry, makePluginAgentConfigurationContext, makeThreadResponse, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { TOOLS } from "./contracts";

const hosts: FakePluginHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((h) => h.harness.lifecycle.dispose())); });

async function setup(settings: Record<string, boolean | number> = {}) {
  let turn = 1;
  let status = "completed";
  let thread = makeThreadResponse({ id: "thr_bottom", status: "idle", visibility: "visible" });
  let beforeSend: (() => Promise<void>) | null = null;
  const sends: unknown[] = [];
  const decisions: unknown[] = [];
  const host = createFakePluginHost({
    pluginId: "bottom-line", agentSkillIds: ["bottom-line"], settings,
    sdk: { threads: {
      get: async () => thread,
      archive: async () => { thread = { ...thread, archivedAt: 1 }; return { ok: true }; },
      events: { list: async (args) => {
        const completed = args.types?.includes("turn/completed");
        return [{ id: `e${turn}`, threadId: thread.id, seq: turn * 10 + (completed ? 2 : 1), scope: { kind: "turn", turnId: `t${turn}` }, type: completed ? "turn/completed" : "turn/started", data: completed ? { status, providerThreadId: "provider", threadId: thread.id } : { providerThreadId: "provider", threadId: thread.id }, createdAt: 0 }] as never;
      } },
      send: async (args) => {
        if (beforeSend) await beforeSend();
        const decision = await host.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread, experimental_submission: args.pluginSubmission ?? null }));
        decisions.push(decision);
        if (decision.action !== "proceed") throw new Error("Correction rejected");
        sends.push(args);
        return { delivery: "sent" } as never;
      },
    } },
  });
  hosts.push(host);
  await plugin(host.bb);
  await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: thread.id } }));
  const dispatch = async () => host.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread }));
  const idle = async () => host.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Done" });
  const snapshot = async () => host.harness.behavior.callRpc("current", { threadId: thread.id }) as Promise<{ card: { id: string; kind: string } | null; capped: boolean; intercepts: number }>;
  return { host, sends, decisions, dispatch, idle, snapshot, next: () => { turn++; }, setStatus: (value: string) => { status = value; }, setThread: (value: Partial<typeof thread>) => { thread = { ...thread, ...value }; }, race: (f: () => Promise<void>) => { beforeSend = f; }, threadId: thread.id, turnId: () => `t${turn}` };
}

describe("handoff enforcement", () => {
  it("accepts CLI completion for sessions without injected tools, leaving archive to the user", async () => {
    const s = await setup();
    const result = await s.host.harness.behavior.runCli(["finish", "--summary", "Installed and verified."], { threadId: s.threadId });
    expect(result.exitCode).toBe(0);
    expect(await s.snapshot()).toMatchObject({ card: { kind: "finished", summary: "Installed and verified.", deliverables: [] } });
    expect(await s.host.bb.sdk.threads.get({ threadId: s.threadId })).toMatchObject({ archivedAt: null });
    await s.idle();
    expect(s.sends).toHaveLength(0);
    await s.dispatch(); s.next(); await s.idle();
    expect(s.sends).toHaveLength(1);
  });
  it("requires a thread and validates CLI summaries before accepting a handoff", async () => {
    const s = await setup();
    expect((await s.host.harness.behavior.runCli(["finish", "--summary", "Done"])).exitCode).toBe(1);
    expect((await s.host.harness.behavior.runCli(["finish", "--thread", s.threadId, "--summary", "   "])).exitCode).toBe(1);
    expect((await s.snapshot()).card).toBeNull();
    expect((await s.host.harness.behavior.runCli(["finish", "--thread", s.threadId, "--summary", "Done"])).exitCode).toBe(0);
  });
  it("caps a correction chain, deduplicates idle events, and resets on fresh input", async () => {
    const s = await setup({ maxIntercepts: 2 });
    await s.idle(); await s.idle();
    expect(s.sends).toHaveLength(1);
    s.next(); await s.idle();
    expect(s.sends).toHaveLength(2);
    expect((await s.snapshot()).capped).toBe(false);
    s.next(); await s.idle(); await s.idle();
    expect(s.sends).toHaveLength(2);
    expect(await s.snapshot()).toMatchObject({ capped: true, intercepts: 2 });
    await s.dispatch(); s.next(); await s.idle();
    expect(s.sends).toHaveLength(3);
    expect(s.sends[0]).toMatchObject({ input: [{ visibility: "agent-only" }], pluginSubmission: { pluginId: "bottom-line" } });
  });
  it("preserves the budget across plugin reloads", async () => {
    const s = await setup({ maxIntercepts: 1 });
    await s.idle();
    const replacement = await s.host.harness.lifecycle.reload(plugin);
    hosts.push(replacement);
    // Reload's fake SDK still calls the same sender closure; a cap prevents any new send.
    s.next();
    await replacement.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: s.threadId }), lastAssistantText: "Done" });
    expect(s.sends).toHaveLength(1);
    expect(await replacement.harness.behavior.callRpc("current", { threadId: s.threadId })).toMatchObject({ capped: true, intercepts: 1 });
  });
  it.each(["failed", "interrupted"])("does not restart %s turns", async (status) => {
    const s = await setup(); s.setStatus(status); await s.idle(); expect(s.sends).toHaveLength(0);
  });
  it("skips hidden workers, busy threads, and queued user input", async () => {
    const s = await setup(); s.setThread({ visibility: "hidden" }); await s.idle();
    s.setThread({ visibility: "visible", status: "active" }); await s.idle();
    s.setThread({ status: "idle", queuedMessageCount: 1 }); await s.idle();
    expect(s.sends).toHaveLength(0);
  });
  it("applies settings changes and validates the correction cap", async () => {
    const s = await setup();
    await expect(s.host.harness.behavior.setSettings({ maxIntercepts: 1.5 })).rejects.toThrow();
    await s.host.harness.behavior.setSettings({ maxIntercepts: 0 }); await s.idle();
    await s.host.harness.behavior.setSettings({ maxIntercepts: 1 }); await s.idle();
    expect(s.sends).toHaveLength(1);
    s.next(); await s.host.harness.behavior.setSettings({ enabled: false }); await s.idle();
    expect(s.sends).toHaveLength(1);
  });
  it("rejects a correction if a fresh user message wins the dispatch race", async () => {
    const s = await setup(); s.race(async () => { await s.dispatch(); });
    await s.idle();
    expect(s.sends).toHaveLength(0);
    expect(s.decisions).toEqual([{ action: "reject", message: expect.stringContaining("conversation changed") }]);
  });
  it("preserves the budget when a correction is queued and its submission metadata is lost", async () => {
    const s = await setup({ maxIntercepts: 1 }); await s.idle();
    const sent = s.sends[0] as { input: [{ text: string }] };
    const hook = s.host.harness.inspection.registrations.hooks["message.dispatch"]!;
    const context = makeMessageDispatchHookContext({ thread: { id: s.threadId, status: "idle", queuedMessageCount: 1 }, input: { text: sent.input[0].text }, queuedMessages: [makeQueueEntry({ id: "queued-correction" })], experimental_submission: null });
    expect(await hook(context)).toEqual({ action: "proceed" });
    expect(await hook(context)).toEqual({ action: "proceed" });
    s.next(); await s.idle(); expect(s.sends).toHaveLength(1);
    expect(await s.snapshot()).toMatchObject({ capped: true, intercepts: 1 });
    await s.dispatch();
    expect(await hook(context)).toMatchObject({ action: "reject" });
  });
  it("excludes side chats from tool selection and enforcement", async () => {
    const s = await setup();
    const resolved = await s.host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: s.threadId }, origin: { kind: "fork", pluginId: "side-chat" } }));
    expect(resolved.tools).toEqual([]); await s.idle(); expect(s.sends).toHaveLength(0);
  });
});

describe("handoff tools and cards", () => {
  it("counts only a handoff in the completed turn", async () => {
    const s = await setup();
    await s.host.harness.behavior.callAgentTool(TOOLS[2], { summary: "All requested work is complete." }, { threadId: s.threadId });
    await s.idle(); expect(s.sends).toHaveLength(0);
    expect(await s.snapshot()).toMatchObject({ card: { kind: "finished" } });
    s.next(); await s.idle(); expect(s.sends).toHaveLength(1);
  });
  it("requires requested artifact locations and clears the card on fresh input", async () => {
    const s = await setup();
    await expect(s.host.harness.behavior.callAgentTool(TOOLS[1], { summary: "Report ready", deliverables: [] })).rejects.toThrow();
    await expect(s.host.harness.behavior.callAgentTool(TOOLS[1], { summary: "Report ready", deliverables: [{ title: "Report", location: "javascript:alert(1)" }] })).rejects.toThrow();
    await s.host.harness.behavior.callAgentTool(TOOLS[1], { summary: "Report ready", deliverables: [{ title: "Report", location: "/tmp/report.md" }] }, { threadId: s.threadId });
    await s.idle(); expect(s.sends).toHaveLength(0);
    await s.dispatch(); expect((await s.snapshot()).card).toBeNull();
  });
  it("archives only the current finished card, after a user action", async () => {
    const s = await setup();
    await s.host.harness.behavior.callAgentTool(TOOLS[2], { summary: "Completed." }, { threadId: s.threadId });
    expect(s.host.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    const card = (await s.snapshot()).card!;
    s.setThread({ status: "active" });
    await expect(s.host.harness.behavior.callRpc("archive", { threadId: s.threadId, cardId: card.id })).rejects.toThrow("Wait for");
    s.setThread({ status: "idle" });
    await expect(s.host.harness.behavior.callRpc("archive", { threadId: s.threadId, cardId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow("no longer current");
    await s.host.harness.behavior.callRpc("archive", { threadId: s.threadId, cardId: card.id });
    expect(s.host.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
  });
  it("dismisses without archiving or accepting a later turn", async () => {
    const s = await setup();
    await s.host.harness.behavior.callAgentTool(TOOLS[2], { summary: "Completed." }, { threadId: s.threadId });
    const card = (await s.snapshot()).card!;
    await s.host.harness.behavior.callRpc("dismiss", { threadId: s.threadId, cardId: card.id });
    await s.idle(); expect(s.sends).toHaveLength(0);
    expect((await s.snapshot()).card).toBeNull();
    expect(s.host.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  });
  it("counts native and toolbelt question cards using their own turn id", async () => {
    for (const payload of [
      { kind: "user_question", questions: [] },
      { kind: "plugin", data: {}, title: "Question" },
    ]) {
      const s = await setup();
      const interaction = { id: "interaction", threadId: s.threadId, turnId: s.turnId(), status: "pending", payload, origin: payload.kind === "plugin" ? { kind: "plugin", pluginId: "toolbelt-ask-user-question", rendererId: "ask-user-question" } : undefined };
      await s.host.harness.behavior.emitThreadEvent("interaction.pending", { thread: makeThreadResponse({ id: s.threadId }), interaction: interaction as never });
      await s.idle(); expect(s.sends).toHaveLength(0);
    }
  });
  it("counts Bottom Line's pending questions and preserves cancellation as unresolved input", async () => {
    const s = await setup();
    const work = s.host.harness.behavior.callAgentTool(TOOLS[0], { questions: [{ question: "Deploy this build?", options: [] }] }, { threadId: s.threadId });
    const interaction = s.host.harness.inspection.pendingInteractions[0]!;
    await s.host.harness.behavior.emitThreadEvent("interaction.pending", { thread: makeThreadResponse({ id: s.threadId }), interaction: { turnId: s.turnId(), payload: { kind: "plugin" }, origin: { kind: "plugin", pluginId: "bottom-line", rendererId: "bottom-line-questions" } } as never });
    await s.idle(); expect(s.sends).toHaveLength(0);
    s.host.harness.behavior.cancelInteraction(interaction.id);
    expect(await work).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("No answer or approval") }] });
  });
  it("uses only public SDK imports", () => {
    const result = experimental_scanPublicSdkOnly(import.meta.dirname, { allow: [/^react$/, /^@testing-library\/react$/, /^@radix-ui\/react-slot$/, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/] });
    expect(result.violations).toEqual([]); expect(result.privateDependencies).toEqual([]);
  });
});
