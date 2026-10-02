import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isCurrent } from "../domain/analysis.ts";
import type { Analyzer } from "./analyzer.ts";
import type { AgentRecaps } from "./recap.ts";
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

/**
 * Archive from the recap card (SPEC §11.7). A thread qualifies when its
 * agent's recap for the latest turn is complete or ready for review, and neither it
 * nor any child or lifecycle dependent has outstanding work. Archiving a
 * review recap is the user's acceptance of its result. Workstreams never
 * archives on its own.
 */
export class RecapArchive {
  constructor(
    private readonly deps: {
      sdk: () => Sdk;
      recaps: AgentRecaps;
      analyzer: Analyzer;
      onChange: () => void;
    },
  ) {}

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

  /** A dependent is finished by its own recap, or else its current analysis. */
  private finished(thread: Thread): boolean {
    const recap = this.deps.recaps.get(thread.id)?.recap;
    if (recap) return recap.state === "complete";
    const analysis = this.deps.analyzer.get(thread.id);
    return isCurrent(analysis, thread) && analysis.state === "done";
  }

  private async eligible(
    thread: Thread,
    threads: Thread[],
    recapId: string,
  ): Promise<boolean> {
    const recap = this.deps.recaps.get(thread.id)?.recap;
    if (
      !recap ||
      recap.id !== recapId ||
      recap.state === "waiting" ||
      thread.archivedAt !== null ||
      thread.visibility === "hidden" ||
      !archiveIdle(thread)
    )
      return false;

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
      // Archiving cascades, so dependents need completion evidence. Hidden
      // workers have none.
      if (
        member.id !== thread.id &&
        (member.visibility === "hidden" || !this.finished(member))
      )
        return false;
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

  async status(threadId: string): Promise<{ recapId: string | null }> {
    const recap = this.deps.recaps.get(threadId)?.recap;
    if (!recap) return { recapId: null };
    try {
      const threads = await this.inventory();
      const thread = threads.find((t) => t.id === threadId);
      return {
        recapId:
          thread && (await this.eligible(thread, threads, recap.id))
            ? recap.id
            : null,
      };
    } catch {
      // Unknown outstanding work hides Archive, not the rest of the card.
      return { recapId: null };
    }
  }

  async archive(threadId: string, recapId: string) {
    const stale = () =>
      new UserError(
        "This thread has outstanding work, or its recap is no longer current.",
      );
    // Two passes: work can start while the first one reads timelines.
    const threads = await this.inventory();
    const thread = threads.find((t) => t.id === threadId);
    if (!thread || !(await this.eligible(thread, threads, recapId)))
      throw stale();
    const fresh = await this.inventory();
    const current = fresh.find((t) => t.id === threadId);
    if (!current || !(await this.eligible(current, fresh, recapId)))
      throw stale();
    const latest = await this.deps.sdk().threads.get({ threadId });
    if (
      latest.archivedAt !== null ||
      latest.status !== "idle" ||
      latest.runtime.displayStatus !== "idle" ||
      latest.latestAttentionAt !== thread.latestAttentionAt ||
      latest.queuedMessageCount > 0 ||
      latest.activeBackgroundAgentCount > 0
    )
      throw stale();
    await this.deps.sdk().threads.archive({ threadId });
    this.deps.onChange();
    return { ok: true as const };
  }
}
