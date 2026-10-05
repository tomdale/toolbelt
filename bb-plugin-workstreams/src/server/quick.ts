/**
 * Quick analysis (SPEC §10.1): a new thread's goal and topic from its first
 * request, while its first turn is still running, so the thread is titled and
 * filed within seconds instead of after a turn that may take an hour. Full
 * analysis of the first finished turn then settles both.
 *
 * Everything here is best effort and apart from the turn it describes:
 *
 * - Nothing waits on it. `onDispatch` runs inside BB's admission checkpoint,
 *   which fails the message if its handler throws or is slow, so it only
 *   decides whether to start the call, and never throws.
 * - A failed or slow call is logged and forgotten; Full analysis covers it.
 * - A thread is tried once per run. Its title is written only while it has
 *   none of its own (the retitle policy re-checks at the write), and its
 *   topic only while it has none (the topic store enforces that).
 * - When the New thread composer already ran Quick analysis on the text that
 *   was sent, its result is applied as is, with no second call.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { clip, type QuickAnalysisOutput } from "../domain/analysis.ts";
import type { Entity } from "../domain/classify.ts";
import type { ModelChoice } from "../domain/prefs.ts";
import type { Database } from "./db.ts";
import type { InventoryThread } from "./inventory.ts";
import type { Inference } from "./model.ts";
import { isUserRequest, openingRequest } from "./requests.ts";
import { readTitleRecord } from "./titles.ts";

type Sdk = BbPluginApi["sdk"];

/** Gives up on a model that hasn't answered; Full analysis covers it. */
export const OPENING_TIMEOUT_MS = 15_000;
/**
 * Calls in flight at once. A thread that finds them busy isn't marked tried,
 * so its next `thread.active` or the next sweep can name it; otherwise its
 * analysis does.
 */
const MAX_IN_FLIGHT = 4;
/** A call's debug label is the request's opening words, as BB shows them. */
const LABEL_MAX = 60;

/** What decides whether a thread can be named from its opening request. */
export type OpeningThread = {
  readonly id: string;
  readonly title: string | null;
  readonly projectId?: string;
  readonly parentThreadId?: string | null;
  readonly visibility: string;
  readonly archivedAt: number | null;
  readonly latestAttentionAt?: number | null;
  readonly updatedAt: number;
};

/** The part of BB's `message.dispatch` context that tells a first message. */
export type OpeningDispatch = {
  readonly thread: OpeningThread;
  readonly attempt: string;
  /** Set on a thread's first message; follow-ups, steers, and retries have none. */
  readonly origin: unknown;
  readonly input: { readonly text: string };
};

export class QuickAnalysis {
  /** Threads tried in this run, however it went: at most one call each. */
  private readonly tried = new Set<string>();
  private inFlight = 0;
  private disposed = false;

  constructor(
    private readonly deps: {
      sdk: () => Sdk;
      db: Database;
      inference: Inference;
      model: () => Promise<ModelChoice>;
      /** Whether Workstreams may write titles (`threads.autoTitle`). */
      enabled: () => boolean;
      /** Whether a finished turn of the thread has been analyzed. */
      analyzed: (threadId: string) => boolean;
      /**
       * Applies the goal as the thread's title, under the retitle policy and
       * the `autoTitle` preference, and records the outcome on the trace.
       */
      apply: (
        threadId: string,
        goal: string,
        revision: number,
        traceId: string | null,
      ) => Promise<void>;
      /** Topics, for a root's first topic. */
      topics?: {
        entities(): Entity[];
        project(projectId: string): Promise<string | null>;
        /** Whether the thread has no topic yet, so a quick one may fill it. */
        open(threadId: string): boolean;
        apply(
          threadId: string,
          answer: Pick<QuickAnalysisOutput, "subjectId" | "proposed">,
          traceId: string | null,
        ): void;
      };
      log: (message: string) => void;
    },
  ) {}

  dispose(): void {
    this.disposed = true;
  }

  /** Lets a deleted thread's id go. */
  forget(threadId: string): void {
    this.tried.delete(threadId);
  }

  /**
   * A message is being admitted. A thread's first one is the earliest its
   * request is known: BB records the request only after admission. Queued
   * messages and retries come back through here, so a thread is tried once.
   */
  onDispatch(ctx: OpeningDispatch, preset?: QuickAnalysisOutput | null): void {
    try {
      if (ctx.attempt !== "start-turn" || ctx.origin === null) return;
      if (preset) this.applyPreset(ctx.thread, preset);
      else this.begin(ctx.thread, ctx.input.text.trim());
    } catch (error) {
      this.deps.log(`Quick analysis failed: ${String(error)}`);
    }
  }

