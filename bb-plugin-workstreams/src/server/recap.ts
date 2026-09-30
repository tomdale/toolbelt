import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  buildConversationText,
  countUserTurns,
  parseRecap,
  MAX_RECAP_TRANSCRIPT_CHARS,
  type RecapInput,
} from "../domain/recap.ts";
import type { Inference } from "./model.ts";
import type { Database } from "./db.ts";

type Sdk = BbPluginApi["sdk"];
type Thread = Awaited<ReturnType<Sdk["threads"]["get"]>>;
type Recap = {
  threadId: string;
  summary: string;
  generatedAt: number;
  turns: number;
  model: string;
  revision: number | null;
};
const revisionOf = (thread: Thread) =>
  thread.latestAttentionAt ?? thread.updatedAt;
const readable = (thread: Thread) =>
  thread.status === "idle" &&
  thread.visibility !== "hidden" &&
  thread.archivedAt === null;

export class RecapScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, AbortController>();
  private readonly deleted = new Set<string>();
  private disposed = false;
  constructor(
    private readonly deps: {
      sdk: () => Sdk;
      db: Database;
      model: () => Promise<string>;
      inference: Inference;
      triage: (
        threadId: string,
      ) => { state: string; needsYou: string | null } | undefined;
      prefs: () => { quietSeconds: number; minTurns: number };
      onChange: () => void;
      log: (message: string) => void;
    },
  ) {}

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.running.values()) controller.abort();
  }
  get(threadId: string): Recap | null {
    const row = this.deps.db
      .prepare(
        "SELECT thread_id,summary,generated_at,turns,model,revision FROM ws_recap WHERE thread_id=?",
      )
      .get(threadId) as
      | {
          thread_id: string;
          summary: string;
          generated_at: number;
          turns: number;
          model: string;
          revision: number | null;
        }
      | undefined;
    return row
      ? {
          threadId: row.thread_id,
          summary: row.summary,
          generatedAt: row.generated_at,
          turns: row.turns,
          model: row.model,
          revision: row.revision,
        }
      : null;
  }
  /** Old recaps without a revision are stale; reads never fetch a transcript. */
  async getFresh(threadId: string): Promise<Recap | null> {
    if (this.disposed || this.deleted.has(threadId)) return null;
    const recap = this.get(threadId);
    if (!recap || recap.revision === null) return null;
    const thread = await this.deps.sdk().threads.get({ threadId });
    if (this.disposed || this.deleted.has(threadId)) return null;
    // A turn-start event may have invalidated the stored recap during the read.
    return readable(thread) &&
      revisionOf(thread) === recap.revision &&
      this.get(threadId)?.revision === recap.revision
      ? recap
      : null;
  }
  onActive(threadId: string): void {
    const timer = this.timers.get(threadId);
    if (timer) clearTimeout(timer);
    this.timers.delete(threadId);
    this.running.get(threadId)?.abort();
    if (!this.disposed)
      this.deps.db
        .prepare("UPDATE ws_recap SET revision=NULL WHERE thread_id=?")
        .run(threadId);
  }
  onIdle(threadId: string): void {
    if (this.disposed || this.deleted.has(threadId)) return;
    const timer = this.timers.get(threadId);
    if (timer) clearTimeout(timer);
    this.timers.set(
      threadId,
      setTimeout(() => {
        this.timers.delete(threadId);
        void this.generate(threadId);
      }, this.deps.prefs().quietSeconds * 1000),
    );
  }
  generating(threadId: string): boolean {
    return this.running.has(threadId);
  }

  /** Transcript reads occur only during generation; writes require the same idle revision. */
  async generate(
    threadId: string,
    options: { onDemand?: boolean } = {},
  ): Promise<Recap | null> {
    if (this.disposed || this.deleted.has(threadId)) return null;
    const timer = this.timers.get(threadId);
    if (timer) clearTimeout(timer);
    this.timers.delete(threadId);
    this.running.get(threadId)?.abort();
    const controller = new AbortController();
    this.running.set(threadId, controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(120_000),
    ]);
    const ownsRun = () =>
      !this.disposed &&
      !this.deleted.has(threadId) &&
      !signal.aborted &&
      this.running.get(threadId) === controller;
    this.deps.onChange();
    let traceId: string | null = null;
    try {
      const thread = await this.deps.sdk().threads.get({ threadId, signal });
      if (!ownsRun() || !readable(thread)) return null;
      const revision = revisionOf(thread);
      const rows: unknown[] = [];
      let before: { id: string; seq: number } | undefined;
      let complete = false;
      for (let page = 0; page < 60; page++) {
        const response = await this.deps
          .sdk()
          .threads.timeline({
            threadId,
            includeNestedRows: "true",
            ...(before
              ? {
                  beforeAnchorId: before.id,
                  beforeAnchorSeq: String(before.seq),
                }
              : {}),
            signal,
          });
        if (!ownsRun()) return null;
        rows.unshift(...response.rows);
        if (!response.timelinePage.hasOlderRows) {
          complete = true;
          break;
        }
        const cursor = response.timelinePage.olderCursor;
        if (
          !cursor ||
          (cursor.anchorId === before?.id && cursor.anchorSeq === before.seq)
        )
          break;
        before = { id: cursor.anchorId, seq: cursor.anchorSeq };
      }
      if (!complete)
        throw new Error(
          "Recap transcript scan was incomplete; no recap saved.",
        );
      const turns = countUserTurns(rows, threadId);
      if (turns < (options.onDemand ? 1 : this.deps.prefs().minTurns))
        return null;
      const transcript = buildConversationText(
        rows,
        MAX_RECAP_TRANSCRIPT_CHARS,
        0,
        threadId,
      );
      if (!transcript) return null;
      const model = await this.deps.model();
      const facts = this.deps.triage(threadId) ?? {
        state: "in_progress",
        needsYou: null,
      };
      const input: RecapInput = {
        transcript,
        previousRecap: this.get(threadId)?.summary ?? null,
        state: facts.state,
        needsYou: facts.needsYou,
      };
      if (!ownsRun()) return null;
      const result = await this.deps.inference.run("recap", input, {
        model,
        signal,
        label: `Recap ${threadId}`,
        links: [{ kind: "thread", ref: threadId }],
      });
      traceId = result.traceId;
      if (!ownsRun()) return null;
      const current = await this.deps.sdk().threads.get({ threadId, signal });
      if (
        !ownsRun() ||
        !readable(current) ||
        revisionOf(current) !== revision
      ) {
        this.deps.inference.annotate(traceId, {
          stored: false,
          reason: "Thread changed during generation",
        });
        return null;
      }
      const summary = parseRecap(result.value.summary).summary;
      if (!summary) return null;
      const recap: Recap = {
        threadId,
        summary,
        generatedAt: Date.now(),
        turns,
        model,
        revision,
      };
      this.deps.db
        .prepare(
          `INSERT INTO ws_recap (thread_id,summary,generated_at,turns,model,revision) VALUES (?,?,?,?,?,?)
        ON CONFLICT(thread_id) DO UPDATE SET summary=excluded.summary,generated_at=excluded.generated_at,turns=excluded.turns,model=excluded.model,revision=excluded.revision`,
        )
        .run(threadId, summary, recap.generatedAt, turns, model, revision);
      this.deps.inference.annotate(traceId, { stored: true, revision });
      this.deps.onChange();
      return recap;
    } catch (error) {
      if (ownsRun())
        this.deps.log(`Recap failed for ${threadId}: ${String(error)}`);
      return null;
    } finally {
      if (traceId && !ownsRun())
        this.deps.inference.annotate(traceId, {
          stored: false,
          reason: "Generation cancelled or superseded",
        });
      if (this.running.get(threadId) === controller) {
        this.running.delete(threadId);
        if (!this.disposed) this.deps.onChange();
      }
    }
  }
  disposeThread(threadId: string): void {
    this.deleted.add(threadId);
    this.onActive(threadId);
    if (!this.disposed)
      this.deps.db
        .prepare("DELETE FROM ws_recap WHERE thread_id=?")
        .run(threadId);
  }
}
