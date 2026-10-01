import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isCurrent } from "../domain/analysis.ts";
import type { Analyzer } from "./analyzer.ts";
import type { Database } from "./db.ts";
import { UserError } from "./service.ts";

type Sdk = BbPluginApi["sdk"];
type Thread = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];

export function archiveIdle(thread: Thread): boolean {
  return (
    thread.status === "idle" &&
    thread.runtime.displayStatus === "idle" &&
    thread.queuedWork === "none" &&
    !thread.hasPendingInteraction &&
    Object.values(thread.activity).every((count) => count === 0)
  );
}

export class ArchiveSuggestions {
  constructor(
    private readonly deps: {
      sdk: () => Sdk;
      db: Database;
      analyzer: Analyzer;
      onChange: () => void;
    },
  ) {}

  private dismissed(threadId: string, revision: number): boolean {
    const row = this.deps.db
      .prepare("SELECT revision FROM ws_archive_dismissed WHERE thread_id = ?")
      .get(threadId) as { revision: number } | undefined;
    return row !== undefined && row.revision >= revision;
  }

  private async inventory(): Promise<Thread[]> {
    const threads: Thread[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.deps.sdk().threads.list({
        archived: false,
        includeHidden: true,
        limit: 100,
        offset,
      });
      threads.push(...page);
      if (page.length < 100) return threads;
    }
  }

  private async eligible(thread: Thread, threads: Thread[]): Promise<boolean> {
    const analysis = this.deps.analyzer.get(thread.id);
    if (
      thread.archivedAt !== null ||
      thread.visibility === "hidden" ||
      !archiveIdle(thread) ||
      !isCurrent(analysis, thread) ||
      (analysis.state !== "done" && analysis.state !== "review") ||
      this.dismissed(thread.id, analysis.revision)
    )
      return false;

    // Archiving a review-state root is the user's acceptance of its result.
    // Cascading dependents still require fresh completion evidence.
    const family = new Set([thread.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of threads) {
        if (
          !family.has(child.id) &&
          ((child.parentThreadId && family.has(child.parentThreadId)) ||
            (child.lifecycleOwnerThreadId &&
              family.has(child.lifecycleOwnerThreadId)))
        ) {
          family.add(child.id);
          changed = true;
        }
      }
    }
    for (const member of threads.filter((t) => family.has(t.id))) {
      if (!archiveIdle(member)) return false;
      if (member.id !== thread.id) {
        // Hidden workers are not classified; lack of completion evidence must
        // never allow a cascading archive suggestion.
        if (member.visibility === "hidden") return false;
        const result = this.deps.analyzer.get(member.id);
        if (!isCurrent(result, member) || result.state !== "done") return false;
      }
      const timeline = await this.deps
        .sdk()
        .threads.timeline({ threadId: member.id, summaryOnly: "true" });
      if (
        (timeline.goal && timeline.goal.status !== "complete") ||
        timeline.pendingTodos?.items.some((item) => item.status !== "completed")
      )
        return false;
    }
    return true;
  }

  async status(threadId: string): Promise<{ revision: number | null }> {
    const analysis = this.deps.analyzer.get(threadId);
    if (
      !analysis ||
      (analysis.state !== "done" && analysis.state !== "review") ||
      this.dismissed(threadId, analysis.revision)
    )
      return { revision: null };
    try {
      const threads = await this.inventory();
      const thread = threads.find((t) => t.id === threadId);
      return {
        revision:
          thread && (await this.eligible(thread, threads))
            ? analysis.revision
            : null,
      };
    } catch {
      // Unknown outstanding work suppresses the card, not the rest of the UI.
      return { revision: null };
    }
  }

  async decide(
    threadId: string,
    revision: number,
    action: "archive" | "dismiss",
  ) {
    const analysis = this.deps.analyzer.get(threadId);
    if (!analysis || analysis.revision !== revision)
      throw new UserError("This archive suggestion is no longer current.");
    if (action === "dismiss") {
      this.deps.db
        .prepare(
          `INSERT INTO ws_archive_dismissed (thread_id, revision) VALUES (?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET revision = MAX(revision, excluded.revision)`,
        )
        .run(threadId, revision);
    } else {
      const threads = await this.inventory();
      const thread = threads.find((t) => t.id === threadId);
      if (!thread || !(await this.eligible(thread, threads)))
        throw new UserError(
          "This thread still has work or the archive suggestion is no longer current.",
        );
      const fresh = await this.inventory();
      const current = fresh.find((t) => t.id === threadId);
      if (!current || !(await this.eligible(current, fresh)))
        throw new UserError("This archive suggestion is no longer current.");
      const latest = await this.deps.sdk().threads.get({ threadId });
      if (
        latest.archivedAt !== null ||
        latest.visibility === "hidden" ||
        latest.status !== "idle" ||
        latest.runtime.displayStatus !== "idle" ||
        latest.latestAttentionAt !== thread.latestAttentionAt ||
        latest.queuedMessageCount > 0 ||
        latest.activeBackgroundAgentCount > 0
      )
        throw new UserError("This archive suggestion is no longer current.");
      await this.deps.sdk().threads.archive({ threadId });
    }
    this.deps.onChange();
    return { ok: true as const };
  }

  forget(threadId: string) {
    this.deps.db
      .prepare("DELETE FROM ws_archive_dismissed WHERE thread_id = ?")
      .run(threadId);
  }
}