  /** Applies the composer's result for the text that was sent. */
  private applyPreset(thread: OpeningThread, preset: QuickAnalysisOutput) {
    const titled = this.eligible(thread);
    if (!titled && !this.wantsTopic(thread)) return;
    this.tried.add(thread.id);
    const revision = thread.latestAttentionAt ?? thread.updatedAt;
    if (this.wantsTopic(thread))
      this.deps.topics?.apply(thread.id, preset, null);
    if (preset.goal && titled)
      void this.deps
        .apply(thread.id, preset.goal, revision, null)
        .catch((error: unknown) =>
          this.deps.log(
            `Quick title for ${thread.id} failed: ${String(error)}`,
          ),
        );
  }

  /** A root with no topic yet, which Quick analysis may give one. */
  private wantsTopic(thread: OpeningThread): boolean {
    return (
      !this.disposed &&
      !this.deps.analyzed(thread.id) &&
      !thread.parentThreadId &&
      thread.visibility !== "hidden" &&
      thread.archivedAt === null &&
      (this.deps.topics?.open(thread.id) ?? false)
    );
  }

  /**
   * A thread is running without a title. Reads its opening request, which
   * covers a thread whose dispatch this run never saw (the plugin loaded
   * mid-turn, or the hook missed it). Never rejects.
   */
  async onRunning(thread: OpeningThread): Promise<void> {
    try {
      if (!this.eligible(thread) && !this.wantsTopic(thread)) return;
      if (this.tried.has(thread.id)) return;
      const request = await openingRequest(this.deps.sdk(), thread.id);
      if (request) this.begin(thread, request);
    } catch (error) {
      this.deps.log(`Quick analysis for ${thread.id} failed: ${String(error)}`);
    }
  }

  /**
   * Names the running threads that have no title, which the reconciler finds
   * after a reload or a missed event.
   */
  sweep(threads: readonly InventoryThread[]): void {
    for (const candidate of threads) {
      if (
        (candidate.ownTitle !== null &&
          (candidate.parentThreadId !== null ||
            !(this.deps.topics?.open(candidate.id) ?? false))) ||
        candidate.status === "idle" ||
        candidate.status === "error" ||
        !this.available(candidate.id)
      )
        continue;
      void this.deps
        .sdk()
        .threads.get({ threadId: candidate.id })
        .then((thread) => this.onRunning(thread))
        .catch((error: unknown) =>
          this.deps.log(
            `Opening title for ${candidate.id} failed: ${String(error)}`,
          ),
        );
    }
  }

  /** Whether the thread may be titled now. Cheap checks first: this runs often. */
  private eligible(thread: OpeningThread): boolean {
    return (
      thread.title === null &&
      thread.visibility !== "hidden" &&
      thread.archivedAt === null &&
      this.available(thread.id)
    );
  }

  /** What Workstreams alone knows about whether a thread may be named now. */
  private available(threadId: string): boolean {
    return (
      !this.disposed &&
      !this.tried.has(threadId) &&
      this.inFlight < MAX_IN_FLIGHT &&
      this.deps.enabled() &&
      // A thread whose turn was analyzed is named by its analysis.
      !this.deps.analyzed(threadId) &&
      !readTitleRecord(this.deps.db, threadId)?.locked
    );
  }

  private begin(thread: OpeningThread, request: string): void {
    if (!isUserRequest(request)) return;
    if (!this.eligible(thread) && !this.wantsTopic(thread)) return;
    if (this.tried.has(thread.id) || this.inFlight >= MAX_IN_FLIGHT) return;
    this.tried.add(thread.id);
    this.inFlight++;
    void this.run(thread, request)
      .catch((error: unknown) =>
        this.deps.log(
          `Quick analysis for ${thread.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        this.inFlight--;
      });
  }

  private async run(thread: OpeningThread, request: string): Promise<void> {
    // Anything that has happened to the thread since is the retitle policy's
    // to weigh against this revision.
    const revision = thread.latestAttentionAt ?? thread.updatedAt;
    // The topic tree and project matter only when there's a topic to choose.
    const topics = this.wantsTopic(thread) ? this.deps.topics : undefined;
    const { value, traceId } = await this.deps.inference.run(
      "quick-analysis",
      {
        request,
        project:
          topics && thread.projectId
            ? await topics.project(thread.projectId)
            : null,
        entities: topics?.entities() ?? [],
      },
      {
        model: await this.deps.model(),
        threadId: thread.id,
        label: clip(request, LABEL_MAX),
        links: [{ kind: "thread", ref: thread.id }],
        timeoutMs: OPENING_TIMEOUT_MS,
      },
    );
    if (this.disposed) return;
    if (topics && this.wantsTopic(thread))
      topics.apply(thread.id, value, traceId);
    if (!value.goal) {
      this.deps.inference.annotate(traceId, {
        title: "not applied: the request doesn't say what the work is",
      });
      return;
    }
    if (this.eligible(thread) || this.tried.has(thread.id))
      await this.deps.apply(thread.id, value.goal, revision, traceId);
  }
}
