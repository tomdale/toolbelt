/**
 * Per-thread analysis queue (SPEC §8, §10). A thread is analyzed once per
 * completed turn: `thread.idle` schedules it after a short debounce, a new
 * turn cancels the pending run, and at most four calls are in flight. Results
 * are keyed to the thread's revision, so a result from an older turn renders
 * as pending rather than current.
 *
 * Analysis only adds evidence. It never moves, renames, or files a thread
 * (SPEC I3); a suggested title reaches BB only through `onResult` and the
 * retitle policy (SPEC §10).
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AnalysisInput, ThreadAnalysis } from "../domain/analysis.ts";
import type { ModelChoice } from "../domain/prefs.ts";
import type { Database } from "./db.ts";
import { displayTitle, type InventoryThread } from "./inventory.ts";
import { modelLabel, type Inference } from "./model.ts";

type Sdk = BbPluginApi["sdk"];

export const DEBOUNCE_MS = 5_000;
const CONCURRENCY = 4;
/** First retry after a failed call; doubles per failure at the same revision. */
const RETRY_AFTER_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const SYSTEM_PREFIX = "[bb system]";

/** The stored result plus a drift target resolved to a section id. */
export type StoredAnalysis = ThreadAnalysis & {
  readonly driftSectionId: string | null;
  /** The debug trace of the call that produced it (SPEC §11.6). */
  readonly traceId?: string | null;
};

type InputPart = { type: string; text?: string };
function inputText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return (input as InputPart[])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}
function readResult(json: string): StoredAnalysis | undefined {
  try {
    return JSON.parse(json) as StoredAnalysis;
  } catch {
    return undefined;
  }
}

const isUserRequest = (text: string) =>
  text.length > 0 && !text.startsWith(SYSTEM_PREFIX);

