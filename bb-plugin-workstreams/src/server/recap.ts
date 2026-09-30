import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildConversationText, countUserTurns, parseRecap, MAX_RECAP_TRANSCRIPT_CHARS, type RecapInput } from "../domain/recap.ts";
import type { Inference } from "./model.ts";
import type { Database } from "./db.ts";

type Sdk = BbPluginApi["sdk"];
type Recap = { threadId: string; summary: string; generatedAt: number; turns: number; model: string };
const MIN_TURNS = 3;
const QUIET_MS = 30_000;
const WORKER_TIMEOUT_MS = 120_000;

export class RecapScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, AbortController>();
  constructor(private readonly deps: { sdk: () => Sdk; db: Database; model: () => Promise<string>; inference: Inference; triage: (threadId: string) => { state: string; needsYou: string | null } | undefined; onChange: () => void; log: (message: string) => void }) {}
  dispose() { for (const timer of this.timers.values()) clearTimeout(timer); for (const controller of this.running.values()) controller.abort(); }
  get(threadId: string): Recap | null {
    const row = this.deps.db.prepare("SELECT thread_id, summary, generated_at, turns, model FROM ws_recap WHERE thread_id = ?").get(threadId) as { thread_id: string; summary: string; generated_at: number; turns: number; model: string } | undefined;
    return row ? { threadId: row.thread_id, summary: row.summary, generatedAt: row.generated_at, turns: row.turns, model: row.model } : null;
  }
  onActive(threadId: string) { const timer = this.timers.get(threadId); if (timer) clearTimeout(timer); this.timers.delete(threadId); this.running.get(threadId)?.abort(); }
  onIdle(threadId: string) { this.onActive(threadId); this.timers.set(threadId, setTimeout(() => { this.timers.delete(threadId); void this.generate(threadId); }, QUIET_MS)); }
  /** True while a recap for the thread is being generated. */
  generating(threadId: string): boolean { return this.running.has(threadId); }
  /**
   * Generates a fresh recap. `onDemand` skips the minimum-turns threshold,
   * which only exists to keep automatic recaps off trivial threads.
   */
  async generate(threadId: string, options: { onDemand?: boolean } = {}): Promise<Recap | null> {
    this.running.get(threadId)?.abort();
    const controller = new AbortController(); this.running.set(threadId, controller);
    this.deps.onChange();
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
      const turns = countUserTurns(rows, threadId); if (turns < (options.onDemand ? 1 : MIN_TURNS)) return null;
      const transcript = buildConversationText(rows, MAX_RECAP_TRANSCRIPT_CHARS, 0, threadId); if (!transcript) return null;
      const model = await this.deps.model();
      const facts = this.deps.triage(threadId) ?? { state: "in_progress", needsYou: null };
      const input: RecapInput = { transcript, previousRecap: this.get(threadId)?.summary ?? null, state: facts.state, needsYou: facts.needsYou };
      try { const { value } = await this.deps.inference.run("recap", input, { model, signal: controller.signal, label: `Recap ${threadId}`, links: [{ kind: "thread", ref: threadId }] }); const summary = parseRecap(value.summary).summary; if (!summary) return null; const recap = { threadId, summary, generatedAt: Date.now(), turns, model }; this.deps.db.prepare("INSERT INTO ws_recap (thread_id, summary, generated_at, turns, model) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET summary=excluded.summary, generated_at=excluded.generated_at, turns=excluded.turns, model=excluded.model").run(threadId, summary, recap.generatedAt, turns, model); this.deps.onChange(); return recap; }
      finally { /* Inference calls are directly cancelable; no worker thread is created. */ }
    } catch (error) { if (!controller.signal.aborted) this.deps.log(`Recap failed for ${threadId}: ${String(error)}`); return null; }
    finally { if (this.running.get(threadId) === controller) { this.running.delete(threadId); this.deps.onChange(); } }
  }
  async disposeThread(threadId: string) { this.onActive(threadId); this.deps.db.prepare("DELETE FROM ws_recap WHERE thread_id = ?").run(threadId); }
}
