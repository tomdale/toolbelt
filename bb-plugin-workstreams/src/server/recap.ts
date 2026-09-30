import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildConversationText, countUserTurns, cleanRecapText, buildRecapPrompt, DEFAULT_RECAP_PROMPT, MAX_TRANSCRIPT_CHARS } from "../domain/recap.ts";
import type { Database } from "./db.ts";

type Sdk = BbPluginApi["sdk"];
type Recap = { threadId: string; summary: string; generatedAt: number; turns: number; model: string };
const MIN_TURNS = 3;
const QUIET_MS = 30_000;
const WORKER_TIMEOUT_MS = 120_000;

export class RecapScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, AbortController>();
  constructor(private readonly deps: { sdk: () => Sdk; db: Database; model: () => Promise<string>; onChange: () => void; log: (message: string) => void }) {}
  dispose() { for (const timer of this.timers.values()) clearTimeout(timer); for (const controller of this.running.values()) controller.abort(); }
  get(threadId: string): Recap | null {
    const row = this.deps.db.prepare("SELECT thread_id, summary, generated_at, turns, model FROM ws_recap WHERE thread_id = ?").get(threadId) as { thread_id: string; summary: string; generated_at: number; turns: number; model: string } | undefined;
    return row ? { threadId: row.thread_id, summary: row.summary, generatedAt: row.generated_at, turns: row.turns, model: row.model } : null;
  }
  onActive(threadId: string) { const timer = this.timers.get(threadId); if (timer) clearTimeout(timer); this.timers.delete(threadId); this.running.get(threadId)?.abort(); }
  onIdle(threadId: string) { this.onActive(threadId); this.timers.set(threadId, setTimeout(() => { this.timers.delete(threadId); void this.generate(threadId); }, QUIET_MS)); }
  async generate(threadId: string): Promise<Recap | null> {
    this.running.get(threadId)?.abort();
    const controller = new AbortController(); this.running.set(threadId, controller);
    try {
      const thread = await this.deps.sdk().threads.get({ threadId, signal: controller.signal });
      if (thread.status !== "idle" || thread.visibility === "hidden" || thread.archivedAt !== null) return null;
      const rows: unknown[] = []; let before: { id: string; seq: number } | undefined;
      for (let page = 0; page < 60; page++) {
        const response = await this.deps.sdk().threads.timeline({ threadId, includeNestedRows: "true", ...(before ? { beforeAnchorId: before.id, beforeAnchorSeq: String(before.seq) } : {}), signal: controller.signal });
        rows.unshift(...response.rows);
        if (!response.timelinePage.hasOlderRows || !response.timelinePage.olderCursor) break;
        before = { id: response.timelinePage.olderCursor.anchorId, seq: response.timelinePage.olderCursor.anchorSeq };
      }
      const turns = countUserTurns(rows, threadId); if (turns < MIN_TURNS) return null;
      const transcript = buildConversationText(rows, MAX_TRANSCRIPT_CHARS, 0, threadId); if (!transcript) return null;
      const model = await this.deps.model();
      const worker = await this.deps.sdk().threads.spawn({ projectId: thread.projectId, environment: thread.environmentId ? { type: "reuse", environmentId: thread.environmentId } : { type: "project-default" }, providerId: thread.providerId, model, reasoningLevel: "high", permissionMode: "accept-edits", title: "Workstreams recap worker", visibility: "hidden", prompt: buildRecapPrompt(DEFAULT_RECAP_PROMPT, transcript, this.get(threadId)?.summary, thread.title ?? undefined) });
      try { await this.deps.sdk().threads.wait({ threadId: worker.id, status: "idle", timeoutMs: WORKER_TIMEOUT_MS, signal: controller.signal }); const raw = (await this.deps.sdk().threads.output({ threadId: worker.id, signal: controller.signal })).output ?? ""; const summary = cleanRecapText(raw); if (!summary) return null; const recap = { threadId, summary, generatedAt: Date.now(), turns, model }; this.deps.db.prepare("INSERT INTO ws_recap (thread_id, summary, generated_at, turns, model) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET summary=excluded.summary, generated_at=excluded.generated_at, turns=excluded.turns, model=excluded.model").run(threadId, summary, recap.generatedAt, turns, model); this.deps.onChange(); return recap; }
      finally { await this.deps.sdk().threads.archive({ threadId: worker.id }).catch(() => {}); await this.deps.sdk().threads.stop({ threadId: worker.id }).catch(() => {}); }
    } catch (error) { if (!controller.signal.aborted) this.deps.log(`Recap failed for ${threadId}: ${String(error)}`); return null; }
    finally { if (this.running.get(threadId) === controller) this.running.delete(threadId); }
  }
  async disposeThread(threadId: string) { this.onActive(threadId); this.deps.db.prepare("DELETE FROM ws_recap WHERE thread_id = ?").run(threadId); }
}