export class Analyzer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly waiting: string[] = [];
  /** In-flight runs per thread; a manual run can overlap a queued one. */
  private readonly running = new Map<string, number>();
  private inFlight = 0;
  /** Threads whose turn completed again while a run for them was in flight. */
  private readonly rerun = new Set<string>();
  private readonly failures = new Map<
    string,
    { revision: number; count: number; at: number }
  >();
  /** Deleted threads, so a run that was in flight doesn't write them back. */
  private readonly forgotten = new Set<string>();
  /** `lastAssistantText` from `thread.idle`, keyed by the turn it ended. */
  private readonly lastText = new Map<
    string,
    { revision: number; text: string | null }
  >();
  private disposed = false;
  lastError: string | null = null;

  constructor(
    private readonly deps: {
      sdk: () => Sdk;
      db: Database;
      inference: Inference;
      model: () => Promise<ModelChoice>;
      /** Incremental evidence is optional; failure leaves triage available. */
      onChange: () => void;
      /** A new result was stored for the thread's current turn. */
      onResult?: (threadId: string, result: StoredAnalysis) => void;
      log: (message: string) => void;
      info?: (message: string) => void;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.waiting.length = 0;
  }

  /**
   * Stored results for visible, non-archived threads. Archived threads keep
   * theirs available for subject lookup but aren't sent to clients.
   */
  all(): Record<string, StoredAnalysis> {
    const out: Record<string, StoredAnalysis> = {};
    for (const row of this.deps.db
      .prepare(
        `SELECT a.thread_id, a.result FROM ws_analysis a
         JOIN ws_seen_thread t ON t.thread_id = a.thread_id`,
      )
      .all() as { thread_id: string; result: string }[]) {
      const parsed = readResult(row.result);
      if (parsed) out[row.thread_id] = parsed;
    }
    return out;
  }

  /** Subjects for any threads, archived ones included. */
  subjectsOf(threadIds: readonly string[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    const read = this.deps.db.prepare(
      "SELECT result FROM ws_analysis WHERE thread_id = ?",
    );
    for (const id of threadIds) {
      const row = read.get(id) as { result: string } | undefined;
      out.set(id, row ? (readResult(row.result)?.subject ?? null) : null);
    }
    return out;
  }

  get(threadId: string): StoredAnalysis | undefined {
    const row = this.deps.db
      .prepare("SELECT result FROM ws_analysis WHERE thread_id = ?")
      .get(threadId) as { result: string } | undefined;
    return row ? readResult(row.result) : undefined;
  }

  /** Schedules analysis after a turn completes. */
  onIdle(
    thread: { id: string; latestAttentionAt: number },
    lastAssistantText: string | null,
  ): void {
    const threadId = thread.id;
    this.lastText.set(threadId, {
      revision: thread.latestAttentionAt,
      text: lastAssistantText,
    });
    this.schedule(threadId, DEBOUNCE_MS);
  }

  /** A new turn started: whatever was scheduled would describe the old one. */
  onActive(threadId: string): void {
    const timer = this.timers.get(threadId);
    if (timer) clearTimeout(timer);
    this.timers.delete(threadId);
    this.lastText.delete(threadId);
  }

  forget(threadId: string): void {
    this.onActive(threadId);
    this.forgotten.add(threadId);
    this.rerun.delete(threadId);
    this.failures.delete(threadId);
    this.deps.db
      .prepare("DELETE FROM ws_analysis WHERE thread_id = ?")
      .run(threadId);
  }

  /**
   * Queues every idle thread whose revision is newer than its stored result,
   * which covers turns that finished while the plugin was offline.
   */
  catchUp(threads: readonly InventoryThread[]): number {
    const stored = new Map(
      (
        this.deps.db
          .prepare("SELECT thread_id, revision FROM ws_analysis")
          .all() as { thread_id: string; revision: number }[]
      ).map((row) => [row.thread_id, row.revision]),
    );
    const now = this.now();
    let queued = 0;
    for (const thread of threads) {
      if (thread.status !== "idle") continue;
      if ((stored.get(thread.id) ?? -1) >= thread.latestAttentionAt) continue;
      const failed = this.failures.get(thread.id);
      if (
        failed &&
        failed.revision === thread.latestAttentionAt &&
        (failed.count >= MAX_ATTEMPTS ||
          now - failed.at < RETRY_AFTER_MS * 2 ** (failed.count - 1))
      )
        continue;
      if (this.timers.has(thread.id) || this.running.has(thread.id)) continue;
      if (this.waiting.includes(thread.id)) continue;
      this.waiting.push(thread.id);
      queued++;
    }
    this.pump();
    return queued;
  }

  /** Analyzes one thread now, regardless of its stored revision. */
  async analyzeNow(threadId: string): Promise<StoredAnalysis | null> {
    return this.run(threadId, true);
  }

  private schedule(threadId: string, delay: number): void {
    if (this.disposed) return;
    const existing = this.timers.get(threadId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      threadId,
      setTimeout(() => {
        this.timers.delete(threadId);
        if (!this.waiting.includes(threadId)) this.waiting.unshift(threadId);
        this.pump();
      }, delay),
    );
  }

  private pump(): void {
    while (
      !this.disposed &&
      this.inFlight < CONCURRENCY &&
      this.waiting.length > 0
    ) {
      const threadId = this.waiting.shift()!;
      // Run again once the in-flight run finishes; it read the older turn.
      if (this.running.has(threadId)) {
        this.rerun.add(threadId);
        continue;
      }
      void this.run(threadId, false).finally(() => {
        if (this.rerun.delete(threadId) && !this.waiting.includes(threadId))
          this.waiting.unshift(threadId);
        this.pump();
      });
    }
  }

  private async run(
    threadId: string,
    force: boolean,
  ): Promise<StoredAnalysis | null> {
    this.running.set(threadId, (this.running.get(threadId) ?? 0) + 1);
    this.inFlight++;
    let revision = -1;
    try {
      const sdk = this.deps.sdk();
      const thread = await sdk.threads.get({ threadId });
      if (
        thread.archivedAt !== null ||
        thread.visibility === "hidden" ||
        (!force && thread.status !== "idle")
      )
        return null;
      revision = thread.latestAttentionAt ?? thread.updatedAt;
      const previous = this.get(threadId);
      if (!force && previous && previous.revision >= revision) return previous;

      const started = this.now();
      if (this.disposed || this.forgotten.has(threadId)) return null;
      const input = await this.input(thread);
      const model = await this.deps.model();
      const asked = this.now();
      const { value: output, traceId } = await this.deps.inference.run(
        "analysis",
        input.prompt,
        {
          model,
          threadId,
          label: input.prompt.title,
          links: [{ kind: "thread", ref: threadId }],
        },
      );
      this.deps.info?.(
        `Analyzed ${threadId}: context ${asked - started} ms, model ${this.now() - asked} ms`,
      );
      const driftSectionId =
        output.drift?.workstream != null
          ? (input.sectionByName.get(output.drift.workstream.toLowerCase()) ??
            null)
          : null;
      const result: StoredAnalysis = {
        ...output,
        driftSectionId,
        revision,
        at: this.now(),
        model: modelLabel(model),
        traceId,
      };
      if (this.disposed || this.forgotten.has(threadId)) return null;
      // Never let a slower run for an older turn replace a newer result.
      const stored = this.deps.db
        .prepare(
          `INSERT INTO ws_analysis (thread_id, revision, at, result) VALUES (?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision, at = excluded.at, result = excluded.result
           WHERE excluded.revision >= ws_analysis.revision`,
        )
        .run(threadId, revision, result.at, JSON.stringify(result));
      this.deps.inference.annotate(
        traceId,
        stored.changes > 0
          ? {
              storedForRevision: revision,
              driftSectionId,
              driftTarget: driftSectionId
                ? (input.sectionNameById.get(driftSectionId) ?? null)
                : (output.drift?.newName ?? null),
            }
          : { stored: "no: a newer turn's analysis was already stored" },
      );
      this.failures.delete(threadId);
      if ((this.lastText.get(threadId)?.revision ?? Infinity) <= revision)
        this.lastText.delete(threadId);
      this.lastError = null;
      this.deps.onChange();
      this.deps.onResult?.(threadId, result);
      return result;
    } catch (error) {
      const previous = this.failures.get(threadId);
      this.failures.set(threadId, {
        revision,
        count: previous?.revision === revision ? previous.count + 1 : 1,
        at: this.now(),
      });
      this.lastError = error instanceof Error ? error.message : String(error);
      this.deps.log(`Analysis failed for ${threadId}: ${this.lastError}`);
      if (force) throw error;
      return null;
    } finally {
      this.inFlight--;
      const left = (this.running.get(threadId) ?? 1) - 1;
      if (left > 0) this.running.set(threadId, left);
      else this.running.delete(threadId);
    }
  }

  /** Bounded model input for one thread; the BB project name is never included. */
  private async input(
    thread: Awaited<ReturnType<Sdk["threads"]["get"]>>,
  ): Promise<{
    prompt: AnalysisInput;
    sectionByName: Map<string, string>;
    sectionNameById: Map<string, string>;
  }> {
    const sdk = this.deps.sdk();
    const [history, first] = await Promise.all([
      sdk.threads.promptHistory({ threadId: thread.id, limit: "6" }),
      sdk.threads.events.list({
        threadId: thread.id,
        types: ["client/turn/requested"],
        order: "asc",
        limit: "4",
      }),
    ]);
    const recent = history
      .map((prompt) => inputText(prompt.input))
      .filter(isUserRequest)
      .slice(0, 2)
      .reverse();
    const opening =
      first
        .map((event) =>
          inputText((event.data as { input?: unknown } | null)?.input),
        )
        .find(isUserRequest) ?? "";
    const requests = [
      ...(opening && !recent.includes(opening)
        ? [{ text: opening, initial: true }]
        : []),
      ...recent.map((text) => ({ text, initial: false })),
    ];
    // The idle event's text describes its own turn only; otherwise read the
    // latest output.
    const cached = this.lastText.get(thread.id);
    let lastAssistantText =
      cached && cached.revision === thread.latestAttentionAt
        ? cached.text
        : null;
    if (lastAssistantText === null)
      lastAssistantText = (await sdk.threads.output({ threadId: thread.id }))
        .output;

    const { sectionId, isTask } = this.placement(thread.id);
    const sections = this.deps.db
      .prepare("SELECT section_id, name FROM ws_seen_section")
      .all() as { section_id: string; name: string }[];
    const sectionByName = new Map(
      sections.map((s) => [s.name.toLowerCase(), s.section_id]),
    );
    const own = sections.find((s) => s.section_id === sectionId);
    const record = own
      ? (this.deps.db
          .prepare("SELECT description FROM ws_workstream WHERE section_id = ?")
          .get(own.section_id) as { description: string | null } | undefined)
      : undefined;
    return {
      sectionByName,
      sectionNameById: new Map(sections.map((s) => [s.section_id, s.name])),
      prompt: {
        title: displayTitle(thread),
        untitled: !thread.title,
        workstream: own
          ? {
              name: own.name,
              description: record?.description ?? null,
              subjects: this.subjects(own.section_id, thread.id),
            }
          : null,
        otherWorkstreams: isTask
          ? sections
              .filter((s) => s.section_id !== sectionId)
              .map((s) => s.name)
          : null,
        requests,
        lastAssistantText,
      },
    };
  }

  /**
   * The thread's workstream is its root's section (SPEC I2), walked through
   * the reconciler's snapshot of parent links.
   */
  private placement(threadId: string): {
    sectionId: string | null;
    isTask: boolean;
  } {
    const lookup = this.deps.db.prepare(
      "SELECT section_id, parent_thread_id FROM ws_seen_thread WHERE thread_id = ?",
    );
    let current = lookup.get(threadId) as
      | { section_id: string | null; parent_thread_id: string | null }
      | undefined;
    if (!current) return { sectionId: null, isTask: true };
    const isTask =
      current.parent_thread_id === null ||
      lookup.get(current.parent_thread_id) === undefined;
    const seen = new Set([threadId]);
    while (current.parent_thread_id && !seen.has(current.parent_thread_id)) {
      seen.add(current.parent_thread_id);
      const parent = lookup.get(current.parent_thread_id) as
        typeof current | undefined;
      if (!parent) break;
      current = parent;
    }
    return { sectionId: current.section_id, isTask };
  }

  /** Subjects other roots in the workstream already use, most common first. */
  private subjects(sectionId: string, exclude: string): string[] {
    const counts = new Map<string, number>();
    for (const row of this.deps.db
      .prepare(
        `SELECT a.result FROM ws_analysis a JOIN ws_seen_thread t ON t.thread_id = a.thread_id
         WHERE t.section_id = ? AND t.parent_thread_id IS NULL AND a.thread_id != ?`,
      )
      .all(sectionId, exclude) as { result: string }[]) {
      const subject = (JSON.parse(row.result) as StoredAnalysis).subject;
      if (subject) counts.set(subject, (counts.get(subject) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([subject]) => subject);
  }
}
