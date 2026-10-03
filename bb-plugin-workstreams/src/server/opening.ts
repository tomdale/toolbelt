/**
 * Names a thread from its opening request while its first turn is still
 * running (SPEC §10.1), so a thread has a title as soon as it has a request
 * instead of after the turn that may take an hour.
 *
 * One small call sees the opening request and nothing else, and its goal is
 * applied as a provisional title: the analysis of the first finished turn
 * keeps, refines, or replaces it. Everything here is best effort and apart
 * from the turn it names:
 *
 * - Nothing waits on it. `onDispatch` runs inside BB's admission checkpoint,
 *   which fails the message if its handler throws or is slow, so it only
 *   decides whether to start the call, and never throws.
 * - A failed or slow call is logged and forgotten; the thread keeps BB's
 *   placeholder until its first analysis names it.
 * - A thread is tried once per run, and only while it has no title of its
 *   own. A title that appears first, from BB's generator, the user, or an
 *   agent, is never replaced here (the retitle policy re-checks at the write).
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { clip } from "../domain/analysis.ts";
import type { ModelChoice } from "../domain/prefs.ts";
import type { Database } from "./db.ts";
import type { InventoryThread } from "./inventory.ts";
import type { Inference } from "./model.ts";
import { isUserRequest, openingRequest } from "./requests.ts";
import { readTitleRecord } from "./titles.ts";

type Sdk = BbPluginApi["sdk"];

/** Gives up on a model that hasn't answered; the thread's analysis names it. */
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

export class OpeningTitles {
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
  onDispatch(ctx: OpeningDispatch): void {
    try {
      if (ctx.attempt !== "start-turn" || ctx.origin === null) return;
      this.begin(ctx.thread, ctx.input.text.trim());
    } catch (error) {
      this.deps.log(`Opening title failed: ${String(error)}`);
    }
  }

  /**
   * A thread is running without a title. Reads its opening request, which
   * covers a thread whose dispatch this run never saw (the plugin loaded
   * mid-turn, or the hook missed it). Never rejects.
   */
  async onRunning(thread: OpeningThread): Promise<void> {
    try {
      if (!this.eligible(thread)) return;
      const request = await openingRequest(this.deps.sdk(), thread.id);
      if (request) this.begin(thread, request);
    } catch (error) {
      this.deps.log(`Opening title for ${thread.id} failed: ${String(error)}`);
    }
  }

  /**
   * Names the running threads that have no title, which the reconciler finds
   * after a reload or a missed event.
   */
  sweep(threads: readonly InventoryThread[]): void {
    for (const candidate of threads) {
      if (
        candidate.ownTitle !== null ||
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

  /** Cheap checks first: this runs for every turn of every thread. */
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
    if (!isUserRequest(request) || !this.eligible(thread)) return;
    this.tried.add(thread.id);
    this.inFlight++;
    void this.run(thread, request)
      .catch((error: unknown) =>
        this.deps.log(
          `Opening title for ${thread.id} failed: ${error instanceof Error ? error.message : String(error)}`,
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
    const { value, traceId } = await this.deps.inference.run(
      "opening-goal",
      { request },
      {
        model: await this.deps.model(),
        threadId: thread.id,
        label: clip(request, LABEL_MAX),
        links: [{ kind: "thread", ref: thread.id }],
        timeoutMs: OPENING_TIMEOUT_MS,
      },
    );
    if (this.disposed) return;
    if (!value.goal) {
      this.deps.inference.annotate(traceId, {
        title: "not applied: the request doesn't say what the work is",
      });
      return;
    }
    await this.deps.apply(thread.id, value.goal, revision, traceId);
  }
}
