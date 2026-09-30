import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { AgentRequest, AgentResponse } from "../../src/domain/learner-protocol.ts";
import { openDatabase } from "../../src/server/db.ts";
import { Notebooks } from "../../src/server/notebooks.ts";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose(); });
type Block = AgentResponse["content"][number];
const text = (value: string): Block => ({ type: "text", text: value });
const call = (id: string, name: string, input: Record<string, never | string | number>): Block => ({ type: "tool_use", id, name, input });
const response = (...content: Block[]): AgentResponse => ({ content, usage: { input: 3, output: 2, cost: 0.001 }, stopReason: content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn" });
const row = (threadId: string, id: string, text: string, seq: number) => ({ kind: "conversation", threadId, id, text, sourceSeqStart: seq, createdAt: seq * 1000, role: "user", initiator: "user" });

async function setup(opts: { transcripts?: Record<string, unknown[]>; search?: unknown; turn?: (request: AgentRequest, index: number) => AgentResponse | Promise<AgentResponse> } = {}) {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  for (const id of ["a", "b", "hidden", "archived"]) threads.set(id, makeThreadResponse({ id, title: `Thread ${id}`, status: "idle", visibility: id === "hidden" ? "hidden" : "visible", archivedAt: id === "archived" ? 1 : null, latestAttentionAt: 10, updatedAt: 10 }));
  const fake = createFakePluginHost({ pluginId: "notebooks-test", sdk: { threads: {
    get: async ({ threadId }: { threadId: string }) => { const t = threads.get(threadId); if (!t) throw new Error("missing"); return t; },
    timeline: async ({ threadId }: { threadId: string }) => ({ rows: opts.transcripts?.[threadId] ?? [], timelinePage: { hasOlderRows: false, olderCursor: null } }),
    search: async () => opts.search ?? { active: { results: [] }, archived: { results: [] } },
  } } as never });
  hosts.push(fake);
  const db = openDatabase(fake.bb);
  let calls = 0;
  const requests: AgentRequest[] = [];
  const learner = new Notebooks({ sdk: () => fake.bb.sdk, db, model: async () => "test-model", onChange: () => {}, log: () => {}, turn: async (request, _signal) => { requests.push(request); return opts.turn ? opts.turn(request, calls++) : response(text("Finished.")); } });
  return { learner, db, threads, requests };
}

describe("native-tool notebook learner", () => {
  it("stages notebook and brief writes, logs narration/tools, then commits cursor and versions together", async () => {
    const w = await setup({ transcripts: { a: [row("a", "m1", "I am moving to Denver for a new role.", 1)] }, turn: (_req, i) => i === 0 ? response(text("The move sounds durable."), call("1", "write_notebook", { text: "## Current\\nMoving to Denver for a new role. [a]" }), call("2", "write_brief", { text: "The user is relocating to Denver." })) : response(text("Updated the notes.")) });
    await w.learner.observe("a");
    expect(w.learner.get("a")).toMatchObject({ text: expect.stringContaining("Denver"), cursor: "m1#0", revision: 10, error: null });
    expect(w.learner.context()).toContain("relocating");
    expect(w.learner.versions("a")).toHaveLength(1);
    expect(w.learner.versions(null)).toHaveLength(1);
    const run = w.learner.overview().runs[0]!;
    expect(run.steps.map(s => s.tool)).toEqual(["learner", "write_notebook", "write_brief", "learner"]);
    expect(run.status).toBe("done");
    expect(w.requests[1]!.messages.flatMap(m => m.content)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_result", tool_use_id: "1" }), expect.objectContaining({ type: "tool_result", tool_use_id: "2" })]));
  });

  it("keeps writes and cursor uncommitted when a later native model round fails", async () => {
    const w = await setup({ transcripts: { a: [row("a", "m1", "A durable fact.", 1)] }, turn: (_req, i) => { if (i === 0) return response(call("1", "write_notebook", { text: "staged but not saved" })); throw new Error("provider failed"); } });
    await expect(w.learner.observe("a")).rejects.toThrow("provider failed");
    expect(w.learner.get("a")).toMatchObject({ text: "", cursor: null, revision: null, error: expect.stringContaining("provider failed") });
    expect(w.learner.versions("a")).toEqual([]);
    expect(w.learner.overview().runs[0]!.status).toBe("failed");
  });

  it("bounds each chronological pass and leaves remaining transcript for the next run", async () => {
    let learned: string[] = [];
    const transcript = Array.from({ length: 5 }, (_, i) => row("a", `m${i}`, `Message-${i}-${"x".repeat(7990)}`, i + 1));
    const w = await setup({ transcripts: { a: transcript }, turn: (req) => { const chunk = req.messages[0]!.content[0]!; if (chunk.type === "text") learned.push(...[...chunk.text.matchAll(/Message-\d/g)].map(m => m[0]!)); return response(text("No further updates.")); } });
    await w.learner.observe("a");
    const firstCursor = w.learner.get("a")!.cursor;
    expect(firstCursor).toBe("m2#0");
    expect(w.learner.needsObservation("a", 10)).toBe(true);
    await w.learner.observe("a");
    expect(w.learner.get("a")!.cursor).toBe("m4#0");
    expect(w.learner.needsObservation("a", 10)).toBe(false);
    expect(learned.join(" ")).toContain("Message-0");
    expect(learned.join(" ")).toContain("Message-4");
  });

  it("explores visible cross-thread sources in ask mode without allowing writes", async () => {
    const searchResult = { active: { results: [{ thread: makeThreadResponse({ id: "b", title: "Other", visibility: "visible", archivedAt: null }), matches: [{ text: "The user prefers remote work.", sourceKind: "user_message", sourceSeq: 1 }] }, { thread: makeThreadResponse({ id: "hidden", visibility: "hidden", archivedAt: null }), matches: [{ text: "secret", sourceKind: "user_message", sourceSeq: 2 }] }] }, archived: { results: [{ thread: makeThreadResponse({ id: "archived", archivedAt: 1 }), matches: [] }] } };
    const w = await setup({ search: searchResult, turn: (req, i) => i === 0 ? response(call("s", "search_threads", { query: "work" }), call("w", "write_brief", { text: "forbidden" })) : response(text("The user prefers remote work.")) });
    const run = await w.learner.ask("What work arrangement does the user prefer?");
    expect(run.status).toBe("done"); expect(run.summary).toContain("remote work");
    expect(w.learner.context()).toBe("");
    expect(run.steps.find(s => s.tool === "search_threads")!.output).toContain('"b"');
    expect(run.steps.find(s => s.tool === "search_threads")!.output).not.toContain("secret");
  });

  it("forgets a source and every dependent notebook, brief, version, and run", async () => {
    const searchResult = { active: { results: [{ thread: makeThreadResponse({ id: "b", title: "Other", visibility: "visible", archivedAt: null }), matches: [{ text: "Relevant source.", sourceKind: "user_message", sourceSeq: 1 }] }] }, archived: { results: [] } };
    const w = await setup({ transcripts: { a: [row("a", "m1", "Current note.", 1)] }, search: searchResult, turn: (_req, i) => i === 0 ? response(call("s", "search_threads", { query: "relevant" }), call("n", "write_notebook", { text: "Note informed by source b." }), call("b", "write_brief", { text: "Shared fact from b." })) : response(text("Done.")) });
    await w.learner.observe("a");
    expect(w.learner.get("a")?.text).toContain("source b");
    await w.learner.forget("b");
    expect(w.learner.get("a")).toBeNull(); expect(w.learner.context()).toBe("");
    expect(w.learner.versions("a")).toEqual([]); expect(w.learner.overview().runs).toEqual([]);
  });

  it("aborts in-flight work on source deletion without allowing staged resurrection", async () => {
    let release!: (value: AgentResponse) => void;
    const waiting = new Promise<AgentResponse>(resolve => { release = resolve; });
    const w = await setup({ transcripts: { a: [row("a", "m1", "Source content", 1)] }, turn: async () => waiting });
    const pending = w.learner.observe("a");
    await new Promise(resolve => setTimeout(resolve, 0));
    await w.learner.forget("a");
    release(response(call("write", "write_notebook", { text: "must not return" })));
    await pending;
    expect(w.learner.get("a")).toBeNull(); expect(w.learner.overview().runs).toEqual([]);
  });
});
